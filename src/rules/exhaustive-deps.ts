import type { Node as SyntaxNode } from "web-tree-sitter";
import type { DiagnosticInput, FunctionInfo, RuleContext, RuleDefinition } from "../types";
import { nodeKey, normalizeExpressionText, rootIdentifier, sameNode } from "../ast/walk";
import { mutableDependencyBase } from "../roblox-semantics";
import { declarationNames, dependencyExpressions, tableStartNode } from "./helpers";

const GLOBALS = new Set([
  "game", "workspace", "script", "shared", "Enum", "Instance", "task", "coroutine", "debug", "os", "utf8", "buffer", "bit32",
  "math", "string", "table", "pairs", "ipairs", "next", "pcall", "xpcall", "print", "warn", "error", "assert", "type", "typeof",
  "tonumber", "tostring", "select", "unpack", "rawget", "rawset", "rawequal", "setmetatable", "getmetatable", "Vector2", "Vector3", "UDim",
  "UDim2", "CFrame", "Color3", "BrickColor", "Rect", "Region3", "Ray", "TweenInfo", "NumberRange", "NumberSequence", "ColorSequence",
  "DateTime", "Random", "Axes", "Faces", "PhysicalProperties", "RaycastParams", "OverlapParams", "DockWidgetPluginGuiInfo",
]);

const HOOK_ARGUMENTS = new Map<string, { callbackIndex: number; depsIndex: number }>([
  ["React.useEffect", { callbackIndex: 0, depsIndex: 1 }],
  ["React.useLayoutEffect", { callbackIndex: 0, depsIndex: 1 }],
  ["React.useMemo", { callbackIndex: 0, depsIndex: 1 }],
  ["React.useCallback", { callbackIndex: 0, depsIndex: 1 }],
  ["React.useImperativeHandle", { callbackIndex: 1, depsIndex: 2 }],
]);

function parameterNames(functionNode: SyntaxNode): Set<string> {
  const names = new Set<string>();
  const parameters = functionNode.childForFieldName("parameters");
  if (!parameters) return names;
  for (const node of parameters.namedChildren) {
    for (const candidate of descendants(node)) {
      if (candidate.type === "identifier") names.add(candidate.text);
    }
  }
  return names;
}

function* descendants(node: SyntaxNode): Iterable<SyntaxNode> {
  yield node;
  for (const child of node.namedChildren) yield* descendants(child);
}

