import type { SyntaxNode } from "../syntax";
import type { DiagnosticInput, FunctionInfo, RuleContext, RuleDefinition, StateBinding } from "../types";
import { sameNode } from "../ast/walk";
import { assignmentTargetNode, callNameNode, containsUnshadowedIdentifier, identifierNode, isBindingShadowedBetween, stateBindingsFor } from "./helpers";
import { mightMutateParameters, mutatedParameterIndexesForCall, mutationOriginForExpression } from "./parameter-mutations";

const TRIVIAL_INITIALIZER_PATHS = new Set([
  "tostring",
  "tonumber",
  "type",
  "typeof",
  "math.abs",
  "math.ceil",
  "math.floor",
  "math.max",
  "math.min",
  "math.round",
  "string.lower",
  "string.upper",
  "string.format",
  "table.pack",
  "Vector2.new",
  "Vector3.new",
  "Vector2int16.new",
  "Vector3int16.new",
  "UDim.new",
  "UDim2.new",
  "UDim2.fromOffset",
  "UDim2.fromScale",
  "CFrame.new",
  "Color3.new",
  "Color3.fromRGB",
  "Color3.fromHSV",
  "Rect.new",
  "NumberRange.new",
  "TweenInfo.new",
]);

function isTrivialInitializerPath(path: string): boolean {
  return TRIVIAL_INITIALIZER_PATHS.has(path) || /(?:^|[.:])getValue$/i.test(path);
}

function isNestedFunctionFromOwner(context: RuleContext, node: SyntaxNode, owner: FunctionInfo): boolean {
  const nearest = context.nearestFunction(node);
  return Boolean(nearest && nearest !== owner);
}

function callsSetter(context: RuleContext, owner: FunctionInfo, setterName: string): boolean {
  if (!owner.body) return false;
  for (const call of context.walk(owner.body)) {
    if (call.type === "function_call" && context.getCallPath(call) === setterName) return true;
  }
  return false;
}

function isIdentifierRead(node: SyntaxNode, name: string): boolean {
  if (node.type !== "identifier" || node.text !== name) return false;
  const parent = node.parent;
  if (parent?.type === "dot_index_expression" && sameNode(parent.childForFieldName("field"), node)) return false;
  if (parent?.type === "method_index_expression" && sameNode(parent.namedChildren.at(-1), node)) return false;
  return true;
}

function renderReachableNestedFunctions(context: RuleContext, owner: FunctionInfo): Set<FunctionInfo> {
  const reachable = new Set<FunctionInfo>();
  if (!owner.body) return reachable;

  const byName = new Map<string, FunctionInfo>();
  for (const fn of context.model.functions) {
    if (!fn.name || fn === owner) continue;
    let current = fn.node.parent;
    while (current) {
      const parentInfo = context.model.functionByNode.get(current.id);
      if (parentInfo) {
        if (parentInfo === owner) byName.set(fn.name, fn);
        break;
      }
      current = current.parent;
    }
  }

  const pending: FunctionInfo[] = [];
  const addByName = (name: string | undefined) => {
    if (!name) return;
    const fn = byName.get(name);
    if (!fn || reachable.has(fn)) return;
    reachable.add(fn);
    pending.push(fn);
  };

  for (const call of context.walk(owner.body)) {
    if (call.type !== "function_call" || context.nearestFunction(call) !== owner) continue;
    const path = context.getCallPath(call) ?? "";
    const resolved = context.resolveCallPath(path);
    if (resolved === "React.createElement") addByName(context.callArguments(call)[0]?.text.trim());
    else addByName(path);
  }

  while (pending.length > 0) {
    const fn = pending.pop()!;
    if (!fn.body) continue;
    for (const call of context.walk(fn.body)) {
      if (call.type !== "function_call" || context.nearestFunction(call) !== fn) continue;
      const path = context.getCallPath(call) ?? "";
      const resolved = context.resolveCallPath(path);
      if (resolved === "React.createElement") addByName(context.callArguments(call)[0]?.text.trim());
      else addByName(path);
    }
  }

  return reachable;
}

function directlyReadsValue(context: RuleContext, owner: FunctionInfo, binding: StateBinding): boolean {
  if (!owner.body) return false;

  for (const node of context.walk(owner.body)) {
    if (!isIdentifierRead(node, binding.valueName)) continue;
    if (node.startIndex >= binding.declaration.startIndex && node.endIndex <= binding.declaration.endIndex) continue;
    if (isNestedFunctionFromOwner(context, node, owner)) continue;
    if (isBindingShadowedBetween(node, owner, binding.valueName, binding.declaration)) continue;
    return true;
  }

  for (const fn of renderReachableNestedFunctions(context, owner)) {
    if (!fn.body) continue;
    for (const node of context.walk(fn.body)) {
      if (isIdentifierRead(node, binding.valueName) && !isBindingShadowedBetween(node, owner, binding.valueName, binding.declaration)) return true;
    }
  }

  return false;
}

