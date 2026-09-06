import type { RuleDefinition } from "../types";
import { callNameNode } from "./helpers";

export const noCreateContextInRender: RuleDefinition = {
  id: "react-luau/no-create-context-in-render",
  category: "Correctness",
  severity: "error",
  description: "React contexts must have stable identity and should not be created during render.",
  run(context) {
    const diagnostics = [];

    for (const call of context.findCalls()) {
      const path = context.resolveCallPath(context.getCallPath(call) ?? "");
      if (path !== "React.createContext") continue;
      const owner = context.nearestFunction(call);
      if (!owner || (!owner.isComponent && !owner.isHook)) continue;
      if (!context.isDirectlyExecutedInFunction(call, owner)) continue;

      diagnostics.push({
        node: callNameNode(call),
        message: `React.createContext() is called during ${owner.isHook ? "hook" : "component"} render${owner.name ? ` in ${owner.name}` : ""}.`,
        help: "Create the context once at module scope so providers and consumers keep the same context identity.",
      });
    }

    return diagnostics;
  },
};