function directBlockBindingNames(block: SyntaxNode, beforeIndex: number): Set<string> {
  const names = new Set<string>();
  for (const child of block.namedChildren) {
    if (child.startIndex >= beforeIndex) continue;
    if (child.type === "variable_declaration") {
      for (const name of declarationNames(child)) names.add(name);
    } else if (child.type === "function_declaration") {
      const name = child.childForFieldName("name")?.text;
      if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

function loopBindingNames(loop: SyntaxNode): Set<string> {
  const names = new Set<string>();
  const header = loop.text.split(/\bdo\b/s, 1)[0] ?? "";
  const numeric = header.match(/^\s*for\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/s);
  if (numeric) names.add(numeric[1]);
  const generic = header.match(/^\s*for\s+(.+?)\s+in\b/s);
  if (generic) {
    for (const part of generic[1].split(",")) {
      const name = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
      if (name) names.add(name);
    }
  }
  return names;
}

function isLocallyBoundOccurrence(identifier: SyntaxNode, callback: SyntaxNode, name: string): boolean {
  if (parameterNames(callback).has(name)) return true;

  let current = identifier.parent;
  while (current && !sameNode(current, callback)) {
    if ((current.type === "function_definition" || current.type === "function_declaration") && parameterNames(current).has(name)) {
      return true;
    }
    if (current.type === "block" && directBlockBindingNames(current, identifier.startIndex).has(name)) return true;
    if (current.type === "for_statement" && loopBindingNames(current).has(name)) return true;
    current = current.parent;
  }
  return false;
}

function isPropertyName(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "dot_index_expression") return sameNode(parent.childForFieldName("field"), node);
  if (parent.type === "method_index_expression") return sameNode(parent.childForFieldName("method"), node) || sameNode(parent.namedChildren.at(-1), node);
  // `fieldName = value` uses fieldName as a table key, not as a captured value.
  // Without this, a coincidentally named component local can create a fake dep.
  if (parent.type === "field" && !parent.text.trim().startsWith("[")) {
    return sameNode(parent.childForFieldName("name"), node);
  }
  return false;
}

function outermostDotPath(node: SyntaxNode): boolean {
  const parent = node.parent;
  return !(parent?.type === "dot_index_expression" && sameNode(parent.namedChildren[0], node));
}

function rootIdentifierNode(node: SyntaxNode, root: string): SyntaxNode | null {
  for (const candidate of descendants(node)) {
    if (candidate.type !== "identifier" || candidate.text !== root) continue;
    if (isPropertyName(candidate)) continue;
    return candidate;
  }
  return null;
}

function normalizeCapturedPath(
  path: string,
  stableVariables: Set<string>,
  externallyMutableRoots: Set<string>,
): string | null {
  const normalized = normalizeExpressionText(path);
  const root = rootIdentifier(normalized);
  if (!root) return normalized;

  const mutableBase = mutableDependencyBase(normalized, externallyMutableRoots);
  if (mutableBase === "") return null;
  if (mutableBase) {
    const baseRoot = rootIdentifier(mutableBase);
    if (baseRoot && stableVariables.has(baseRoot)) return null;
    return mutableBase;
  }

  return normalized;
}

function capturedDependencyPaths(
  callback: SyntaxNode,
  available: Set<string>,
  stableVariables: Set<string>,
  externallyMutableRoots: Set<string>,
): Set<string> {
  const captured = new Set<string>();

  for (const node of descendants(callback)) {
    if (node.type === "dot_index_expression" && outermostDotPath(node)) {
      const root = rootIdentifier(node.text);
      if (!root || !available.has(root) || GLOBALS.has(root) || stableVariables.has(root)) continue;
      const rootNode = rootIdentifierNode(node, root);
      if (!rootNode || isLocallyBoundOccurrence(rootNode, callback, root)) continue;
      const capture = normalizeCapturedPath(node.text, stableVariables, externallyMutableRoots);
      if (capture) captured.add(capture);
      continue;
    }

    if (node.type !== "identifier" || isPropertyName(node)) continue;
    const parent = node.parent;
    if (parent?.type === "dot_index_expression" && sameNode(parent.namedChildren[0], node)) continue;
    const name = node.text;
    if (!available.has(name) || GLOBALS.has(name) || stableVariables.has(name)) continue;
    if (isLocallyBoundOccurrence(node, callback, name)) continue;
    captured.add(name);
  }

  return captured;
}

function localFunctionNode(owner: FunctionInfo, name: string, context: RuleContext): SyntaxNode | null {
  if (!owner.body) return null;
  for (const statement of owner.body.namedChildren) {
    if (statement.type === "function_declaration" && statement.childForFieldName("name")?.text === name) return statement;
    if (statement.type !== "variable_declaration" || !declarationNames(statement).includes(name)) continue;
    const prefix = statement.text.split("=", 1)[0] ?? "";
    if (!new RegExp(`\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\b`).test(prefix)) continue;
    const fn = [...context.walk(statement)].find((node) => node.type === "function_definition");
    if (fn) return fn;
  }
  return null;
}

function expandLocalFunctionCaptures(
  captured: Set<string>,
  owner: FunctionInfo,
  available: Set<string>,
  stableVariables: Set<string>,
  externallyMutableRoots: Set<string>,
  context: RuleContext,
): Set<string> {
  const result = new Set<string>();
  const visiting = new Set<string>();

  const addCapture = (capture: string): void => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(capture)) {
      result.add(capture);
      return;
    }
    const fn = localFunctionNode(owner, capture, context);
    if (visiting.has(capture)) return;
    if (!fn) {
      result.add(capture);
      return;
    }

    visiting.add(capture);
    const inner = capturedDependencyPaths(fn, available, stableVariables, externallyMutableRoots);
    for (const dependency of inner) addCapture(dependency);
    visiting.delete(capture);
  };

  for (const capture of captured) addCapture(capture);
  return result;
}

