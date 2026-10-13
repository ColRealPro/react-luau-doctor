import { reactApiPath } from "../ast/local-values";
import type { RuleDefinition } from "../types";
import { callNameNode } from "./helpers";

const MEMO_HOOKS = new Set(["React.useMemo", "React.useCallback"]);

// A trailing call or `...` passes all its return values, so the dependency table may be hidden inside it
const EXPANDING_ARGUMENT = new Set(["function_call", "vararg_expression"]);

export const noMemoWithoutDeps: RuleDefinition = {
  id: "react-luau/no-memo-without-deps",
  category: "Hooks",
  severity: "warning",
  description: "useMemo and useCallback need a dependency table to keep their result between renders",

  guidance: {
    explanation:
      "Without a dependency table, useMemo recomputes and useCallback returns a new function on every render",
    help: "Pass a dependency table listing the values the callback reads, or remove the hook if a stable result is not needed",
  },

  run(context) {
    return context.findCalls().flatMap((call) => {
      const path = reactApiPath(context, call);
      if (!path || !MEMO_HOOKS.has(path)) return [];

      const args = context.callArguments(call);
      const last = args.at(-1);
      if (!last || EXPANDING_ARGUMENT.has(last.type)) return [];

      const deps = args[1];
      if (deps && deps.type !== "nil") return [];

      const hook = path.slice("React.".length);
      return [
        {
          node: callNameNode(call),
          message:
            hook === "useMemo"
              ? "useMemo has no dependency table, so it recomputes on every render"
              : "useCallback has no dependency table, so it returns a new function on every render",
          help: "Pass a dependency table listing the values the callback reads, or remove the hook if a stable result is not needed",
        },
      ];
    });
  },
};
