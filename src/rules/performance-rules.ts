import { normalizeRequireTarget, resolveModuleReference } from "../module-resolution";
import type { SyntaxNode } from "../syntax";
import type { DiagnosticInput, FunctionInfo, RuleContext, RuleDefinition, StateBinding } from "../types";
import { normalizeExpressionText, sameNode } from "../ast/walk";
import { isHighFrequencyRunServiceCall } from "../roblox-semantics";
import { callNameNode, declarationNames, identifierNode, fieldName, fieldNameNode, fieldValue, isBindingShadowedBetween, stateBindingsFor } from "./helpers";

const STATIC_DISCOVERY = /(?::|\.)(GetChildren|GetDescendants)$/;
const PURE_TRIVIAL_CALLS = /^(?:tostring|tonumber|type|typeof|math\.[A-Za-z_][A-Za-z0-9_]*|string\.(?:lower|upper|format|len)|Color3\.(?:new|fromRGB|fromHSV)|Vector[23]\.new|UDim2?\.(?:new|fromOffset|fromScale)|CFrame\.new)$/;

function declarationForCall(call: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = call.parent;
  while (current) {
    if (current.type === "variable_declaration") return current;
    if (current.type === "function_definition" || current.type === "function_declaration") return null;
    current = current.parent;
  }
  return null;
}

function declaredNameForCall(call: SyntaxNode): string | null {
  const declaration = declarationForCall(call);
  return declaration ? declarationNames(declaration)[0] ?? null : null;
}

function isIdentifierPropertyName(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (parent?.type === "dot_index_expression") return sameNode(parent.childForFieldName("field"), node);
  if (parent?.type === "method_index_expression") {
    return sameNode(parent.childForFieldName("method"), node) || sameNode(parent.namedChildren.at(-1), node);
  }
  return false;
}

function identifierReferences(
  context: RuleContext,
  owner: FunctionInfo,
  name: string,
  declaration: SyntaxNode | null,
): SyntaxNode[] {
  if (!owner.body) return [];
  const result: SyntaxNode[] = [];
  for (const node of context.walk(owner.body)) {
    if (node.type !== "identifier" || node.text !== name) continue;
    if (declaration && node.startIndex >= declaration.startIndex && node.endIndex <= declaration.endIndex) continue;
    if (isIdentifierPropertyName(node)) continue;
    if (isBindingShadowedBetween(node, owner, name, declaration)) continue;
    result.push(node);
  }
  return result;
}

function nearestAncestor(node: SyntaxNode, stop: SyntaxNode, type: string): SyntaxNode | null {
  let current = node.parent;
  while (current && !sameNode(current, stop)) {
    if (current.type === type) return current;
    current = current.parent;
  }
  return null;
}

function highFrequencyCallback(node: SyntaxNode, context: RuleContext): SyntaxNode | null {
  let current = node.parent;
  while (current) {
    if (current.type === "function_definition") {
      const argumentsNode = current.parent;
      const call = argumentsNode?.type === "arguments" ? argumentsNode.parent : null;
      if (call?.type === "function_call" && isHighFrequencyRunServiceCall(call, context)) return current;
    }
    current = current.parent;
  }
  return null;
}