function dependencyPaths(node: SyntaxNode): Set<string> {
  return new Set(dependencyExpressions(node).map((dependency) => normalizeExpressionText(dependency.text)));
}

const PURE_DERIVED_CALL = /^(?:math\.(?!random(?:seed)?$)[A-Za-z_][A-Za-z0-9_]*|string\.[A-Za-z_][A-Za-z0-9_]*|table\.(?:find|concat|clone|create|isfrozen)|(?:Color3|Vector2|Vector3|UDim|UDim2|CFrame|BrickColor|Rect|NumberRange|NumberSequence|ColorSequence|TweenInfo|Font|Ray|Region3|PhysicalProperties)\.[A-Za-z_][A-Za-z0-9_]*|[^:]+:(?:ToHSV|Lerp|Dot|Cross|FuzzyEq|Inverse|ToObjectSpace|ToWorldSpace))$/;

function isPureDerivedExpression(node: SyntaxNode, context: RuleContext): boolean {
  for (const candidate of context.walk(node)) {
    if (candidate !== node && (candidate.type === "function_definition" || candidate.type === "function_declaration")) return false;
    if (candidate.type !== "function_call") continue;
    const rawPath = context.getCallPath(candidate);
    if (!rawPath) return false;
    const path = normalizeExpressionText(context.resolveCallPath(rawPath));
    if (!PURE_DERIVED_CALL.test(path)) return false;
  }
  return true;
}

function mutatedOwnerLocals(owner: FunctionInfo, context: RuleContext): Set<string> {
  const mutated = new Set<string>();
  if (!owner.body) return mutated;

  for (const node of context.walk(owner.body)) {
    if (node.type !== "assignment_statement" && node.type !== "update_statement") continue;
    if (node.parent?.type === "variable_declaration") continue;
    const variables = node.namedChildren.find((child) => child.type === "variable_list");
    if (!variables) continue;
    for (const variable of variables.namedChildren) {
      const root = rootIdentifier(normalizeExpressionText(variable.text));
      if (root) mutated.add(root);
    }
  }

  return mutated;
}

function derivedLocalDependencies(
  owner: FunctionInfo,
  available: Set<string>,
  stableVariables: Set<string>,
  externallyMutableRoots: Set<string>,
  context: RuleContext,
): Map<string, Set<string>> {
  const derived = new Map<string, Set<string>>();
  if (!owner.body) return derived;
  const mutated = mutatedOwnerLocals(owner, context);

  for (const statement of owner.body.namedChildren) {
    if (statement.type !== "variable_declaration") continue;
    const names = declarationNames(statement);
    const expressions = declarationExpressions(statement);
    if (names.length === 0 || expressions.length === 0) continue;

    for (let index = 0; index < names.length; index += 1) {
      const name = names[index];
      const expression = expressions[index] ?? expressions[0];
      if (!expression || mutated.has(name) || !isPureDerivedExpression(expression, context)) continue;
      derived.set(name, capturedDependencyPaths(expression, available, stableVariables, externallyMutableRoots));
    }
  }

  return derived;
}

function expandDerivedLocalCaptures(
  captured: Set<string>,
  derived: Map<string, Set<string>>,
  dependencies: Set<string>,
): Set<string> {
  const result = new Set<string>();
  const visiting = new Set<string>();

  const addCapture = (capture: string): void => {
    if (dependencySatisfies(capture, dependencies)) {
      result.add(capture);
      return;
    }
    const root = rootIdentifier(capture);
    if (!root || !derived.has(root)) {
      result.add(capture);
      return;
    }
    if (visiting.has(root)) return;

    visiting.add(root);
    for (const dependency of derived.get(root) ?? []) addCapture(dependency);
    visiting.delete(root);
  };

  for (const capture of captured) addCapture(capture);
  return result;
}

