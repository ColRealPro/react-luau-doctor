import type { RuleDefinition } from "../types";
import { assignmentLeft, assignmentTargetNode, isNameShadowedBetween } from "./helpers";

export const noPropMutation: RuleDefinition = {
  id: "react-luau/no-prop-mutation",
  category: "Correctness",
  severity: "error",
  description: "Component props should be treated as immutable inputs.",
  run(context) {
    const diagnostics = [];

    for (const node of context.walk()) {
      if (node.type !== "assignment_statement" && node.type !== "update_statement") continue;
      const component = context.containingComponent(node);
      if (!component || !context.isDirectlyExecutedInFunction(node, component)) continue;

      const propsName = component.parameters[0];
      if (!propsName) continue;
      if (isNameShadowedBetween(node, component, propsName)) continue;
      const left = assignmentLeft(node.text);
      const escaped = propsName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`^${escaped}\\s*(?:\\.|\\[)`).test(left)) continue;

      diagnostics.push({
        node: assignmentTargetNode(node),
        message: `Component mutates ${propsName} directly.`,
        help: "Treat props as immutable. Derive a local value, clone a table you own, or update state in the owner instead.",
      });
    }

    return diagnostics;
  },
};