function setterIsNoChangeGuarded(call: SyntaxNode, callback: SyntaxNode, binding: StateBinding): boolean {
  let current = call.parent;
  while (current && !sameNode(current, callback)) {
    if (current.type === "if_statement" || current.type === "if_expression") {
      const header = current.text.split(/\bthen\b/s, 1)[0] ?? "";
      const escaped = binding.valueName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escaped}\\b[^\\n]*(?:~=|==)|(?:~=|==)[^\\n]*\\b${escaped}\\b`).test(header)) return true;
    }
    current = current.parent;
  }
  return false;
}

function setterIsOneShotGuarded(call: SyntaxNode, callback: SyntaxNode): boolean {
  let current = call.parent;
  while (current && !sameNode(current, callback)) {
    if (current.type === "if_statement") {
      const header = current.text.split(/\bthen\b/s, 1)[0] ?? "";
      const candidates = [
        ...header.matchAll(/\bnot\s+([A-Za-z_][A-Za-z0-9_]*)\b/g),
        ...header.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*==\s*false\b/g),
      ].map((match) => match[1]);
      for (const guard of candidates) {
        const escaped = guard.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (!new RegExp(`\\b${escaped}\\s*=\\s*true\\b`).test(current.text)) continue;
        if (new RegExp(`\\b${escaped}\\s*=\\s*false\\b`).test(callback.text)) continue;
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

function componentRenderCost(context: RuleContext, owner: FunctionInfo): string[] {
  if (!owner.body) return [];
  let clones = 0;
  let loops = 0;
  let discovery = 0;
  for (const node of context.walk(owner.body)) {
    if (context.nearestFunction(node) !== owner) continue;
    if (node.type === "for_statement" || node.type === "while_statement" || node.type === "repeat_statement") loops += 1;
    if (node.type !== "function_call") continue;
    const path = context.resolveCallPath(context.getCallPath(node) ?? "");
    if (path === "table.clone") clones += 1;
    if (STATIC_DISCOVERY.test(path) || /:GetTagged$/.test(path)) discovery += 1;
  }
  const parts: string[] = [];
  if (clones > 0) parts.push(`${clones} table clone${clones === 1 ? "" : "s"}`);
  if (loops > 1) parts.push(`${loops} collection/loop passes`);
  if (discovery > 0) parts.push(`${discovery} Instance discovery call${discovery === 1 ? "" : "s"}`);
  return parts;
}

function memoizedImports(context: RuleContext): Map<string, "shallow" | "custom"> {
  const result = new Map<string, "shallow" | "custom">();
  for (const node of context.walk(context.root)) {
    if (node.type !== "variable_declaration") continue;
    const match = node.text.match(/^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\s*\((.*?)\)\s*$/s);
    if (!match) continue;
    const localName = match[1];
    const memoKind = resolveModuleReference(normalizeRequireTarget(match[2]), context.project.memoizedModules);
    if (memoKind) result.set(localName, memoKind);
  }
  return result;
}

function fieldLabel(field: SyntaxNode): string {
  return fieldName(field) ?? field.childForFieldName("name")?.text ?? "prop";
}

function isInlineFreshValue(node: SyntaxNode | null): boolean {
  return node?.type === "table_constructor" || node?.type === "function_definition";
}

export const rerenderUnstableMemoProps: RuleDefinition = {
  id: "react-luau/rerender-unstable-memo-props",
  category: "Performance",
  severity: "warning",
  description: "Warn when fresh table or function props defeat shallow React.memo comparisons.",
  run(context) {
    const imports = memoizedImports(context);
    if (imports.size === 0) return [];
    const diagnostics: DiagnosticInput[] = [];

    for (const call of context.findCalls()) {
      if (context.resolveCallPath(context.getCallPath(call) ?? "") !== "React.createElement") continue;
      const component = context.containingComponent(call);
      if (!component || context.nearestFunction(call) !== component) continue;
      const args = context.callArguments(call);
      const childName = args[0]?.text.trim() ?? "";
      if (imports.get(childName) !== "shallow") continue;
      const props = args[1];
      if (!props || props.type !== "table_constructor") continue;

      const unstableFields = props.namedChildren
        .filter((node) => node.type === "field")
        .filter((field) => isInlineFreshValue(fieldValue(field)));
      if (unstableFields.length === 0) continue;
      const unstable = unstableFields.map(fieldLabel);
      const highlights = unstableFields.map(fieldNameNode);

      diagnostics.push({
        node: highlights[0],
        highlights,
        severity: "warning",
        message: `Memoized ${childName} receives fresh ${unstable.join(", ")} prop${unstable.length === 1 ? "" : "s"} on every parent render.`,
        help: "Fresh table or function identity prevents the shallow memo comparison from skipping this child. Stabilize the prop only when the parent rerenders frequently, move construction into the child, or remove ineffective memoization.",
      });
    }

    return diagnostics;
  },
};

export const rerenderHighFrequencyState: RuleDefinition = {
  id: "react-luau/rerender-high-frequency-state",
  category: "Performance",
  severity: "warning",
  description: "Find state updates from frame callbacks that can rerender expensive component trees continuously.",
  run(context) {
    const diagnostics: DiagnosticInput[] = [];
    const seen = new Set<string>();

    for (const call of context.findCalls()) {
      const callback = highFrequencyCallback(call, context);
      if (!callback) continue;
      const component = context.containingComponent(call);
      if (!component) continue;
      const setter = context.getCallPath(call) ?? "";
      const binding = context.model.stateBindings.find((candidate) => candidate.owner === component && candidate.setterName === setter);
      if (!binding || setterIsNoChangeGuarded(call, callback, binding) || setterIsOneShotGuarded(call, callback)) continue;
      const key = `${callback.startIndex}:${setter}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const renderCost = componentRenderCost(context, component);
      diagnostics.push({
        node: callNameNode(binding.call),
        severity: "warning",
        message: `${binding.valueName} has a state setter called from a per-frame callback and may cause frequent rerenders when its value changes.`,
        help: renderCost.length > 0
          ? `This render also performs ${renderCost.join(" and ")}. Isolate or throttle the high-frequency state, or use Bindings for host-property-only updates.`
          : "Isolate or throttle the high-frequency state. Use React.useBinding when the value only drives host Instance properties.",
      });
    }

    return diagnostics;
  },
};

