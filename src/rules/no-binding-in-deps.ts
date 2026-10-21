import { resolveLocalFunction } from "../ast/local-values";
import type { SyntaxNode } from "../syntax";
import type { DiagnosticInput, RuleContext, RuleDefinition } from "../types";
import { isBinding } from "./binding-rules";
import { fieldValue } from "./helpers";

const DEPENDENCY_HOOKS = new Set(["React.useEffect", "React.useLayoutEffect", "React.useMemo", "React.useCallback"]);

function callbackNode(context: RuleContext, argument: SyntaxNode | undefined): SyntaxNode | null {
  if (!argument) return null;
  if (argument.type === "function_definition") return argument;
  if (argument.type !== "identifier") return null;

  return resolveLocalFunction(context, argument)?.node ?? null;
}

function readsBindingValue(context: RuleContext, callback: SyntaxNode, name: string): boolean {
  for (const node of context.walk(callback)) {
    if (node.type !== "function_call") continue;

    const method = node.childForFieldName("name");
    if (method?.type !== "method_index_expression") continue;

    if (method.namedChildren[0]?.text === name && method.namedChildren.at(-1)?.text === "getValue") return true;
  }

  return false;
}

export const noBindingInDeps: RuleDefinition = {
  id: "react-luau/no-binding-in-deps",
  category: "Hooks",
  severity: "warning",
  description: "Bindings keep the same identity when their value changes, so they cannot make a hook run again",

  guidance: {
    explanation:
      "A binding is one object for the component's lifetime. Listing it as a dependency never changes the dependencies, so a hook that reads binding:getValue() keeps its first value",
    help: "Map the binding for host properties with Binding:map, or keep the value in state if the hook must run again when it changes",
  },

  run(context) {
    const diagnostics: DiagnosticInput[] = [];

    for (const call of context.findCalls()) {
      const hook = context.resolveCallPath(context.getCallPath(call) ?? "");
      if (!DEPENDENCY_HOOKS.has(hook)) continue;

      const [callbackArgument, dependencies] = context.callArguments(call);
      const callback = callbackNode(context, callbackArgument);
      if (!callback || dependencies?.type !== "table_constructor") continue;

      for (const field of dependencies.namedChildren) {
        const value = fieldValue(field);
        if (value?.type !== "identifier" || !isBinding(context, value)) continue;
        if (!readsBindingValue(context, callback, value.text)) continue;

        diagnostics.push({
          node: value,
          message: `${value.text} is a binding, so this ${hook.replace("React.", "")} does not run again when ${value.text} changes`,
          help: "Map the binding for host properties with Binding:map, or keep the value in state if the hook must run again when it changes",
        });
      }
    }

    return diagnostics;
  },
};
