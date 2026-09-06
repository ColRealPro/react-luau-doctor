import type { Node as SyntaxNode } from "web-tree-sitter";
import type { RuleContext, RuleDefinition } from "../types";
import { fieldName, fieldValue } from "./helpers";

const FRESH_CALLS = [
  /^math\.random$/,
  /^Random\.new$/,
  /:GenerateGUID$/,
  /^DateTime\.now$/,
  /^os\.clock$/,
  /^tick$/,
  /^time$/,
  /:GetServerTimeNow$/,
  /:NextInteger$/,
  /:NextNumber$/,
];

function freshDescription(node: SyntaxNode, context: RuleContext): string | null {
  for (const child of context.walk(node)) {
    if (child.type !== "function_call") continue;
    const path = context.getCallPath(child) ?? "";
    if (FRESH_CALLS.some((pattern) => pattern.test(path)) || /Random\.new\s*\([^)]*\)\s*:\s*Next(?:Integer|Number)/s.test(child.text)) {
      return `${path || "fresh-value call"}()`;
    }
  }
  return null;
}

function isCreateElementCall(node: SyntaxNode | undefined, context: RuleContext): boolean {
  if (!node || node.type !== "function_call") return false;
  return context.resolveCallPath(context.getCallPath(node) ?? "") === "React.createElement";
}

export const noRandomKey: RuleDefinition = {
  id: "react-luau/no-random-key",
  category: "Correctness",
  severity: "error",
  description: "React child keys must not be regenerated on each render.",
  run(context) {
    const diagnostics = [];

    for (const field of context.walk()) {
      if (field.type !== "field") continue;
      const name = field.childForFieldName("name");
      let keyExpression: SyntaxNode | null = null;

      if (fieldName(field) === "key") {
        keyExpression = fieldValue(field);
      } else if (field.text.trim().startsWith("[") && name) {
        const value = field.namedChildren.find((child) => child.startIndex > name.endIndex);
        if (isCreateElementCall(value, context)) keyExpression = name;
      }

      if (!keyExpression) continue;
      const description = freshDescription(keyExpression, context);
      if (!description) continue;

      diagnostics.push({
        node: keyExpression,
        message: `React key is created from ${description}, so its identity can change every render.`,
        help: "Use stable identity from the item itself, such as UserId, an immutable record ID, or another persistent key. Changing keys remounts children and breaks preserved state or exit-animation identity.",
      });
    }

    return diagnostics;
  },
};