function hasDynamicUnpackDependencies(node: SyntaxNode, context: RuleContext): boolean {
  for (const dependency of dependencyExpressions(node)) {
    for (const candidate of context.walk(dependency)) {
      if (candidate.type !== "function_call") continue;
      const rawPath = context.getCallPath(candidate);
      if (!rawPath) continue;
      const path = normalizeExpressionText(context.resolveCallPath(rawPath));
      if (path === "unpack" || path === "table.unpack") return true;
    }
  }
  return false;
}

function memoizedProducerDependencies(owner: FunctionInfo, context: RuleContext): Map<string, Set<string>> {
  const producers = new Map<string, Set<string>>();
  if (!owner.body) return producers;

  for (const statement of owner.body.namedChildren) {
    if (statement.type !== "variable_declaration") continue;
    const names = declarationNames(statement);
    const expressions = declarationExpressions(statement);
    if (names.length === 0 || expressions.length === 0) continue;

    for (let index = 0; index < names.length; index += 1) {
      const name = names[index];
      const expression = expressions[index] ?? expressions[0];
      if (!expression || expression.type !== "function_call") continue;
      const rawPath = context.getCallPath(expression);
      if (!rawPath) continue;
      const path = context.resolveCallPath(rawPath);
      if (path !== "React.useMemo" && path !== "React.useCallback") continue;
      const args = context.callArguments(expression);
      const deps = args[1];
      if (!deps || deps.type !== "table_constructor" || hasDynamicUnpackDependencies(deps, context)) continue;
      producers.set(name, dependencyPaths(deps));
    }
  }

  return producers;
}

function isTransitivelyCoveredMemoizedValue(
  dependency: string,
  producers: Map<string, Set<string>>,
  dependencies: Set<string>,
): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dependency)) return false;
  const producerDependencies = producers.get(dependency);
  if (!producerDependencies) return false;
  return [...producerDependencies].every((producerDependency) => dependencySatisfies(producerDependency, dependencies));
}

function dependencySatisfies(captured: string, dependencies: Set<string>): boolean {
  for (const dependency of dependencies) {
    if (captured === dependency) return true;
    if (captured.startsWith(`${dependency}.`) || captured.startsWith(`${dependency}[`)) return true;
  }
  return false;
}

function minimalMissingDependencies(captured: Set<string>, dependencies: Set<string>): string[] {
  const missing = [...captured]
    .filter((name) => !dependencySatisfies(name, dependencies))
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
  const result: string[] = [];
  for (const candidate of missing) {
    if (dependencySatisfies(candidate, new Set(result))) continue;
    result.push(candidate);
  }
  return result.sort();
}

function declarationExpressions(node: SyntaxNode): SyntaxNode[] {
  if (node.type !== "variable_declaration") return [];
  const assignment = node.namedChildren.find((child) => child.type === "assignment_statement");
  const expressionList = assignment?.namedChildren.find((child) => child.type === "expression_list");
  return expressionList?.namedChildren ?? [];
}

function directCallsInExpression(node: SyntaxNode): SyntaxNode[] {
  const calls: SyntaxNode[] = [];
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current !== node && (current.type === "function_definition" || current.type === "function_declaration")) continue;
    if (current.type === "function_call") calls.push(current);
    pending.push(...current.namedChildren);
  }
  return calls;
}

function isCustomHookCall(call: SyntaxNode, context: RuleContext): boolean {
  const path = context.resolveCallPath(context.getCallPath(call) ?? "");
  const final = path.split(/[.:]/).at(-1) ?? "";
  return !path.startsWith("React.") && /^use[A-Z0-9_]/.test(final);
}

interface CustomHookDependencyHints {
  memberHandleRoots: Set<string>;
  likelyHandleRoots: Set<string>;
  compositeHandleRoots: Set<string>;
}

const HANDLE_VALUE_NAME = /(?:ref|binding|tween|spring|motion|animation|controller|handle|connection|signal)$/i;
const HANDLE_HOOK_NAME = /(?:Tween|Spring|Binding|Motion|Animated|Animation|Sound)$/i;

