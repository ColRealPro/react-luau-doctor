import type { FixPreview, RuleDefinition } from "../types";
import { assignmentLeft, assignmentTargetNode, callNameNode, isBindingShadowedBetween } from "./helpers";
import { mightMutateParameters, mutatedParameterIndexesForCall, mutationOriginForExpression } from "./parameter-mutations";

function isRefCurrent(target: string): boolean {
  return /\.\s*current$/.test(target.trim());
}

function refPropName(target: string): string {
  return target.trim().match(/([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*current$/)?.[1] ?? "ref";
}

function forwardRefPreview(propsName: string, refName: string): FixPreview {
  return {
    kind: "pattern",
    before: `local function Child(${propsName})
\treturn React.createElement("Frame", {
\t\tref = function(instance)
\t\t\t${propsName}.${refName}.current = instance
\t\tend,
\t})
end`,
    after: `local Child = React.forwardRef(function(${propsName}, ref)
\treturn React.createElement("Frame", {
\t\tref = ref,
\t})
end)`,
    note: `The parent then passes its ref as ref instead of through the ${refName} prop. Pass the Instance through a callback prop instead if the parent only needs it at certain moments`,
  };
}

function registerPreview(argument: string): FixPreview {
  return {
    kind: "pattern",
    before: `React.useEffect(function()
\ttable.insert(${argument}, instance)
end, { instance })`,
    after: `React.useEffect(function()
\treturn props.register(instance)
end, { instance })`,
    note: "register adds the value in the parent and returns a function that removes it, so unmounted children leave the list",
  };
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
            fixPreview: forwardRefPreview(propsName, refPropName(left)),
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
      const refValue = isRefCurrent(mutatedArgument.text);

      diagnostics.push({
        node: callNameNode(node),
        highlights: [mutatedArgument],
        message: `${path} mutates an argument derived from ${propsName}.`,
        help: refValue
          ? "Give the parent a callback prop that registers the value and returns a function to unregister it, then call that function from the effect cleanup"
          : "Treat props as immutable. Clone the table before passing it to a mutating helper, or move the mutation into the owner that controls the value.",
        ...(refValue ? { fixPreview: registerPreview(mutatedArgument.sourceText.trim()) } : {}),
      });
    }

    return diagnostics;
  },
};