function isPlainTableState(binding: StateBinding, context: RuleContext): boolean {
  const initializer = binding.initializer;
  if (!initializer) return true;
  if (initializer.type === "table_constructor") return true;
  if (initializer.type !== "function_call") return false;
  const path = context.getCallPath(initializer) ?? "";
  return path === "table.clone" || path === "table.create" || path === "table.pack";
}

type CallbackLifetime = "long-lived" | "custom-hook" | "render-handler" | "unknown";

function callbackLifetime(context: RuleContext, call: SyntaxNode, owner: FunctionInfo): CallbackLifetime {
  const callback = context.nearestFunction(call);
  if (!callback || callback === owner) return "unknown";

  let current: SyntaxNode | null = callback.node;
  while (current && current.startIndex >= owner.node.startIndex && current.endIndex <= owner.node.endIndex) {
    if (current.type === "function_call") {
      const path = context.resolveCallPath(context.getCallPath(current) ?? "");
      if (
        path === "React.useEffect"
        || path === "React.useLayoutEffect"
        || path === "task.spawn"
        || path === "task.defer"
        || path === "task.delay"
        || /:Connect$/.test(path)
        || /BindToRenderStep$/.test(path)
        || /:BindAction(?:AtPriority)?$/.test(path)
        || /:BindActivate$/.test(path)
      ) {
        return "long-lived";
      }
      if (path === "React.createElement") return "render-handler";
      const final = path.split(/[.:]/).at(-1) ?? "";
      if (/^use[A-Z0-9_]/.test(final)) return "custom-hook";
    }
    if (current.type === "function_definition" || current.type === "function_declaration") {
      if (current.startIndex !== callback.node.startIndex || current.endIndex !== callback.node.endIndex) break;
    }
    current = current.parent;
  }

  return "unknown";
}

export const rerenderFunctionalSetstate: RuleDefinition = {
  id: "react-luau/rerender-functional-setstate",
  category: "Performance",
  severity: "warning",
  description: "Use the functional state setter form when deferred callbacks update from the previous state value.",
  run(context) {
    const diagnostics: DiagnosticInput[] = [];

    for (const binding of context.model.stateBindings) {
      const owner = binding.owner;
      if (!owner?.body) continue;

      for (const call of context.walk(owner.body)) {
        if (call.type !== "function_call" || context.getCallPath(call) !== binding.setterName) continue;
        if (!isNestedFunctionFromOwner(context, call, owner)) continue;
        const argument = context.callArguments(call)[0];
        if (!argument || argument.type === "function_definition") continue;
        if (!containsUnshadowedIdentifier(argument, binding.valueName, context, owner)) continue;
        const lifetime = callbackLifetime(context, call, owner);
        if (lifetime === "render-handler" || lifetime === "unknown") continue;

        diagnostics.push({
          node: callNameNode(call),
          severity: lifetime === "custom-hook" ? "suggestion" : "warning",
          message: `${binding.setterName}() reads ${binding.valueName} from a captured callback value.`,
          help: lifetime === "custom-hook"
            ? `Use ${binding.setterName}(function(previous) return ... end) if the custom hook can retain this callback across renders.`
            : `Use ${binding.setterName}(function(previous) return ... end) when the next value depends on previous state.`,
        });
      }
    }

    return diagnostics;
  },
};

export const rerenderLazyStateInit: RuleDefinition = {
  id: "react-luau/rerender-lazy-state-init",
  category: "Performance",
  severity: "warning",
  description: "Expensive useState initializers should use React's lazy initializer form.",
  run(context) {
    const diagnostics = [];

    for (const call of context.findCalls()) {
      const path = context.resolveCallPath(context.getCallPath(call) ?? "");
      if (path !== "React.useState") continue;
      const initializer = context.callArguments(call)[0];
      if (!initializer || initializer.type === "function_definition") continue;

      const eagerCall = [...context.walk(initializer)].find((node) => node.type === "function_call");
      if (!eagerCall) continue;
      const eagerPath = context.resolveCallPath(context.getCallPath(eagerCall) ?? "");
      if (isTrivialInitializerPath(eagerPath) || /^React\.use[A-Z0-9_]/.test(eagerPath)) continue;

      diagnostics.push({
        node: callNameNode(eagerCall),
        message: `${eagerPath || "This initializer call"} is evaluated every render before useState can reuse the existing state.`,
        help: "Wrap expensive initial state creation in function() ... end so it only runs when the state is first initialized.",
      });
    }

    return diagnostics;
  },
};