function isCalledAsFunction(owner: FunctionInfo, name: string, context: RuleContext): boolean {
  if (!owner.body) return false;
  for (const call of context.walk(owner.body)) {
    if (call.type !== "function_call") continue;
    const path = normalizeExpressionText(context.getCallPath(call) ?? "");
    if (path === name) return true;
  }
  return false;
}

function customHookDependencyHints(owner: FunctionInfo, context: RuleContext): CustomHookDependencyHints {
  const hints: CustomHookDependencyHints = {
    memberHandleRoots: new Set<string>(),
    likelyHandleRoots: new Set<string>(),
    compositeHandleRoots: new Set<string>(),
  };
  if (!owner.body) return hints;

  for (const statement of owner.body.namedChildren) {
    if (statement.type !== "variable_declaration") continue;
    const names = declarationNames(statement);
    const expressions = declarationExpressions(statement);
    if (names.length === 0 || expressions.length === 0) continue;

    for (let index = 0; index < names.length; index += 1) {
      const name = names[index];
      const expression = expressions[index] ?? expressions[0];
      if (!expression) continue;
      const calls = directCallsInExpression(expression);
      if (calls.length === 0) continue;

      const directHook = calls.find((call) => isCustomHookCall(call, context));
      if (directHook && expression.type === "function_call") {
        const path = context.resolveCallPath(context.getCallPath(directHook) ?? "");
        const final = path.split(/[.:]/).at(-1) ?? "";
        const likelyHandle = HANDLE_VALUE_NAME.test(name) || HANDLE_HOOK_NAME.test(final) || isCalledAsFunction(owner, name, context);
        if (likelyHandle) {
          hints.memberHandleRoots.add(name);
          hints.likelyHandleRoots.add(name);
        }
        continue;
      }

      if (expression.type === "table_constructor") {
        const meaningfulCalls = calls.filter((call) => {
          const path = context.resolveCallPath(context.getCallPath(call) ?? "");
          return !/^(?:Color3|Vector2|Vector3|UDim|UDim2|CFrame|TweenInfo|NumberSequence|ColorSequence)\./.test(path);
        });
        const allHandleHooks = meaningfulCalls.length > 0 && meaningfulCalls.every((call) => {
          if (!isCustomHookCall(call, context)) return false;
          const path = context.resolveCallPath(context.getCallPath(call) ?? "");
          const final = path.split(/[.:]/).at(-1) ?? "";
          return HANDLE_HOOK_NAME.test(final);
        });
        if (allHandleHooks) hints.compositeHandleRoots.add(name);
      }
    }
  }

  return hints;
}

function isAmbiguousCustomHookHandle(dependency: string, hints: CustomHookDependencyHints): boolean {
  const root = rootIdentifier(dependency);
  if (!root) return false;
  if (hints.compositeHandleRoots.has(root)) return true;
  if (hints.likelyHandleRoots.has(root)) return true;
  return hints.memberHandleRoots.has(root) && dependency !== root;
}


