import type { Node as SyntaxNode } from "web-tree-sitter";
import type { FunctionInfo, ReactModel, StateBinding } from "../types";
import { nodeKey, normalizeExpressionText, sameNode, walk } from "./walk";

const REACT_HOOKS = new Set([
  "useState",
  "useEffect",
  "useLayoutEffect",
  "useMemo",
  "useCallback",
  "useContext",
  "useReducer",
  "useRef",
  "useImperativeHandle",
  "useBinding",
]);

const REACT_MEMBERS = new Set([...REACT_HOOKS, "createElement", "createContext", "memo", "joinBindings"]);
const STABLE_CUSTOM_HOOK_RETURN = /^(?:set[A-Z0-9_]|dispatch$|send$|emit$|fire$)/i;
const INSTANCE_FACTORY_MEMBERS = new Set([
  "Clone",
  "FindFirstAncestor",
  "FindFirstAncestorOfClass",
  "FindFirstAncestorWhichIsA",
  "FindFirstChild",
  "FindFirstChildOfClass",
  "FindFirstChildWhichIsA",
  "GetButton",
  "GetMouse",
  "GetService",
  "WaitForChild",
]);
const STABLE_ENGINE_FACTORY_MEMBERS = new Set(["GetMouse", "GetService"]);

function identifiersFromParameters(node: SyntaxNode | null): string[] {
  if (!node) return [];
  const result: string[] = [];
  for (const child of walk(node)) {
    if (child.type !== "identifier") continue;
    const parentType = child.parent?.type;
    if (parentType === "parameters" || parentType === "parameter" || parentType === "typed_identifier") {
      result.push(child.text);
    }
  }
  return [...new Set(result)];
}

function getFunctionName(node: SyntaxNode): string | null {
  if (node.type === "function_declaration") {
    return node.childForFieldName("name")?.text ?? null;
  }

  if (node.type !== "function_definition") return null;
  let owner = node.parent;
  while (owner && owner.type !== "variable_declaration") {
    if (owner.type === "function_definition" || owner.type === "function_declaration") return null;
    owner = owner.parent;
  }
  if (!owner) return null;

  const prefix = owner.text.slice(0, Math.max(0, node.startIndex - owner.startIndex));
  const directMatch = prefix.match(/\blocal\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*$/s);
  if (directMatch) return directMatch[1];

  const wrappedMatch = prefix.match(/\blocal\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[A-Za-z_][A-Za-z0-9_.]*\s*\(\s*$/s);
  return wrappedMatch?.[1] ?? null;
}

function requireTargetContainsModule(target: string, moduleName: string): boolean {
  return (target.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
    .some((token) => token.toLowerCase() === moduleName.toLowerCase());
}

function resolvePath(
  rawPath: string,
  aliases: Map<string, string>,
  reactNamespaces: Set<string>,
  reactRobloxNamespaces: Set<string>,
): string {
  const normalized = normalizeExpressionText(rawPath);
  const direct = aliases.get(normalized);
  if (direct) return direct;

  const namespaceMatch = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)\.(.+)$/);
  if (namespaceMatch && reactNamespaces.has(namespaceMatch[1])) return `React.${namespaceMatch[2]}`;
  if (namespaceMatch && reactRobloxNamespaces.has(namespaceMatch[1])) return `ReactRoblox.${namespaceMatch[2]}`;
  return normalized;
}

function directCalls(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  const pending = [...node.namedChildren];
  while (pending.length > 0) {
    const child = pending.pop()!;
    if (child.type === "function_definition" || child.type === "function_declaration") continue;
    if (child.type === "function_call") result.push(child);
    pending.push(...child.namedChildren);
  }
  return result;
}

function hasDirectCreateElementCall(
  node: SyntaxNode,
  aliases: Map<string, string>,
  reactNamespaces: Set<string>,
  reactRobloxNamespaces: Set<string>,
): boolean {
  return directCalls(node).some((call) => {
    const name = call.childForFieldName("name")?.text ?? "";
    const path = resolvePath(name, aliases, reactNamespaces, reactRobloxNamespaces);
    return path === "React.createElement" || path === "ReactRoblox.createPortal";
  });
}

function hasDirectHookCall(
  node: SyntaxNode,
  aliases: Map<string, string>,
  reactNamespaces: Set<string>,
  reactRobloxNamespaces: Set<string>,
): boolean {
  return directCalls(node).some((call) => {
    const name = call.childForFieldName("name")?.text ?? "";
    const path = resolvePath(name, aliases, reactNamespaces, reactRobloxNamespaces);
    const final = path.split(/[.:]/).at(-1) ?? "";
    return /^use[A-Z0-9_]/.test(final);
  });
}

