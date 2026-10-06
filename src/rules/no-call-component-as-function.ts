import {
  reactApiPath,
  resolveLocalFunction,
  resolveLocalValue,
} from "../ast/local-values";
import type { RuleDefinition } from "../types";
import { callNameNode } from "./helpers";

export const noCallComponentAsFunction: RuleDefinition = {
  id: "react-luau/no-call-component-as-function",
  category: "Correctness",
  severity: "warning",

  description:
    "Render components with React.createElement instead of calling them directly",

  guidance: {
    explanation:
      "A direct call gives the child no separate component identity and runs its hooks as part of the caller",

    help: "Pass the component function and its props to React.createElement",
  },

  run(context) {
    const components = new Set<number>();
    const returnsElement = new Set<number>();

    for (const node of context.walk()) {
      if (node.type !== "return_statement") continue;

      const expression = node.namedChildren.find(
        (child) => child.type === "expression_list",
      )?.namedChildren[0];
      const returned = expression && resolveLocalValue(context, expression);
      const owner = context.nearestFunction(node);

      if (
        owner &&
        returned?.returnIndex === 0 &&
        returned.value.type === "function_call" &&
        reactApiPath(context, returned.value) === "React.createElement"
      )
        returnsElement.add(owner.node.id);
    }

    for (const call of context.findCalls()) {
      if (reactApiPath(context, call) === "React.createElement") {
        const argument = context.callArguments(call)[0];
        const component = argument && resolveLocalFunction(context, argument);

        if (component) components.add(component.node.id);
      }

      const owner = context.nearestFunction(call);

      if (
        owner?.isComponent &&
        returnsElement.has(owner.node.id) &&
        /^React\.use[A-Z]/.test(reactApiPath(context, call) ?? "")
      )
        components.add(owner.node.id);
    }

    return context.findCalls().flatMap((call) => {
      const name = call.childForFieldName("name");
      const component = name && resolveLocalFunction(context, name);

      if (!component || !components.has(component.node.id)) return [];

      return [
        {
          node: callNameNode(call),
          message: `${name!.text} is called directly instead of rendered as a component`,
          help: "Use React.createElement(component, props) so React owns the component's hooks and identity",
        },
      ];
    });
  },
};