export const exhaustiveDeps: RuleDefinition = {
  id: "react-luau/exhaustive-deps",
  category: "Hooks",
  severity: "warning",
  description: "React hook dependency tables should include captured reactive render values.",
  run(context: RuleContext) {
    const diagnostics: DiagnosticInput[] = [];
    const derivedDependenciesByOwner = new Map<string, Map<string, Set<string>>>();
    const dependencyHintsByOwner = new Map<string, CustomHookDependencyHints>();
    const memoizedProducersByOwner = new Map<string, Map<string, Set<string>>>();

    for (const call of context.findCalls()) {
      const rawPath = context.getCallPath(call);
      if (!rawPath) continue;
      const path = context.resolveCallPath(rawPath);
      const shape = HOOK_ARGUMENTS.get(path);
      if (!shape) continue;

      const args = context.callArguments(call);
      const callback = args[shape.callbackIndex];
      const deps = args[shape.depsIndex];
      if (!callback || callback.type !== "function_definition" || !deps || deps.type !== "table_constructor") continue;

      const owner = context.nearestFunction(call);
      if (!owner || (!owner.isComponent && !owner.isHook)) continue;
      const ownerKey = nodeKey(owner.node);
      const available = context.model.componentLocals.get(ownerKey) ?? new Set<string>();
      const stableVariables = context.model.stableVariablesByFunction.get(ownerKey) ?? new Set<string>();
      const externallyMutableRoots = context.model.externalMutableVariablesByFunction.get(ownerKey) ?? new Set<string>();
      const functionExpandedCaptures = expandLocalFunctionCaptures(
        capturedDependencyPaths(callback, available, stableVariables, externallyMutableRoots),
        owner,
        available,
        stableVariables,
        externallyMutableRoots,
        context,
      );
      const dependencies = dependencyPaths(deps);
      let derivedDependencies = derivedDependenciesByOwner.get(ownerKey);
      if (!derivedDependencies) {
        derivedDependencies = derivedLocalDependencies(owner, available, stableVariables, externallyMutableRoots, context);
        derivedDependenciesByOwner.set(ownerKey, derivedDependencies);
      }
      const captured = expandDerivedLocalCaptures(
        functionExpandedCaptures,
        derivedDependencies,
        dependencies,
      );
      const missing = minimalMissingDependencies(captured, dependencies);
      if (missing.length === 0) continue;

      if (hasDynamicUnpackDependencies(deps, context)) {
        diagnostics.push({
          node: tableStartNode(deps),
          severity: "suggestion",
          message: `${path} uses dynamic unpack(...) dependencies, so exhaustive dependency analysis is partial.`,
          help: "The analyzer cannot prove which values unpack(...) contributes. Review the explicit dependencies and the custom hook contract.",
        });
        continue;
      }

      let hints = dependencyHintsByOwner.get(ownerKey);
      if (!hints) {
        hints = customHookDependencyHints(owner, context);
        dependencyHintsByOwner.set(ownerKey, hints);
      }
      let memoizedProducers = memoizedProducersByOwner.get(ownerKey);
      if (!memoizedProducers) {
        memoizedProducers = memoizedProducerDependencies(owner, context);
        memoizedProducersByOwner.set(ownerKey, memoizedProducers);
      }
      const uncertainHandles = missing.filter((dependency) => isAmbiguousCustomHookHandle(dependency, hints));
      const transitivelyCoveredMemoized = missing.filter((dependency) =>
        !isAmbiguousCustomHookHandle(dependency, hints)
        && isTransitivelyCoveredMemoizedValue(dependency, memoizedProducers, dependencies)
      );
      const reactiveMissing = missing.filter((dependency) =>
        !isAmbiguousCustomHookHandle(dependency, hints)
        && !isTransitivelyCoveredMemoizedValue(dependency, memoizedProducers, dependencies)
      );

      if (reactiveMissing.length > 0) {
        diagnostics.push({
          node: tableStartNode(deps),
          message: `${path} dependency table is missing ${reactiveMissing.join(", ")}.`,
          help: `Add ${reactiveMissing.join(", ")} to the dependency table, or stop capturing ${reactiveMissing.length === 1 ? "that value" : "those values"} in the callback.`,
        });
      }

      if (transitivelyCoveredMemoized.length > 0) {
        diagnostics.push({
          node: tableStartNode(deps),
          severity: "suggestion",
          message: `${path} captures memoized value ${transitivelyCoveredMemoized.join(", ")} without listing ${transitivelyCoveredMemoized.length === 1 ? "it directly" : "them directly"}, but ${transitivelyCoveredMemoized.length === 1 ? "its memo dependencies are" : "their memo dependencies are"} already covered.`,
          help: "The producing memo dependencies are already covered. Listing the memoized value directly can make the dependency relationship clearer.",
        });
      }

      if (uncertainHandles.length > 0) {
        diagnostics.push({
          node: tableStartNode(deps),
          severity: "suggestion",
          message: `${path} captures custom-hook handle ${uncertainHandles.join(", ")} without listing ${uncertainHandles.length === 1 ? "it as a dependency" : "them as dependencies"}.`,
          help: "The analyzer cannot prove this custom-hook return is stable. Check the hook contract before changing the dependency table.",
        });
      }
    }

    return diagnostics;
  },
};
