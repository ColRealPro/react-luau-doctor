import { reactApiPath, resolveLocalValue } from "../ast/local-values";
import { normalizeExpressionText } from "../ast/walk";
import type { SyntaxNode } from "../syntax";
import type { RuleContext, RuleDefinition } from "../types";
import { callNameNode } from "./helpers";

function isLazyRefInitialization(
  context: RuleContext,
  call: SyntaxNode,
): boolean {
  let node = call.parent;

  while (
    node &&
    !["function_definition", "function_declaration"].includes(node.type)
  ) {
    if (node.type === "if_statement") {
      const condition = node.childForFieldName("condition");
      const text = condition && normalizeExpressionText(condition.text);

      const match = text?.match(
        /^(?:([A-Za-z_]\w*)\.current==nil|nil==([A-Za-z_]\w*)\.current)$/,
      );

      if (!match) return false;

      const refName = match[1] ?? match[2];

      const ref =
        condition &&
        [...context.walk(condition)].find(
          (child) => child.type === "identifier" && child.text === refName,
        );

      const resolved = ref && resolveLocalValue(context, ref);

      if (!resolved || reactApiPath(context, resolved.value) !== "React.useRef")
        return false;

      let assignment = call.parent;

      while (assignment && assignment.id !== node.id) {
        if (assignment.type === "assignment_statement") {
          const target = assignment.namedChildren.find(
            (child) => child.type === "variable_list",
          )?.namedChildren[0];

          const thenBlock = node.namedChildren.find(
            (child) => child.type === "block",
          );

          return Boolean(
            target &&
            normalizeExpressionText(target.text) === `${refName}.current` &&
            thenBlock &&
            call.startIndex >= thenBlock.startIndex &&
            call.endIndex <= thenBlock.endIndex,
          );
        }

        assignment = assignment.parent;
      }

      return false;
    }

    node = node.parent;
  }

  return false;
}

export const noCreateBindingInRender: RuleDefinition = {
  id: "react-luau/no-create-binding-in-render",
  category: "Correctness",
  severity: "warning",
  description: "Preserve binding identity across function component renders",

  guidance: {
    explanation:
      "React.createBinding creates a new binding and initial value on every render",

    help: "Use React.useBinding to preserve the binding and updater across renders",
  },

  run(context) {
    return context.findCalls().flatMap((call) => {
      const owner = context.nearestFunction(call);

      if (
        !owner ||
        (!owner.isComponent && !owner.isHook) ||
        reactApiPath(context, call) !== "React.createBinding" ||
        isLazyRefInitialization(context, call)
      )
        return [];

      return [
        {
          node: callNameNode(call),
          message: "React.createBinding creates a new binding on every render",
          help: "Use React.useBinding so rerenders preserve the binding and its current value",
        },
      ];
    });
  },
};
