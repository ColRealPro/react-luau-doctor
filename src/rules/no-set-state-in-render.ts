import type { RuleDefinition } from "../types";
import { reactApiPath, resolveLocalValue } from "../ast/local-values";

import { callNameNode, isUnconditionallyExecutedInFunction } from "./helpers";

export const noSetStateInRender: RuleDefinition = {
  id: "react-luau/no-set-state-in-render",
  category: "Correctness",
  severity: "warning",

  description:
    "Do not call a component's state setter unconditionally during render",

  run(context) {
    const diagnostics = [];

    for (const call of context.findCalls()) {
      const component = context.nearestFunction(call);

      if (!component?.isComponent) continue;

      const name = call.childForFieldName("name");
      const setter = name && resolveLocalValue(context, name);

      if (
        !setter ||
        setter.returnIndex !== 1 ||
        reactApiPath(context, setter.value) !== "React.useState" ||
        context.nearestFunction(setter.value) !== component ||
        !isUnconditionallyExecutedInFunction(context, call, component)
      )
        continue;

      diagnostics.push({
        node: callNameNode(call),
        message: `${name!.text}() is called unconditionally during component render`,
        summary: `${name!.text} runs during render and can loop`,
        help: "Move the update to the event or effect that owns it, or derive the value during render — an unconditional render-phase state update can continuously trigger new renders",
      });
    }

    return diagnostics;
  },
};