function singleReturnExpression(callback: SyntaxNode | undefined): SyntaxNode | null {
  if (!callback || callback.type !== "function_definition") return null;
  const body = callback.childForFieldName("body");
  if (!body || body.namedChildren.length !== 1) return null;
  const statement = body.namedChildren[0];
  if (statement.type !== "return_statement") return null;
  const expressionList = statement.namedChildren.find((child) => child.type === "expression_list");
  if (!expressionList || expressionList.namedChildren.length !== 1) return null;
  return expressionList.namedChildren[0] ?? null;
}

function isTrivialMemoExpression(expression: SyntaxNode, context: RuleContext): boolean {
  if (expression.type === "table_constructor" || expression.type === "function_definition") return false;
  let calls = 0;
  for (const node of context.walk(expression)) {
    if (node.type === "for_statement" || node.type === "while_statement" || node.type === "repeat_statement") return false;
    if (node.type !== "function_call") continue;
    calls += 1;
    const path = context.resolveCallPath(context.getCallPath(node) ?? "");
    if (/random|GenerateGUID|GetServerTimeNow|tick|time|clock/i.test(path)) return false;
    if (!PURE_TRIVIAL_CALLS.test(path)) return false;
  }
  return calls <= 2 && expression.text.length <= 180;
}

function valueIdentityIsObservedByHook(context: RuleContext, owner: FunctionInfo, name: string, declaration: SyntaxNode): boolean {
  if (!owner.body) return false;
  for (const call of context.walk(owner.body)) {
    if (call.type !== "function_call") continue;
    const path = context.resolveCallPath(context.getCallPath(call) ?? "");
    if (!/^React\.use(?:Effect|LayoutEffect|Memo|Callback)$/.test(path)) continue;
    const dependencies = context.callArguments(call)[1];
    if (!dependencies) continue;
    for (const reference of identifierReferences(context, owner, name, declaration)) {
      if (reference.startIndex >= dependencies.startIndex && reference.endIndex <= dependencies.endIndex) return true;
    }
  }
  return false;
}

function isEmptyDependencyTable(node: SyntaxNode | undefined): boolean {
  return Boolean(node && node.type === "table_constructor" && node.namedChildren.length === 0);
}

export const rerenderUnnecessaryUseMemo: RuleDefinition = {
  id: "react-luau/rerender-unnecessary-usememo",
  category: "Performance",
  severity: "warning",
  description: "Find trivial derived values that cost more to memoize than to compute directly.",
  run(context) {
    const diagnostics: DiagnosticInput[] = [];
    for (const call of context.findCalls()) {
      if (context.resolveCallPath(context.getCallPath(call) ?? "") !== "React.useMemo") continue;
      const owner = context.containingComponent(call) ?? context.nearestFunction(call);
      const declaration = declarationForCall(call);
      const name = declaredNameForCall(call);
      const argumentsList = context.callArguments(call);
      const expression = singleReturnExpression(argumentsList[0]);
      if (isEmptyDependencyTable(argumentsList[1])) continue;
      if (!owner || !declaration || !name || !expression || !isTrivialMemoExpression(expression, context)) continue;
      if (valueIdentityIsObservedByHook(context, owner, name, declaration)) continue;
      diagnostics.push({
        node: callNameNode(call),
        message: "useMemo caches a trivial derived value.",
        help: "Compute the value directly unless stable identity or a genuinely expensive calculation is required.",
      });
    }
    return diagnostics;
  },
};

