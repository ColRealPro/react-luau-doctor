import { resolveLocalFunction } from "../ast/local-values";
import type { SyntaxNode } from "../syntax";
import type { DiagnosticInput, RuleContext, RuleDefinition } from "../types";
import { fieldValue } from "./helpers";
import { handlerKey, isStateOrBindingSetter } from "./no-setter-as-event-handler";

// InputObject members that a GuiObject does not have, so reading them from the Instance throws
const INPUT_OBJECT_MEMBERS = new Set(["KeyCode", "UserInputType", "UserInputState", "Delta"]);
const VALUE_OPERATORS = new Set(["..", "+", "-", "*", "/", "//", "%", "^", "<", ">", "<=", ">="]);

function handlerFunction(context: RuleContext, value: SyntaxNode): SyntaxNode | null {
  if (value.type === "function_definition") return value;
  if (value.type !== "identifier") return null;

  return resolveLocalFunction(context, value)?.node ?? null;
}

function parameterNames(fn: SyntaxNode): string[] {
  return (fn.childForFieldName("parameters")?.namedChildren ?? [])
    .map((parameter) => parameter.namedChildren[0]?.text ?? parameter.text);
}

function isShadowed(node: SyntaxNode, handler: SyntaxNode, name: string): boolean {
  for (let current = node.parent; current && current.id !== handler.id; current = current.parent) {
    if (current.type !== "function_definition" && current.type !== "function_declaration") continue;
    if (parameterNames(current).includes(name)) return true;
  }

  return false;
}

function operatorOf(expression: SyntaxNode): string | undefined {
  return expression.children.find((child) => !expression.namedChildren.some((named) => named.id === child.id))?.type;
}

function misusedRead(
  context: RuleContext,
  handler: SyntaxNode,
  name: string,
  inputArgumentMissing: boolean,
): SyntaxNode | null {
  for (const node of context.walk(handler)) {
    if (node.type !== "identifier" || node.text !== name) continue;

    const parent = node.parent;
    if (!parent || parent.type === "parameter" || isShadowed(node, handler, name)) continue;

    if (parent.type === "arguments") {
      const callee = parent.parent?.childForFieldName("name");
      if (callee?.type === "identifier" && isStateOrBindingSetter(context, callee)) return node;
    }

    if (parent.type === "binary_expression") {
      const operator = operatorOf(parent) ?? "";
      if (VALUE_OPERATORS.has(operator)) return node;

      const other = parent.namedChildren.find((child) => child.id !== node.id);
      if ((operator === "==" || operator === "~=") && (other?.type === "string" || other?.type === "number")) return node;
    }

    if (parent.type === "unary_expression" && parent.text.trimStart().startsWith("#")) return node;

    if (
      inputArgumentMissing &&
      parent.type === "dot_index_expression" &&
      parent.namedChildren[0]?.id === node.id &&
      INPUT_OBJECT_MEMBERS.has(parent.namedChildren[1]?.text ?? "")
    )
      return node;
  }

  return null;
}

export const noInstanceAsEventValue: RuleDefinition = {
  id: "react-luau/no-instance-as-event-value",
  category: "Roblox",
  severity: "error",
  description: "React.Change and React.Event handlers receive the Instance first, not the changed value or event argument",

  guidance: {
    explanation:
      "React-Luau calls Change and Event handlers with the Instance as the first argument, followed by the signal's own arguments",
    help: "Read changed properties from the Instance, and take event arguments from the second parameter onward",
  },

  run(context) {
    const diagnostics: DiagnosticInput[] = [];

    for (const field of context.model.allNodes) {
      if (field.type !== "field") continue;

      const value = fieldValue(field);
      const key = value && handlerKey(context, field);
      const handler = key && handlerFunction(context, value);
      if (!key || !handler) continue;

      const parameters = parameterNames(handler);
      const instance = parameters[0];
      if (!instance || instance === "...") continue;

      const misuse = misusedRead(context, handler, instance, key.kind === "Event" && parameters.length === 1);
      if (!misuse) continue;

      diagnostics.push(
        key.kind === "Change"
          ? {
            node: misuse,
            message: `${instance} is the changed Instance, not its ${key.member} value`,
            help: `Read the property from the Instance, such as ${instance}.${key.member}`,
            fixPreview: {
              kind: "pattern" as const,
              before: `[React.Change.${key.member}] = function(${instance})
\tuse(${instance})
end,`,
              after: `[React.Change.${key.member}] = function(rbx)
\tuse(rbx.${key.member})
end,`,
              note: "React-Luau passes the Instance whose property changed",
            },
          }
          : {
            node: misuse,
            message: `${instance} is the Instance that fired ${key.member}, not an event argument`,
            help: `Event arguments start at the second parameter, such as function(rbx, ${instance})`,
            fixPreview: {
              kind: "pattern" as const,
              before: `[React.Event.${key.member}] = function(${instance})
\tuse(${instance})
end,`,
              after: `[React.Event.${key.member}] = function(rbx, ${instance})
\tuse(${instance})
end,`,
              note: "React-Luau passes the Instance first, then the signal's own arguments",
            },
          },
      );
    }

    return diagnostics;
  },
};
