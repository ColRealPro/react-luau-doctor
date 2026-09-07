import type { SyntaxNode } from "../syntax";
import type { FunctionInfo, RuleContext, RuleDefinition } from "../types";
import { nodeKey, rootIdentifier } from "../ast/walk";
import {
  callNameNode,
  containsUnshadowedIdentifier,
  dependencyExpressions,
  functionInfoForNode,
  isEffectPath,
  parseDependencyRoots,
  stateBindingsFor,
} from "./helpers";

const HOOKS_WITH_DEPS = new Set([
  "React.useEffect",
  "React.useLayoutEffect",
  "React.useMemo",
  "React.useCallback",
  "React.useImperativeHandle",
]);

function ownerForHook(context: RuleContext, call: SyntaxNode): FunctionInfo | null {
  const owner = context.nearestFunction(call);
  return owner && (owner.isComponent || owner.isHook) ? owner : null;
}

function callbackAndDeps(context: RuleContext, call: SyntaxNode): { callback: SyntaxNode; deps: SyntaxNode } | null {
  const path = context.resolveCallPath(context.getCallPath(call) ?? "");
  const args = context.callArguments(call);
  if (path === "React.useImperativeHandle") {
    const callback = args[1];
    const deps = args[2];
    if (callback?.type === "function_definition" && deps?.type === "table_constructor") return { callback, deps };
    return null;
  }
  const callback = args[0];
  const deps = args[1];
  if (callback?.type === "function_definition" && deps?.type === "table_constructor") return { callback, deps };
  return null;
}

function directTopLevelCalls(context: RuleContext, callback: SyntaxNode): SyntaxNode[] {
  const info = functionInfoForNode(context, callback);
  if (!info?.body) return [];
  return info.body.namedChildren.filter((child) => child.type === "function_call");
}

function hasCall(node: SyntaxNode, context: RuleContext): boolean {
  for (const child of context.walk(node)) {
    if (child.type === "function_call") return true;
  }
  return false;
}

function hasExternalSubscription(node: SyntaxNode, context: RuleContext): boolean {
  for (const child of context.walk(node)) {
    if (child.type !== "function_call") continue;
    const path = context.getCallPath(child) ?? "";
    if (/:Connect$/.test(path) || /BindToRenderStep$/.test(path) || /:BindAction(?:AtPriority)?$/.test(path)) return true;
  }
  return false;
}

function directLocalInitializer(owner: FunctionInfo, name: string): SyntaxNode | null {
  if (!owner.body) return null;
  for (const statement of owner.body.namedChildren) {
    if (statement.type !== "variable_declaration") continue;
    const assignment = statement.namedChildren.find((child) => child.type === "assignment_statement");
    const variableList = assignment?.namedChildren.find((child) => child.type === "variable_list");
    const expressionList = assignment?.namedChildren.find((child) => child.type === "expression_list");
    const names = variableList?.namedChildren.filter((child) => child.type === "identifier") ?? [];
    const expressions = expressionList?.namedChildren ?? [];
    const index = names.findIndex((child) => child.text === name);
    if (index >= 0) return expressions[index] ?? expressions[0] ?? null;
  }
  return null;
}

function setterCalledOutsideCallback(context: RuleContext, owner: FunctionInfo, callback: SyntaxNode, setterName: string): boolean {
  if (!owner.body) return false;
  for (const node of context.walk(owner.body)) {
    if (node.type !== "function_call" || context.getCallPath(node) !== setterName) continue;
    if (node.startIndex >= callback.startIndex && node.endIndex <= callback.endIndex) continue;
    return true;
  }
  return false;
}

function freshDependencyKind(node: SyntaxNode, owner: FunctionInfo): string | null {
  if (node.type === "table_constructor") return "table";
  if (node.type === "function_definition") return "function";

  if (node.type === "identifier") {
    const initializer = directLocalInitializer(owner, node.text);
    if (initializer?.type === "table_constructor") return "table";
    if (initializer?.type === "function_definition") return "function";
  }

  return null;
}

