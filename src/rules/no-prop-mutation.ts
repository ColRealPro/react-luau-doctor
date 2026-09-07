import type { RuleDefinition } from "../types";
import { assignmentLeft, assignmentTargetNode, callNameNode, isBindingShadowedBetween } from "./helpers";
import { mightMutateParameters, mutatedParameterIndexesForCall, mutationOriginForExpression } from "./parameter-mutations";

export const noPropMutation: RuleDefinition = {
  id: "react-luau/no-prop-mutation",
  category: "Correctness",
  severity: "error",
  description: "Component props should be treated as immutable inputs.",
  run(context) {
    const diagnostics = [];

    for (const node of context.walk()) {
      if (node.type === "assignment_statement" || node.type === "update_statement") {
        const component = context.containingComponent(node);
        if (!component || !context.isDirectlyExecutedInFunction(node, component)) continue;

        const propsName = component.parameters[0];
        if (!propsName) continue;
        if (isBindingShadowedBetween(node, component, propsName)) continue;
        const left = assignmentLeft(node.text);
        const escaped = propsName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (!new RegExp(`^${escaped}\\s*(?:\\.|\\[)`).test(left)) continue;

        diagnostics.push({
          node: assignmentTargetNode(node),
          message: `Component mutates ${propsName} directly.`,
          help: "Treat props as immutable. Derive a local value, clone a table you own, or update state in the owner instead.",
        });
        continue;
      }

      if (node.type !== "function_call" || !mightMutateParameters(context, node)) continue;
      const component = context.containingComponent(node);
      if (!component || !context.isDirectlyExecutedInFunction(node, component)) continue;
      const propsName = component.parameters[0];
      if (!propsName) continue;

      const arguments_ = context.callArguments(node);
      const mutatedIndexes = mutatedParameterIndexesForCall(context, node, component);
      let mutatedArgument = null;
      for (const index of mutatedIndexes) {
        const argument = arguments_[index];
        if (!argument) continue;
        const origin = mutationOriginForExpression(context, argument, component);
        if (origin.kind !== "props" || origin.name !== propsName) continue;
        mutatedArgument = argument;
        break;
      }
      if (!mutatedArgument) continue;

      const path = context.resolveCallPath(context.getCallPath(node) ?? "") || "This call";
      diagnostics.push({
        node: callNameNode(node),
        highlights: [mutatedArgument],
        message: `${path} mutates an argument derived from ${propsName}.`,
        help: "Treat props as immutable. Clone the table before passing it to a mutating helper, or move the mutation into the owner that controls the value.",
      });
    }

    return diagnostics;
  },
};