function isMemoWrappedFunction(
  node: SyntaxNode,
  aliases: Map<string, string>,
  reactNamespaces: Set<string>,
): boolean {
  const argumentsNode = node.parent;
  const call = argumentsNode?.type === "arguments" ? argumentsNode.parent : null;
  if (!call || call.type !== "function_call") return false;
  const name = call.childForFieldName("name")?.text ?? "";
  return resolvePath(name, aliases, reactNamespaces, new Set()) === "React.memo";
}

function isModuleReturnedFunction(node: SyntaxNode): boolean {
  const expressionList = node.parent;
  const returnStatement = expressionList?.type === "expression_list" ? expressionList.parent : null;
  if (!returnStatement || returnStatement.type !== "return_statement") return false;
  let current = returnStatement.parent;
  while (current) {
    if (current.type === "function_definition" || current.type === "function_declaration") return false;
    current = current.parent;
  }
  return true;
}

function collectDirectLocals(body: SyntaxNode | null): Set<string> {
  const locals = new Set<string>();
  if (!body) return locals;

  for (const child of body.namedChildren) {
    if (child.type === "variable_declaration") {
      const beforeEquals = child.text.split("=")[0] ?? "";
      const localPart = beforeEquals.replace(/^\s*local\s+/, "");
      for (const piece of localPart.split(",")) {
        const match = piece.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/);
        if (match) locals.add(match[1]);
      }
    } else if (child.type === "function_declaration") {
      const name = child.childForFieldName("name")?.text;
      if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) locals.add(name);
    }
  }

  return locals;
}

function nearestFunctionInfo(node: SyntaxNode, functionByNode: Map<string, FunctionInfo>): FunctionInfo | null {
  let current = node.parent;
  while (current) {
    const info = functionByNode.get(nodeKey(current));
    if (info) return info;
    current = current.parent;
  }
  return null;
}

function declarationCall(node: SyntaxNode): SyntaxNode | null {
  if (node.type !== "variable_declaration") return null;
  for (const child of walk(node)) {
    if (child.type === "function_call") return child;
    if (!sameNode(child, node) && (child.type === "function_definition" || child.type === "function_declaration")) return null;
  }
  return null;
}

function declarationNames(node: SyntaxNode): string[] {
  if (node.type !== "variable_declaration") return [];
  const assignment = node.namedChildren.find((child) => child.type === "assignment_statement");
  const variableList = assignment?.namedChildren.find((child) => child.type === "variable_list");
  return variableList?.namedChildren.filter((child) => child.type === "identifier").map((child) => child.text) ?? [];
}

function declarationExpressions(node: SyntaxNode): SyntaxNode[] {
  if (node.type !== "variable_declaration") return [];
  const assignment = node.namedChildren.find((child) => child.type === "assignment_statement");
  const expressionList = assignment?.namedChildren.find((child) => child.type === "expression_list");
  return expressionList?.namedChildren ?? [];
}

