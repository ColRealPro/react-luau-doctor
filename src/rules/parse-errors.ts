import type { Node as SyntaxNode } from "web-tree-sitter";
import type { RuleDefinition } from "../types";

const REQUIRED_CLOSERS = new Map<string, string>([
  ["parameters", ")"],
  ["arguments", ")"],
  ["table_constructor", "}"],
]);

const TYPE_SYNTAX_ANCESTORS = new Set([
  "type_definition",
  "type_annotation",
  "type_parameters",
  "generic_type",
  "function_type",
  "optional_type",
  "object_type",
  "union_type",
  "intersection_type",
  "tuple_type",
  "singleton_type",
  "variadic_type",
  "variadic_type_pack",
]);

function incompleteDelimitedNode(node: SyntaxNode): string | null {
  const closer = REQUIRED_CLOSERS.get(node.type);
  if (!closer) return null;
  return node.text.trimEnd().endsWith(closer) ? null : closer;
}

function isBundledGrammarTypeGap(node: SyntaxNode): boolean {
  let current: SyntaxNode | null = node;
  while (current) {
    if (TYPE_SYNTAX_ANCESTORS.has(current.type)) {
      if (current.type !== "type_definition") return true;
      if (/^\s*(?:export\s+)?type\s+[A-Za-z_][A-Za-z0-9_]*/s.test(current.text)) return true;
    }
    current = current.parent;
  }
  return false;
}

export const parseErrors: RuleDefinition = {
  id: "react-luau/parse-error",
  category: "Correctness",
  severity: "error",
  description: "Report executable Luau syntax that the bundled parser cannot form into a complete syntax tree.",
  run(context) {
    const diagnostics = [];
    const covered: Array<{ start: number; end: number }> = [];

    for (const node of context.walk()) {
      const missingCloser = incompleteDelimitedNode(node);
      if (!node.isError && !node.isMissing && !missingCloser) continue;
      if (isBundledGrammarTypeGap(node)) continue;
      if (covered.some((range) => node.startIndex >= range.start && node.endIndex <= range.end)) continue;
      covered.push({ start: node.startIndex, end: node.endIndex });

      let message = "Luau syntax could not be parsed cleanly at this location.";
      if (node.isMissing) message = `Luau syntax is missing ${node.type}.`;
      else if (missingCloser) message = `Luau syntax is missing closing ${missingCloser}.`;

      diagnostics.push({
        node,
        message,
        help: "Fix the syntax error before relying on downstream React-Luau diagnostics in this file.",
      });
    }

    return diagnostics;
  },
};