export const noDerivedStateEffect: RuleDefinition = {
  id: "react-luau/no-derived-state-effect",
  category: "Effects",
  severity: "warning",
  description: "Avoid copying render-known derived values into state from an effect.",
  run(context) {
    const diagnostics = [];

    for (const call of context.findCalls()) {
      const path = context.resolveCallPath(context.getCallPath(call) ?? "");
      if (!isEffectPath(path)) continue;
      const owner = ownerForHook(context, call);
      const parts = callbackAndDeps(context, call);
      if (!owner || !parts) continue;
      if (hasExternalSubscription(parts.callback, context)) continue;
      const available = context.model.componentLocals.get(nodeKey(owner.node)) ?? new Set(owner.parameters);
      const bindings = stateBindingsFor(context, owner);
      const setterToValue = new Map(bindings.map((binding) => [binding.setterName, binding.valueName]));

      for (const setterCall of directTopLevelCalls(context, parts.callback)) {
        const setter = context.getCallPath(setterCall) ?? "";
        const targetState = setterToValue.get(setter);
        if (!targetState) continue;
        // If the setter is also used by handlers or other effects, the state has independent
        // ownership and is not merely a render-known derived copy.
        if (setterCalledOutsideCallback(context, owner, parts.callback, setter)) continue;
        const argument = context.callArguments(setterCall)[0];
        if (!argument || argument.type === "function_definition" || hasCall(argument, context)) continue;

        const sourceNames = [...available].filter((name) => name !== targetState && containsUnshadowedIdentifier(argument, name, context, owner));
        if (sourceNames.length === 0) continue;

        diagnostics.push({
          node: callNameNode(setterCall),
          message: `${setter}() stores a value derived from ${sourceNames.slice(0, 3).join(", ")} inside an effect.`,
          help: "Compute the value during render when it is fully derived from render-known inputs.",
        });
      }
    }

    return diagnostics;
  },
};

export const noSelfUpdatingEffect: RuleDefinition = {
  id: "react-luau/no-self-updating-effect",
  category: "Effects",
  severity: "warning",
  description: "Effects should not unconditionally update state that is also one of their dependencies.",
  run(context) {
    const diagnostics = [];

    for (const call of context.findCalls()) {
      const path = context.resolveCallPath(context.getCallPath(call) ?? "");
      if (!isEffectPath(path)) continue;
      const owner = ownerForHook(context, call);
      const parts = callbackAndDeps(context, call);
      if (!owner || !parts) continue;
      const deps = parseDependencyRoots(parts.deps);

      for (const binding of stateBindingsFor(context, owner)) {
        if (!deps.has(binding.valueName)) continue;
        for (const setterCall of directTopLevelCalls(context, parts.callback)) {
          if (context.getCallPath(setterCall) !== binding.setterName) continue;
          diagnostics.push({
            node: callNameNode(setterCall),
            message: `${binding.setterName}() updates ${binding.valueName}, which is also in this effect's dependency table.`,
            help: "Guard the update so it converges, move it to the originating event, or derive the value during render.",
          });
        }
      }
    }

    return diagnostics;
  },
};

export const noEffectWithFreshDeps: RuleDefinition = {
  id: "react-luau/no-effect-with-fresh-deps",
  category: "Hooks",
  severity: "error",
  description: "Dependency tables should not contain tables or functions recreated on every render.",
  run(context) {
    const diagnostics = [];

    for (const call of context.findCalls()) {
      const path = context.resolveCallPath(context.getCallPath(call) ?? "");
      if (!HOOKS_WITH_DEPS.has(path)) continue;
      const owner = ownerForHook(context, call);
      const parts = callbackAndDeps(context, call);
      if (!owner || !parts) continue;

      for (const dependency of dependencyExpressions(parts.deps)) {
        const kind = freshDependencyKind(dependency, owner);
        if (!kind) continue;
        const label = dependency.type === "identifier" ? ` ${dependency.text}` : "";
        diagnostics.push({
          node: dependency,
          message: `${path} depends on${label || " an inline value"} that is a new ${kind} on every render.`,
          help: "Move the value inside the hook callback and depend on its simple inputs, or intentionally stabilize the value with useMemo/useCallback when identity is part of the contract.",
        });
      }
    }

    return diagnostics;
  },
};

export const noMutableInDeps: RuleDefinition = {
  id: "react-luau/no-mutable-in-deps",
  category: "Hooks",
  severity: "error",
  description: "Mutable ref.current values do not belong in hook dependency tables.",
  run(context) {
    const diagnostics = [];

    for (const call of context.findCalls()) {
      const path = context.resolveCallPath(context.getCallPath(call) ?? "");
      if (!HOOKS_WITH_DEPS.has(path)) continue;
      const owner = ownerForHook(context, call);
      const parts = callbackAndDeps(context, call);
      if (!owner || !parts) continue;
      const refs = context.model.refVariablesByFunction.get(nodeKey(owner.node)) ?? new Set<string>();

      for (const dependency of dependencyExpressions(parts.deps)) {
        const root = rootIdentifier(dependency.text);
        if (!root || !refs.has(root)) continue;
        if (!new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\.\\s*current\\b`).test(dependency.text.trim())) continue;
        diagnostics.push({
          node: dependency,
          message: `${dependency.text.trim()} is mutable ref state and will not itself trigger a React render when it changes.`,
          help: "Read ref.current inside the hook body. Depend on reactive inputs that actually cause renders instead of listing the mutable current value.",
        });
      }
    }

    return diagnostics;
  },
};
