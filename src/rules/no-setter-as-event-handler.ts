import {
  reactApiPath,
  resolveLocalValue,
  unwrapExpression,
} from "../ast/local-values";
import { normalizeExpressionText } from "../ast/walk";
import type { SyntaxNode } from "../syntax";
import type { DiagnosticInput, RuleContext, RuleDefinition } from "../types";
import { fieldValue } from "./helpers";

const SETTER_HOOKS = new Set(["React.useState", "React.useBinding"]);

interface HandlerKey {
  node: SyntaxNode;
  kind: "Change" | "Event";
  member: string;
}

function handlerKey(context: RuleContext, field: SyntaxNode): HandlerKey | null {
  const name = field.childForFieldName("name");
  const key = name && unwrapExpression(name);
  if (key?.type !== "dot_index_expression") return null;

  const container = key.childForFieldName("table");
  const member = key.childForFieldName("field")?.text;
  if (!container || !member) return null;

  const resolved = resolveLocalValue(context, container);
  if (!resolved || resolved.returnIndex !== 0) return null;

  const path = context.resolveCallPath(
    normalizeExpressionText(resolved.value.text),
  );
  if (path === "React.Change") return { node: key, kind: "Change", member };
  if (path === "React.Event") return { node: key, kind: "Event", member };
  return null;
}

function isStateOrBindingSetter(context: RuleContext, value: SyntaxNode): boolean {
  const resolved = resolveLocalValue(context, value);
  if (!resolved || resolved.returnIndex !== 1) return false;
  if (resolved.value.type !== "function_call") return false;

  const path = reactApiPath(context, resolved.value);
  return path !== null && SETTER_HOOKS.has(path);
}

export const noSetterAsEventHandler: RuleDefinition = {
  id: "react-luau/no-setter-as-event-handler",
  category: "Correctness",
  severity: "error",
  description: "State and binding setters should not be passed directly as React.Change or React.Event handlers",

  guidance: {
    explanation:
      "React-Luau calls Change and Event handlers with the Instance as the first argument, so a setter passed directly stores the Instance instead of a value",
    help: "Wrap the setter in a function that reads the value you want from the Instance",
  },

  run(context) {
    const diagnostics: DiagnosticInput[] = [];

    for (const field of context.model.allNodes) {
      if (field.type !== "field") continue;

      const value = fieldValue(field);
      if (value?.type !== "identifier") continue;

      const key = handlerKey(context, field);
      if (!key || !isStateOrBindingSetter(context, value)) continue;

      const setter = value.text;
      const handler =
        key.kind === "Change"
          ? `function(rbx)\n\t${setter}(rbx.${key.member})\nend`
          : `function(rbx)\n\t${setter}(nextValue)\nend`;

      diagnostics.push({
        node: value,
        message:
          key.kind === "Change"
            ? `${setter} receives the changed Instance, not its ${key.member} value`
            : `${setter} receives the Instance that fired ${key.member}, not an event value`,
        help:
          key.kind === "Change"
            ? `Read the property from the Instance: function(rbx) ${setter}(rbx.${key.member}) end`
            : "Wrap the setter in a function and pass the value you want to store",
        fixPreview: {
          before: `[${key.node.text}] = ${setter},`,
          after: `[${key.node.text}] = ${handler},`,
          note: "React-Luau passes the Instance as the first handler argument",
          kind: key.kind === "Change" ? "exact" : "pattern",
        },
      });
    }

    return diagnostics;
  },
};