function isOnlyDirectFunctionCallReference(node: SyntaxNode, name: string): boolean {
  const parent = node.parent;
  return parent?.type === "function_call"
    && sameNode(parent.childForFieldName("name"), node)
    && (parent.childForFieldName("name")?.text.trim() ?? "") === name;
}

export const rerenderUnnecessaryUseCallback: RuleDefinition = {
  id: "react-luau/rerender-unnecessary-usecallback",
  category: "Performance",
  severity: "warning",
  description: "Find useCallback values whose stable function identity is never observed.",
  run(context) {
    const diagnostics: DiagnosticInput[] = [];
    for (const call of context.findCalls()) {
      if (context.resolveCallPath(context.getCallPath(call) ?? "") !== "React.useCallback") continue;
      const owner = context.containingComponent(call) ?? context.nearestFunction(call);
      const declaration = declarationForCall(call);
      const name = declaredNameForCall(call);
      if (!owner || !declaration || !name) continue;
      const references = identifierReferences(context, owner, name, declaration);
      if (references.length === 0 || references.some((node) => !isOnlyDirectFunctionCallReference(node, name))) continue;
      diagnostics.push({
        node: callNameNode(call),
        message: `${name} is wrapped in useCallback, but its identity is never observed.`,
        help: "Use a normal local function. Keep useCallback when the function is passed to a memoized child, retained by another hook, or otherwise compared by identity.",
      });
    }
    return diagnostics;
  },
};

function staticDiscoveryPath(path: string): boolean {
  if (/:GetTagged$/.test(path)) return true;
  if (!STATIC_DISCOVERY.test(path)) return false;
  const receiver = path.replace(/(?::|\.)(?:GetChildren|GetDescendants)$/, "");
  return /^(?:ReplicatedStorage|ServerStorage|ServerScriptService|StarterGui|StarterPlayer|script)(?:\.|:|$)/.test(receiver);
}

export const rerenderStaticDiscoveryInRender: RuleDefinition = {
  id: "react-luau/rerender-static-discovery-in-render",
  category: "Performance",
  severity: "warning",
  description: "Find static Instance/module discovery repeated during component render.",
  run(context) {
    const diagnostics: DiagnosticInput[] = [];
    for (const call of context.findCalls()) {
      const component = context.containingComponent(call);
      if (!component || context.nearestFunction(call) !== component) continue;
      const path = context.resolveCallPath(context.getCallPath(call) ?? "");
      if (!staticDiscoveryPath(path)) continue;
      const loop = nearestAncestor(call, component.node, "for_statement");
      const body = loop?.childForFieldName("body");
      const requiresModules = Boolean(body && [...context.walk(body)].some((node) => node.type === "function_call" && context.getCallPath(node) === "require"));
      diagnostics.push({
        node: callNameNode(call),
        severity: "warning",
        message: `${path} runs during component render${requiresModules ? " and feeds module requires" : ""}.`,
        help: requiresModules
          ? "Discover and require static modules once outside the component, or cache the derived catalog by the inputs that can actually change."
          : "Move static discovery outside the component or memoize the derived result when the source can change.",
      });
    }
    return diagnostics;
  },
};

function genericLoopCollection(loop: SyntaxNode): string | null {
  const clause = loop.namedChildren.find((child) => child.type === "for_generic_clause");
  if (!clause) return null;
  const match = clause.text.match(/\bin\s+(.+)$/s);
  if (!match) return null;
  const expression = normalizeExpressionText(match[1]);
  if (!expression || expression.length > 160) return null;
  return expression;
}

