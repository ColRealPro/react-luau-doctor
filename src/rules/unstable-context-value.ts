import type { RuleDefinition } from "../types";
import { fieldName, fieldNameNode, fieldValue } from "./helpers";

export const unstableContextValue: RuleDefinition = {
  id: "react-luau/unstable-context-value",
  category: "Performance",
  severity: "warning",
  description: "Avoid recreating context value tables on every provider render when identity matters.",
  run(context) {
    const diagnostics = [];

    for (const call of context.findCalls()) {
      const component = context.containingComponent(call);
      if (!component || !context.isDirectlyExecutedInFunction(call, component)) continue;
      const path = context.resolveCallPath(context.getCallPath(call) ?? "");
      if (path !== "React.createElement") continue;
      const args = context.callArguments(call);
      const element = args[0]?.text ?? "";
      const props = args[1];
      if (!/\.Provider$/.test(element) || !props || props.type !== "table_constructor") continue;
      const valueField = props.namedChildren.find((field) =>
        field.type === "field" && fieldName(field) === "value" && fieldValue(field)?.type === "table_constructor"
      );
      if (!valueField) continue;

      diagnostics.push({
        node: fieldNameNode(valueField),
        message: "Context Provider receives a new inline value table on every render.",
        help: "Memoize the provider value from its real dependencies when consumer updates depend on object identity.",
      });
    }

    return diagnostics;
  },
};
