import type { SyntaxNode } from "../syntax";
import type { FunctionInfo, RuleContext, RuleDefinition } from "../types";
import { nodeKey, rootIdentifier } from "../ast/walk";
import { freshValueKind } from "../ast/value-identity";

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

function ownerForHook(
  context: RuleContext,
  call: SyntaxNode,
): FunctionInfo | null {
  const owner = context.nearestFunction(call);

  return owner && (owner.isComponent || owner.isHook) ? owner : null;
}

function effectCallbackWithoutDeps(
  context: RuleContext,
  call: SyntaxNode,
): SyntaxNode | null {
  const path = context.resolveCallPath(context.getCallPath(call) ?? "");

  if (!isEffectPath(path)) return null;

  const args = context.callArguments(call);
  const callback = args[0];

  if (callback?.type !== "function_definition") return null;

  if (args.length < 2 || args[1]?.type === "nil") return callback;

  return null;
}

function callbackAndDeps(
  context: RuleContext,
  call: SyntaxNode,
): { callback: SyntaxNode; deps: SyntaxNode } | null {
  const path = context.resolveCallPath(context.getCallPath(call) ?? "");
  const args = context.callArguments(call);

  if (path === "React.useImperativeHandle") {
    const callback = args[1];
    const deps = args[2];

    if (
      callback?.type === "function_definition" &&
      deps?.type === "table_constructor"
    )
      return { callback, deps };

    return null;
  }

  const callback = args[0];
  const deps = args[1];

  if (
    callback?.type === "function_definition" &&
    deps?.type === "table_constructor"
  )
    return { callback, deps };

  return null;
}

function directTopLevelCalls(
  context: RuleContext,
  callback: SyntaxNode,
): SyntaxNode[] {
  const info = functionInfoForNode(context, callback);

  if (!info?.body) return [];

  return info.body.namedChildren.filter(
    (child) => child.type === "function_call",
  );
}

function hasCall(node: SyntaxNode, context: RuleContext): boolean {
  for (const child of context.walk(node)) {
    if (child.type === "function_call") return true;
  }

  return false;
}

function hasExternalSubscription(
  node: SyntaxNode,
  context: RuleContext,
): boolean {
  for (const child of context.walk(node)) {
    if (child.type !== "function_call") continue;

    const path = context.getCallPath(child) ?? "";

    if (
      /:Connect$/.test(path) ||
      /BindToRenderStep$/.test(path) ||
      /:BindAction(?:AtPriority)?$/.test(path)
    )
      return true;
  }

  return false;
}

function setterCalledOutsideCallback(
  context: RuleContext,
  owner: FunctionInfo,
  callback: SyntaxNode,
  setterName: string,
): boolean {
  if (!owner.body) return false;

  for (const node of context.walk(owner.body)) {
    if (
      node.type !== "function_call" ||
      context.getCallPath(node) !== setterName
    )
      continue;

    if (
      node.startIndex >= callback.startIndex &&
      node.endIndex <= callback.endIndex
    )
      continue;

    return true;
  }

  return false;
}

function guaranteedRepeatedStateChange(
  argument: SyntaxNode,
  stateName: string,
  context: RuleContext,
): boolean {
  if (argument.type === "table_constructor") return true;

  if (argument.type === "function_definition") {
    const updater = functionInfoForNode(context, argument);
    const previousName = updater?.parameters[0];

    const returnStatement = updater?.body?.namedChildren.find(
      (child) => child.type === "return_statement",
    );

    const returnValue = returnStatement?.namedChildren[0];

    if (
      previousName &&
      returnValue &&
      guaranteedRepeatedStateChange(returnValue, previousName, context)
    )
      return true;

    return false;
  }

  const text = argument.text.trim();
  const escaped = stateName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  if (new RegExp(`^not\\s+${escaped}$`).test(text)) return true;

  if (
    new RegExp(
      `^${escaped}\\s*[+-]\\s*(?:[1-9]\\d*(?:\\.\\d+)?|0?\\.\\d*[1-9]\\d*)$`,
    ).test(text)
  )
    return true;

  if (
    new RegExp(
      `^(?:[1-9]\\d*(?:\\.\\d+)?|0?\\.\\d*[1-9]\\d*)\\s*\\+\\s*${escaped}$`,
    ).test(text)
  )
    return true;

  if (argument.type === "function_call") {
    const path = context.resolveCallPath(context.getCallPath(argument) ?? "");

    if (
      path === "table.clone" ||
      path === "table.create" ||
      path === "table.pack"
    )
      return true;
  }

  return false;
}

