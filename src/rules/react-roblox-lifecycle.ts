import type { RuleDefinition } from "../types";
import { callNameNode } from "./helpers";

export const noCreateRootInRender: RuleDefinition = {
  id: "react-luau/no-create-root-in-render",
  category: "Roblox",
  severity: "error",
  description: "Do not create ReactRoblox roots during component render.",
  run(context) {
    const diagnostics = [];

    for (const call of context.findCalls()) {
      const path = context.resolveCallPath(context.getCallPath(call) ?? "");
      if (path !== "ReactRoblox.createRoot") continue;
      const owner = context.containingComponent(call);
      if (!owner || !context.isDirectlyExecutedInFunction(call, owner)) continue;
      diagnostics.push({
        node: callNameNode(call),
        message: "ReactRoblox.createRoot() is called during component render.",
        help: "Own top-level roots outside component render. When a component intentionally creates a separate root, create it in an effect and unmount that exact root in cleanup.",
      });
    }

    return diagnostics;
  },
};
