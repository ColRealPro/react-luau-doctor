import { reactApiPath, resolveLocalFunction } from "../ast/local-values";
import type { RuleDefinition } from "../types";
import { callNameNode } from "./helpers";

export const useMemoMustReturn: RuleDefinition = {
  id: "react-luau/usememo-must-return",
  category: "Correctness",
  severity: "warning",
  description: "Memo calculations must return their computed value",

  guidance: {
    explanation:
      "A memo callback without a returned value makes useMemo return nil",
    help: "Return the calculated value — use an effect if the callback is intended to perform a side effect",
  },

  run(context) {
    return context.findCalls().flatMap((call) => {
      if (reactApiPath(context, call) !== "React.useMemo") return [];

      const argument = context.callArguments(call)[0];
      const callback = argument && resolveLocalFunction(context, argument);

      if (!callback?.body) return [];

      const returnsValue = [...context.walk(callback.body)].some(
        (node) =>
          node.type === "return_statement" &&
          context.nearestFunction(node) === callback &&
          node.namedChildren.some(
            (child) =>
              child.type === "expression_list" &&
              child.namedChildren.length > 0,
          ),
      );

      if (returnsValue) return [];

      return [
        {
          node: callNameNode(call),
          message: "This useMemo callback returns no value",
          help: "Return the computed value from the memo callback",
        },
      ];
    });
  },
};
