import { reactApiPath, resolveLocalValue } from "../ast/local-values";
import { normalizeRequireTarget, resolveModuleReference } from "../module-resolution";
import type { SyntaxNode } from "../syntax";
import type { DiagnosticInput, RuleContext, RuleDefinition } from "../types";
import { fieldName, fieldNameNode, fieldValue } from "./helpers";

type RefTarget = "drops" | "forwards" | "unknown";

function refTarget(context: RuleContext, expression: SyntaxNode, seen = new Set<number>()): RefTarget {
  if (seen.has(expression.id)) return "unknown";

  seen.add(expression.id);

  const resolved = resolveLocalValue(context, expression);
  if (!resolved || resolved.returnIndex !== 0) return "unknown";

  const value = resolved.value;
  if (context.model.functionByNode.has(value.id)) return "drops";
  if (value.type !== "function_call") return "unknown";

  const path = reactApiPath(context, value);
  if (path === "React.forwardRef") return "forwards";

  const argument = context.callArguments(value)[0];
  if (!argument) return "unknown";

  if (path === "React.memo") return refTarget(context, argument, seen);

  if (context.getCallPath(value) !== "require") return "unknown";

  const summary = resolveModuleReference(normalizeRequireTarget(argument.text), context.project.componentExports);
  if (!summary) return "unknown";

  return summary.forwardsRef ? "forwards" : "drops";
}

export const noRefOnFunctionComponent: RuleDefinition = {
  id: "react-luau/no-ref-on-function-component",
  category: "Correctness",
  severity: "error",
  description: "Refs passed to function components are dropped unless the component uses React.forwardRef",

  guidance: {
    explanation:
      "React-Luau takes ref out of props before calling a function component, so the ref is never set unless the component forwards it",
    help: "Wrap the component in React.forwardRef and pass the ref to the Instance it should point to",
  },

  run(context) {
    const diagnostics: DiagnosticInput[] = [];

    for (const call of context.findCalls()) {
      if (context.resolveCallPath(context.getCallPath(call) ?? "") !== "React.createElement") continue;

      const [element, props] = context.callArguments(call);
      if (!element || element.type === "string" || props?.type !== "table_constructor") continue;

      const refField = props.namedChildren.find((field) => fieldName(field) === "ref");
      if (!refField || !fieldValue(refField) || refTarget(context, element) !== "drops") continue;

      const component = element.sourceText.trim();

      diagnostics.push({
        node: fieldNameNode(refField),
        message: `${component} is a function component without React.forwardRef, so this ref is never set`,
        help: `Wrap ${component} in React.forwardRef and pass the ref to the Instance it should point to`,
        fixPreview: {
          kind: "pattern",
          before: `local ${component} = function(props)
\treturn React.createElement("Frame", {})
end`,
          after: `local ${component} = React.forwardRef(function(props, ref)
\treturn React.createElement("Frame", { ref = ref })
end)`,
          note: "forwardRef passes the parent's ref as the second argument",
        },
      });
    }

    return diagnostics;
  },
};
