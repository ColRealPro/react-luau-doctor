import { resolveLocalFunction } from "../ast/local-values";
import type { SyntaxNode } from "../syntax";
import type { DiagnosticInput, RuleContext, RuleDefinition } from "../types";
import { fieldName, fieldNameNode, fieldValue } from "./helpers";

function hostClassName(element: SyntaxNode | undefined): string | null {
  if (element?.type !== "string" || element.namedChildren.some((child) => child.type === "interpolation")) return null;

  return element.text.slice(1, -1);
}

function isFunctionValue(context: RuleContext, value: SyntaxNode): boolean {
  if (value.type === "function_definition") return true;

  return value.type === "identifier" && resolveLocalFunction(context, value) !== null;
}

export const noFunctionHostProp: RuleDefinition = {
  id: "react-luau/no-function-host-prop",
  category: "Roblox",
  severity: "error",
  description: "Host elements should connect functions through React.Event or React.Change instead of plain props",

  guidance: {
    explanation:
      "React-Luau assigns plain props on host elements straight to the Instance, and Roblox throws when a property or event is assigned a function",
    help: "Connect events with [React.Event.Name] and property changes with [React.Change.Name]",
  },

  run(context) {
    const diagnostics: DiagnosticInput[] = [];

    for (const call of context.findCalls()) {
      if (context.resolveCallPath(context.getCallPath(call) ?? "") !== "React.createElement") continue;

      const [element, props] = context.callArguments(call);
      const className = hostClassName(element);
      if (!className || props?.type !== "table_constructor") continue;

      for (const field of props.namedChildren) {
        const name = fieldName(field);
        const value = fieldValue(field);

        // Callback refs are the one function a host element accepts as a plain prop
        if (!name || name === "ref" || !value || !isFunctionValue(context, value)) continue;

        diagnostics.push({
          node: fieldNameNode(field),
          message: `${name} is set to a function, which Roblox cannot assign to a ${className}`,
          help: `Use [React.Event.${name}] if ${name} is an event, or [React.Change.${name}] to listen for a property change`,
          fixPreview: {
            kind: "pattern",
            before: `${name} = function(rbx)`,
            after: `[React.Event.${name}] = function(rbx)`,
            note: "React-Luau connects React.Event and React.Change keys to the Instance's signals",
          },
        });
      }
    }

    return diagnostics;
  },
};