export const noDerivedStateEffect: RuleDefinition = {
  id: "react-luau/no-derived-state-effect",
  category: "Effects",
  severity: "warning",

  description:
    "Avoid copying render-known derived values into state from an effect.",

  guidance: {
    help: "Calculate the value during render and remove the state setter. Keep the effect only if it does other work. Keep state if the delay is intentional.",
  },

  run(context) {
    const diagnostics = [];

    for (const call of context.findCalls()) {
      const path = context.resolveCallPath(context.getCallPath(call) ?? "");

      if (!isEffectPath(path)) continue;

      const owner = ownerForHook(context, call);
      const parts = callbackAndDeps(context, call);

      if (!owner || !parts) continue;

      if (hasExternalSubscription(parts.callback, context)) continue;

      const available =
        context.model.componentLocals.get(nodeKey(owner.node)) ??
        new Set(owner.parameters);

      const bindings = stateBindingsFor(context, owner);

      const setterToValue = new Map(
        bindings.map((binding) => [binding.setterName, binding.valueName]),
      );

      for (const setterCall of directTopLevelCalls(context, parts.callback)) {
        const setter = context.getCallPath(setterCall) ?? "";
        const targetState = setterToValue.get(setter);

        if (!targetState) continue;

        // If the setter is also used by handlers or other effects, the state has independent
        // ownership and is not merely a render-known derived copy.
        if (setterCalledOutsideCallback(context, owner, parts.callback, setter))
          continue;

        const argument = context.callArguments(setterCall)[0];

        if (
          !argument ||
          argument.type === "function_definition" ||
          hasCall(argument, context)
        )
          continue;

        const sourceNames = [...available].filter(
          (name) =>
            name !== targetState &&
            containsUnshadowedIdentifier(argument, name, context, owner),
        );

        if (sourceNames.length === 0) continue;

        diagnostics.push({
          node: callNameNode(setterCall),
          message: `${setter}() stores a value derived from ${sourceNames.slice(0, 3).join(", ")} inside an effect.`,
          summary: `${targetState} can be calculated during render.`,
          explanation: `${setter} copies a value derived from ${sourceNames.slice(0, 3).join(", ")} into state after render.`,
          help: "Compute the value during render when it is fully derived from render-known inputs.",

          fixPreview: {
            kind: "pattern" as const,
            before: setterCall.text,
            after: `local ${targetState} = ${argument.text}`,
            note: "Remove the state pair and the setter call if the effect has no other work. Keep state when the delay is intentional.",
          },
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

  description:
    "Effects should not unconditionally update state in a way that schedules themselves again.",

  run(context) {
    const diagnostics = [];

    for (const call of context.findCalls()) {
      const path = context.resolveCallPath(context.getCallPath(call) ?? "");

      if (!isEffectPath(path)) continue;

      const owner = ownerForHook(context, call);

      if (!owner) continue;

      const parts = callbackAndDeps(context, call);

      if (parts) {
        const deps = parseDependencyRoots(parts.deps);

        for (const binding of stateBindingsFor(context, owner)) {
          if (!deps.has(binding.valueName)) continue;

          for (const setterCall of directTopLevelCalls(
            context,
            parts.callback,
          )) {
            if (context.getCallPath(setterCall) !== binding.setterName)
              continue;

            diagnostics.push({
              node: callNameNode(setterCall),
              message: `${binding.setterName}() updates ${binding.valueName}, which is also in this effect's dependency table.`,
              help: "Guard the update so it converges, move it to the originating event, or derive the value during render.",
            });
          }
        }

        continue;
      }

      const callback = effectCallbackWithoutDeps(context, call);

      if (!callback) continue;

      for (const binding of stateBindingsFor(context, owner)) {
        for (const setterCall of directTopLevelCalls(context, callback)) {
          if (context.getCallPath(setterCall) !== binding.setterName) continue;

          const argument = context.callArguments(setterCall)[0];

          if (
            !argument ||
            !guaranteedRepeatedStateChange(argument, binding.valueName, context)
          )
            continue;

          diagnostics.push({
            node: callNameNode(setterCall),
            message: `${binding.setterName}() unconditionally changes ${binding.valueName} in an effect that runs after every render.`,
            help: "Add a dependency table or convergence guard, move the update to the event that owns it, or derive the value during render.",
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

  description:
    "Dependency tables should not contain reference values recreated during render",

  run(context) {
    const diagnostics = [];

    for (const call of context.findCalls()) {
      const path = context.resolveCallPath(context.getCallPath(call) ?? "");

      if (!HOOKS_WITH_DEPS.has(path)) continue;

      const owner = ownerForHook(context, call);
      const parts = callbackAndDeps(context, call);

      if (!owner || !parts) continue;

      for (const dependency of dependencyExpressions(parts.deps)) {
        const kind = freshValueKind(context, dependency, owner);

        if (!kind) continue;

        const label =
          dependency.type === "identifier" ? ` ${dependency.text}` : "";

        diagnostics.push({
          node: dependency,
          message: `${path} depends on${label || " an inline value"} that can be a new ${kind} when the component renders`,
          help: "Move the value inside the hook callback and depend on its simple inputs, or intentionally stabilize the value with useMemo/useCallback when identity is part of the contract",
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

  description:
    "Mutable ref.current values do not belong in hook dependency tables.",

  run(context) {
    const diagnostics = [];

    for (const call of context.findCalls()) {
      const path = context.resolveCallPath(context.getCallPath(call) ?? "");

      if (!HOOKS_WITH_DEPS.has(path)) continue;

      const owner = ownerForHook(context, call);
      const parts = callbackAndDeps(context, call);

      if (!owner || !parts) continue;

      const refs =
        context.model.refVariablesByFunction.get(nodeKey(owner.node)) ??
        new Set<string>();

      for (const dependency of dependencyExpressions(parts.deps)) {
        const root = rootIdentifier(dependency.text);

        if (!root || !refs.has(root)) continue;

        if (
          !new RegExp(
            `^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\.\\s*current\\b`,
          ).test(dependency.text.trim())
        )
          continue;

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