export const rerenderRepeatedCollectionScan: RuleDefinition = {
  id: "react-luau/rerender-repeated-collection-scan",
  category: "Performance",
  severity: "warning",
  description: "Find repeated direct render passes over the same collection expression.",
  run(context) {
    const diagnostics: DiagnosticInput[] = [];
    for (const component of context.model.functions) {
      if (!component.isComponent || !component.body) continue;
      const groups = new Map<string, { display: string; loops: SyntaxNode[] }>();
      for (const node of context.walk(component.body)) {
        if (node.type !== "for_statement" || context.nearestFunction(node) !== component) continue;
        const collection = genericLoopCollection(node);
        if (!collection || collection === "{}") continue;
        const clause = node.namedChildren.find((child) => child.type === "for_generic_clause");
        const display = clause?.text.match(/\bin\s+(.+)$/s)?.[1]?.trim().replace(/\s+/g, " ") ?? collection;
        const group = groups.get(collection) ?? { display, loops: [] };
        group.loops.push(node);
        groups.set(collection, group);
      }
      for (const { display, loops } of groups.values()) {
        if (loops.length < 2) continue;
        const repeatedCollections = loops.map((loop) => {
          const clause = loop.namedChildren.find((child) => child.type === "for_generic_clause");
          return clause?.namedChildren.at(-1) ?? clause ?? loop;
        });
        diagnostics.push({
          node: repeatedCollections[1],
          highlights: repeatedCollections,
          message: `${display} is scanned ${loops.length} times during this render.`,
          help: "Consider combining the passes or deriving a lookup when the collection is large or the component rerenders frequently.",
        });
      }
    }
    return diagnostics;
  },
};

export const rerenderStaticState: RuleDefinition = {
  id: "react-luau/rerender-static-state",
  category: "Performance",
  severity: "warning",
  description: "Find React state whose setter is never used and therefore cannot change.",
  run(context) {
    const diagnostics: DiagnosticInput[] = [];
    for (const component of context.model.functions) {
      if (!component.isComponent || !component.body) continue;
      for (const binding of stateBindingsFor(context, component)) {
        if (binding.setterName === "_" || binding.setterName.startsWith("_")) continue;
        const setterRefs = identifierReferences(context, component, binding.setterName, binding.declaration);
        if (setterRefs.length > 0) continue;
        const valueRefs = identifierReferences(context, component, binding.valueName, binding.declaration);
        if (valueRefs.length === 0) continue;
        diagnostics.push({
          node: identifierNode(binding.declaration, binding.setterName) ?? binding.declaration,
          message: `${binding.valueName} cannot change because ${binding.setterName} is never used.`,
          help: "Use a normal derived value. If the initial value must be captured once for the component lifetime, use a ref.",
        });
      }
    }
    return diagnostics;
  },
};

function memoReturnsCurrentCell(call: SyntaxNode, context: RuleContext): boolean {
  const args = context.callArguments(call);
  const callback = args[0];
  const deps = args[1];
  if (!callback || callback.type !== "function_definition" || deps?.type !== "table_constructor" || deps.namedChildren.length > 0) return false;
  const expression = singleReturnExpression(callback);
  if (!expression || expression.type !== "table_constructor") return false;
  const fields = expression.namedChildren.filter((node) => node.type === "field");
  return fields.length === 1 && fieldName(fields[0]) === "current";
}

export const preferUseRefForMutableCell: RuleDefinition = {
  id: "react-luau/prefer-use-ref-for-mutable-cell",
  category: "Hooks",
  severity: "suggestion",
  description: "Prefer useRef over useMemo-created tables that only emulate a mutable current cell.",
  run(context) {
    const diagnostics: DiagnosticInput[] = [];
    for (const call of context.findCalls()) {
      if (context.resolveCallPath(context.getCallPath(call) ?? "") !== "React.useMemo") continue;
      if (!memoReturnsCurrentCell(call, context)) continue;
      const name = declaredNameForCall(call) ?? "This value";
      diagnostics.push({
        node: callNameNode(call),
        message: `${name} uses useMemo to create a { current = ... } mutable cell.`,
        help: "Use React.useRef(initialValue) to express the same lifetime and mutable-cell intent directly.",
      });
    }
    return diagnostics;
  },
};
