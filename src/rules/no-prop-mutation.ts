import type { RuleDefinition } from "../types";
import { assignmentLeft, assignmentTargetNode, callNameNode, isBindingShadowedBetween } from "./helpers";
import { mightMutateParameters, mutatedParameterIndexesForCall, mutationOriginForExpression } from "./parameter-mutations";

function isRefCurrent(target: string): boolean {
  return /\.\s*current$/.test(target.trim());
}

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
        if (!component) continue;

        const propsName = component.parameters[0];
        if (!propsName) continue;
        if (isBindingShadowedBetween(node, component, propsName)) continue;
        const left = assignmentLeft(node.text);
        const escaped = propsName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (!new RegExp(`^${escaped}\\s*(?:\\.|\\[)`).test(left)) continue;

        if (isRefCurrent(left)) {
          diagnostics.push({
            node: assignmentTargetNode(node),
            message: `Component writes to a ref passed through ${propsName}`,
            help: "Wrap the component in React.forwardRef so the parent can pass a normal ref, or pass the Instance to the parent through a callback prop",
          });
          continue;
        }

        diagnostics.push({
          node: assignmentTargetNode(node),
          message: `Component mutates ${propsName} directly.`,
          help: "Treat props as immutable. Derive a local value, clone a table you own, or update state in the owner instead.",
        });
        continue;
      }

      if (node.type !== "function_call" || !mightMutateParameters(context, node)) continue;
      const component = context.containingComponent(node);
      if (!component) continue;
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
        help: isRefCurrent(mutatedArgument.text)
          ? "Give the parent a callback prop that registers the value and returns a function to unregister it, then call that function from the effect cleanup"
          : "Treat props as immutable. Clone the table before passing it to a mutating helper, or move the mutation into the owner that controls the value.",
      });
    }

    return diagnostics;
  },
};