function isSyntacticallyStableInitializer(node: SyntaxNode | undefined): boolean {
  if (!node) return false;
  return ["nil", "true", "false", "number", "string", "string_content"].includes(node.type)
    || /^(?:nil|true|false|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i.test(node.text.trim());
}


function finalCallMember(path: string): string {
  return path.split(/[.:]/).at(-1) ?? path;
}

function expressionCreatesInstance(
  node: SyntaxNode | undefined,
  aliases: Map<string, string>,
  reactNamespaces: Set<string>,
  reactRobloxNamespaces: Set<string>,
): boolean {
  if (!node) return false;
  const text = node.text.trim();
  if (/^(?:workspace|game|script)(?:\.|:|$)/.test(text)) return true;

  for (const candidate of walk(node)) {
    if (candidate.type !== "function_call") continue;
    const rawPath = candidate.childForFieldName("name")?.text ?? "";
    const path = resolvePath(rawPath, aliases, reactNamespaces, reactRobloxNamespaces);
    if (path === "Instance.new" || INSTANCE_FACTORY_MEMBERS.has(finalCallMember(path))) return true;
  }
  return false;
}

function expressionIsStableEngineObject(
  node: SyntaxNode | undefined,
  aliases: Map<string, string>,
  reactNamespaces: Set<string>,
  reactRobloxNamespaces: Set<string>,
): boolean {
  if (!node) return false;
  const calls = [...walk(node)].filter((candidate) => candidate.type === "function_call");
  if (calls.length !== 1) return false;
  const rawPath = calls[0].childForFieldName("name")?.text ?? "";
  const path = resolvePath(rawPath, aliases, reactNamespaces, reactRobloxNamespaces);
  return STABLE_ENGINE_FACTORY_MEMBERS.has(finalCallMember(path));
}

function memoReturnsInstance(
  callback: SyntaxNode | undefined,
  aliases: Map<string, string>,
  reactNamespaces: Set<string>,
  reactRobloxNamespaces: Set<string>,
): boolean {
  if (!callback || callback.type !== "function_definition") return false;
  for (const candidate of walk(callback)) {
    if (candidate.type !== "return_statement") continue;
    if (expressionCreatesInstance(candidate, aliases, reactNamespaces, reactRobloxNamespaces)) return true;
  }
  return false;
}

function isEmptyDependencyTable(node: SyntaxNode | undefined): boolean {
  return Boolean(node?.type === "table_constructor" && node.namedChildren.every((child) => child.type !== "field"));
}

export function buildReactModel(root: SyntaxNode): ReactModel {
  const reactNamespaces = new Set<string>();
  const reactRobloxNamespaces = new Set<string>();
  const aliases = new Map<string, string>();
  const stateSetters = new Map<string, string>();
  const stateValues = new Map<string, string>();
  const stateBindings: StateBinding[] = [];
  const refVariables = new Set<string>();
  const bindingSetters = new Set<string>();
  const stableVariables = new Set<string>();
  const refVariablesByFunction = new Map<string, Set<string>>();
  const stableVariablesByFunction = new Map<string, Set<string>>();
  const externalMutableVariablesByFunction = new Map<string, Set<string>>();
  const instanceVariablesByFunction = new Map<string, Set<string>>();

  const declarations = [...walk(root)].filter((node) => node.type === "variable_declaration");
  let isReactFile = false;

  for (const declaration of declarations) {
    const text = declaration.text;
    const requireMatch = text.match(/^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\s*\((.*?)\)\s*$/s);
    if (!requireMatch) continue;
    const [, localName, target] = requireMatch;
    if (requireTargetContainsModule(target, "ReactRoblox")) {
      reactRobloxNamespaces.add(localName);
      isReactFile = true;
    } else if (requireTargetContainsModule(target, "React")) {
      reactNamespaces.add(localName);
      isReactFile = true;
    }
  }

  for (const node of walk(root)) {
    if (node.type !== "function_call") continue;
    const rawPath = normalizeExpressionText(node.childForFieldName("name")?.text ?? "");
    const memberMatch = rawPath.match(/^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/);
    if (!memberMatch) continue;
    const [, namespace, member] = memberMatch;
    if (namespace === "React" && REACT_MEMBERS.has(member)) {
      reactNamespaces.add(namespace);
      isReactFile = true;
    } else if (namespace === "ReactRoblox" && ["createRoot", "createPortal"].includes(member)) {
      reactRobloxNamespaces.add(namespace);
      isReactFile = true;
    }
  }

  for (const declaration of declarations) {
    const text = declaration.text;
    const aliasMatch = text.match(/^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*$/s);
    if (!aliasMatch) continue;
    const [, localName, namespace, member] = aliasMatch;
    if (reactNamespaces.has(namespace) && REACT_MEMBERS.has(member)) aliases.set(localName, `React.${member}`);
    if (reactRobloxNamespaces.has(namespace) && ["createRoot", "createPortal"].includes(member)) {
      aliases.set(localName, `ReactRoblox.${member}`);
    }
  }

  const functions: FunctionInfo[] = [];
  const functionByNode = new Map<string, FunctionInfo>();

  for (const node of walk(root)) {
    if (node.type !== "function_declaration" && node.type !== "function_definition") continue;
    const name = getFunctionName(node);
    const body = node.childForFieldName("body");
    const parameters = identifiersFromParameters(node.childForFieldName("parameters"));
    const info: FunctionInfo = {
      node,
      body,
      name,
      parameters,
      isHook: Boolean(isReactFile && name && /^use[A-Z0-9_]/.test(name)),
      isComponent: false,
    };
    functions.push(info);
    functionByNode.set(nodeKey(node), info);
  }

  const functionsBySimpleName = new Map<string, FunctionInfo[]>();
  for (const info of functions) {
    if (!info.name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(info.name)) continue;
    const existing = functionsBySimpleName.get(info.name) ?? [];
    existing.push(info);
    functionsBySimpleName.set(info.name, existing);
  }

  for (const info of functions) {
    if (!isReactFile || !info.body || info.isHook) continue;
    const simplePascalName = Boolean(info.name && /^[A-Z][A-Za-z0-9_]*$/.test(info.name));
    const hasHooks = hasDirectHookCall(info.body, aliases, reactNamespaces, reactRobloxNamespaces);
    const renders = hasDirectCreateElementCall(info.body, aliases, reactNamespaces, reactRobloxNamespaces);
    if (hasHooks || isMemoWrappedFunction(info.node, aliases, reactNamespaces) || (simplePascalName && renders)) {
      info.isComponent = true;
    } else if (!info.name && isModuleReturnedFunction(info.node) && hasHooks) {
      info.isComponent = true;
    }
  }

  for (const call of walk(root)) {
    if (call.type !== "function_call") continue;
    const rawPath = call.childForFieldName("name")?.text ?? "";
    const path = resolvePath(rawPath, aliases, reactNamespaces, reactRobloxNamespaces);
    if (path !== "React.createElement") continue;
    const element = call.childForFieldName("arguments")?.namedChildren[0]?.text.trim() ?? "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(element)) continue;
    for (const info of functionsBySimpleName.get(element) ?? []) info.isComponent = true;
  }

  const addScopedVariable = (map: Map<string, Set<string>>, owner: FunctionInfo | null, name: string): void => {
    if (!owner) return;
    const key = nodeKey(owner.node);
    const names = map.get(key) ?? new Set<string>();
    names.add(name);
    map.set(key, names);
  };

  for (const declaration of declarations) {
    const names = declarationNames(declaration);
    const expressions = declarationExpressions(declaration);
    const owner = nearestFunctionInfo(declaration, functionByNode);

    for (let index = 0; index < names.length; index += 1) {
      const expression = expressions[index] ?? expressions[0];
      if (isSyntacticallyStableInitializer(expression) || expressionIsStableEngineObject(expression, aliases, reactNamespaces, reactRobloxNamespaces)) {
        stableVariables.add(names[index]);
        addScopedVariable(stableVariablesByFunction, owner, names[index]);
      }
      if (expressionCreatesInstance(expression, aliases, reactNamespaces, reactRobloxNamespaces)) {
        addScopedVariable(externalMutableVariablesByFunction, owner, names[index]);
        addScopedVariable(instanceVariablesByFunction, owner, names[index]);
      }
    }

    const call = declarationCall(declaration);
    if (!call) continue;
    const rawPath = call.childForFieldName("name")?.text ?? "";
    const path = resolvePath(rawPath, aliases, reactNamespaces, reactRobloxNamespaces);
    const args = call.childForFieldName("arguments")?.namedChildren ?? [];

    if (path === "React.joinBindings" && names.length >= 1) {
      stableVariables.add(names[0]);
      addScopedVariable(stableVariablesByFunction, owner, names[0]);
      addScopedVariable(externalMutableVariablesByFunction, owner, names[0]);
    } else if (path === "React.useState" && names.length >= 2) {
      const [valueName, setterName] = names;
      stateSetters.set(setterName, valueName);
      stateValues.set(valueName, setterName);
      stableVariables.add(setterName);
      addScopedVariable(stableVariablesByFunction, owner, setterName);
      stateBindings.push({
        valueName,
        setterName,
        declaration,
        call,
        initializer: args[0] ?? null,
        owner,
      });
    } else if (path === "React.useReducer" && names.length >= 2) {
      stableVariables.add(names[1]);
      addScopedVariable(stableVariablesByFunction, owner, names[1]);
    } else if (path === "React.useBinding" && names.length >= 1) {
      stableVariables.add(names[0]);
      addScopedVariable(stableVariablesByFunction, owner, names[0]);
      if (names.length >= 2) {
        stableVariables.add(names[1]);
        bindingSetters.add(names[1]);
        addScopedVariable(stableVariablesByFunction, owner, names[1]);
      }
    } else if (path === "React.useMemo" && names.length >= 1) {
      if (isEmptyDependencyTable(args[1])) {
        stableVariables.add(names[0]);
        addScopedVariable(stableVariablesByFunction, owner, names[0]);
      }
      if (memoReturnsInstance(args[0], aliases, reactNamespaces, reactRobloxNamespaces)) {
        addScopedVariable(externalMutableVariablesByFunction, owner, names[0]);
        addScopedVariable(instanceVariablesByFunction, owner, names[0]);
      }
    } else if (path === "React.useCallback" && names.length >= 1 && isEmptyDependencyTable(args[1])) {
      // Empty-dependency callbacks keep a stable identity. Their own stale captures are
      // diagnosed on the useCallback dependency table instead of cascading into every
      // effect that consumes the callback.
      stableVariables.add(names[0]);
      addScopedVariable(stableVariablesByFunction, owner, names[0]);
    } else if (path === "React.useRef" && names.length >= 1) {
      stableVariables.add(names[0]);
      refVariables.add(names[0]);
      addScopedVariable(stableVariablesByFunction, owner, names[0]);
      addScopedVariable(refVariablesByFunction, owner, names[0]);
    } else {
      const final = path.split(/[.:]/).at(-1) ?? "";
      if (/^use[A-Z0-9_]/.test(final)) {
        for (const name of names.slice(1)) {
          if (!STABLE_CUSTOM_HOOK_RETURN.test(name)) continue;
          stableVariables.add(name);
          addScopedVariable(stableVariablesByFunction, owner, name);
        }
      }
    }
  }

  // React state/binding hooks can be assigned into previously declared locals.
  // The setter/Binding contracts are still stable even when the declaration and hook
  // call are split across statements. Rules-of-hooks separately reports conditional calls.
  for (const assignment of walk(root)) {
    if (assignment.type !== "assignment_statement" || assignment.parent?.type === "variable_declaration") continue;
    const owner = nearestFunctionInfo(assignment, functionByNode);
    if (!owner || (!owner.isComponent && !owner.isHook)) continue;
    const variableList = assignment.namedChildren.find((child) => child.type === "variable_list");
    const expressionList = assignment.namedChildren.find((child) => child.type === "expression_list");
    const names = variableList?.namedChildren.filter((child) => child.type === "identifier").map((child) => child.text) ?? [];
    const expression = expressionList?.namedChildren[0];
    if (!expression || expression.type !== "function_call") continue;
    const rawPath = expression.childForFieldName("name")?.text ?? "";
    const path = resolvePath(rawPath, aliases, reactNamespaces, reactRobloxNamespaces);

    if (path === "React.useState" && names.length >= 2) {
      stableVariables.add(names[1]);
      addScopedVariable(stableVariablesByFunction, owner, names[1]);
    } else if (path === "React.useBinding" && names.length >= 1) {
      stableVariables.add(names[0]);
      addScopedVariable(stableVariablesByFunction, owner, names[0]);
      addScopedVariable(externalMutableVariablesByFunction, owner, names[0]);
      if (names.length >= 2) {
        stableVariables.add(names[1]);
        bindingSetters.add(names[1]);
        addScopedVariable(stableVariablesByFunction, owner, names[1]);
      }
    }
  }

  // Binding-like values are stable mutable handles. Custom React-Luau animation hooks
  // often return bindings without the analyzer knowing the hook implementation. Infer
  // them from Binding-only APIs instead of requiring them in dependency arrays.
  for (const call of walk(root)) {
    if (call.type !== "function_call") continue;
    const rawPath = normalizeExpressionText(call.childForFieldName("name")?.text ?? "");
    const match = rawPath.match(/^([A-Za-z_][A-Za-z0-9_]*):(?:getValue|map)$/);
    if (!match) continue;
    const owner = nearestFunctionInfo(call, functionByNode);
    if (!owner || (!owner.isComponent && !owner.isHook)) continue;
    stableVariables.add(match[1]);
    addScopedVariable(stableVariablesByFunction, owner, match[1]);
    addScopedVariable(externalMutableVariablesByFunction, owner, match[1]);
  }

  const componentLocals = new Map<string, Set<string>>();
  for (const info of functions) {
    if (!info.isComponent && !info.isHook) continue;
    const names = collectDirectLocals(info.body);
    for (const parameter of info.parameters) names.add(parameter);
    if (info.name?.includes(":")) names.add("self");
    componentLocals.set(nodeKey(info.node), names);
  }

  return {
    isReactFile,
    reactNamespaces,
    reactRobloxNamespaces,
    aliases,
    stateSetters,
    stateValues,
    stateBindings,
    refVariables,
    bindingSetters,
    stableVariables,
    refVariablesByFunction,
    stableVariablesByFunction,
    externalMutableVariablesByFunction,
    instanceVariablesByFunction,
    componentLocals,
    functions,
    functionByNode,
  };
}