export const rerenderLazyRefInit: RuleDefinition = {
  id: "react-luau/rerender-lazy-ref-init",
  category: "Performance",
  severity: "warning",
  description: "Avoid eagerly rebuilding expensive values passed to useRef on every render.",
  run(context) {
    const diagnostics = [];

    for (const call of context.findCalls()) {
      const path = context.resolveCallPath(context.getCallPath(call) ?? "");
      if (path !== "React.useRef") continue;
      const initializer = context.callArguments(call)[0];
      if (!initializer || initializer.type !== "function_call") continue;
      const eagerPath = context.resolveCallPath(context.getCallPath(initializer) ?? "");
      if (isTrivialInitializerPath(eagerPath) || /^React\.use[A-Z0-9_]/.test(eagerPath)) continue;

      diagnostics.push({
        node: callNameNode(initializer),
        message: `${eagerPath || "This initializer call"} is rebuilt before useRef returns the existing ref on every render.`,
        help: "Initialize the ref from a predictable nil-guarded render pattern when construction is pure, or create owned resources in an effect with cleanup. Do not put side-effectful resource creation into useRef just to silence this warning.",
      });
    }

    return diagnostics;
  },
};

export const rerenderStateOnlyInHandlers: RuleDefinition = {
  id: "react-luau/rerender-state-only-in-handlers",
  category: "Performance",
  severity: "warning",
  description: "State that is only read from callbacks may be mutable data rather than rendered state.",
  run(context) {
    const diagnostics = [];

    for (const owner of context.model.functions) {
      if (!owner.isComponent) continue;
      for (const binding of stateBindingsFor(context, owner)) {
        if (binding.valueName === "_" || binding.valueName.startsWith("_")) continue;
        if (/^(set)?(?:TriggerRender|ForceUpdate|Rerender|ForceRender|Tick|Bump|BumpVersion|InvalidateRender|Refresh|Repaint)$/i.test(binding.setterName)) continue;
        if (!callsSetter(context, owner, binding.setterName)) continue;
        if (directlyReadsValue(context, owner, binding)) continue;

        diagnostics.push({
          node: identifierNode(binding.declaration, binding.valueName) ?? binding.declaration,
          message: `${binding.valueName} is updated as React state but is never read by the component's render path or hook arguments.`,
          help: "When a value is only read by event or signal callbacks, consider useRef so updates do not rerender the component. Keep useState when the update intentionally invalidates rendering or feeds a hook dependency.",
        });
      }
    }

    return diagnostics;
  },
};

export const noDirectStateMutation: RuleDefinition = {
  id: "react-luau/no-direct-state-mutation",
  category: "Correctness",
  severity: "warning",
  description: "Do not mutate table state in place.",
  run(context) {
    const diagnostics = [];
    const seen = new Set<string>();

    for (const binding of context.model.stateBindings) {
      const owner = binding.owner;
      if (!owner?.body || !isPlainTableState(binding, context)) continue;
      const escaped = binding.valueName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      for (const node of context.walk(owner.body)) {
        if (node.startIndex >= binding.declaration.startIndex && node.endIndex <= binding.declaration.endIndex) continue;
        let mutates = false;

        if (node.type === "assignment_statement" || node.type === "update_statement") {
          mutates = new RegExp(`^\\s*${escaped}\\s*(?:\\.|\\[)`).test(node.text);
        } else if (node.type === "function_call" && mightMutateParameters(context, node)) {
          const arguments_ = context.callArguments(node);
          for (const index of mutatedParameterIndexesForCall(context, node, owner)) {
            const argument = arguments_[index];
            if (!argument) continue;
            const origin = mutationOriginForExpression(context, argument, owner);
            if (origin.kind === "state" && origin.binding === binding) {
              mutates = true;
              break;
            }
          }
        }

        if (!mutates || isBindingShadowedBetween(node, owner, binding.valueName, binding.declaration)) continue;
        const key = `${node.startIndex}:${binding.valueName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        diagnostics.push({
          node: node.type === "function_call" ? callNameNode(node) : assignmentTargetNode(node),
          message: `${binding.valueName} is React state backed by a table and is mutated in place.`,
          help: `Create a new table and pass the new identity to ${binding.setterName}. In-place mutation can leave React with the same state identity and makes update ordering harder to reason about.`,
        });
      }
    }

    return diagnostics;
  },
};
