import type { RuleDefinition } from "../types";
import { callNameNode, isBindingShadowedBetween, stateBindingsFor } from "./helpers";

export const noSetStateInRender: RuleDefinition = {
  id: "react-luau/no-set-state-in-render",
  category: "Correctness",
  severity: "warning",
  description: "Do not call a component's state setter unconditionally during render.",
  run(context) {
    const diagnostics = [];

    for (const component of context.model.functions) {
      if (!component.isComponent || !component.body) continue;
      const bindings = stateBindingsFor(context, component);
      const setters = new Map(bindings.map((binding) => [binding.setterName, binding]));
      if (setters.size === 0) continue;

      for (const statement of component.body.namedChildren) {
        if (statement.type !== "function_call") continue;
        const path = context.getCallPath(statement);
        const binding = path ? setters.get(path) : undefined;
        if (!path || !binding || isBindingShadowedBetween(statement, component, path, binding.declaration)) continue;

        diagnostics.push({
          node: callNameNode(statement),
          message: `${path}() is called unconditionally during component render.`,
          help: "Move the update to the event or effect that owns it, or derive the value during render. An unconditional render-phase state update can continuously trigger new renders.",
        });
      }
    }

    return diagnostics;
  },
};
