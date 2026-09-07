import type { SyntaxNode } from "../syntax";
import type { RuleContext, RuleDefinition } from "../types";
import { assignmentLeft, fieldName, fieldValue } from "./helpers";

function loopIndex(text: string): string | null {
  const numeric = text.match(/^\s*for\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/s);
  if (numeric) return numeric[1];

  const generic = text.match(/^\s*for\s+([A-Za-z_][A-Za-z0-9_]*)\s*,/s);
  const candidate = generic?.[1] ?? null;
  // Single-letter keys are frequently dictionary keys in Luau, not array positions.
  return candidate && /^(?:idx|index|position)$/i.test(candidate) ? candidate : null;
}

function assignmentAncestor(call: SyntaxNode, loop: SyntaxNode): SyntaxNode | null {
  let current = call.parent;
  while (current && current.startIndex >= loop.startIndex && current.endIndex <= loop.endIndex) {
    if (current.type === "assignment_statement") return current;
    if (current.type === "function_definition" || current.type === "function_declaration") return null;
    current = current.parent;
  }
  return null;
}

function createElementCallsInLoop(context: RuleContext, loop: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (const node of context.walk(loop)) {
    if (node.type !== "function_call") continue;
    const path = context.resolveCallPath(context.getCallPath(node) ?? "");
    if (path === "React.createElement") result.push(node);
  }
  return result;
}

export const noArrayIndexAsKey: RuleDefinition = {
  id: "react-luau/no-array-index-as-key",
  category: "Correctness",
  severity: "suggestion",
  description: "Review dynamic React children that use their current array position as identity.",
  run(context) {
    const diagnostics = [];

    for (const node of context.walk()) {
      if (node.type !== "for_statement") continue;
      const index = loopIndex(node.text);
      if (!index) continue;
      const escaped = index.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const keyProp = new RegExp(`\\bkey\\s*=\\s*${escaped}\\b`);
      const indexedTarget = new RegExp(`\\[\\s*${escaped}\\s*\\]\\s*$`);

      const highlights: SyntaxNode[] = [];
      for (const call of createElementCallsInLoop(context, node)) {
        const props = context.callArguments(call)[1];
        if (props?.type === "table_constructor" && keyProp.test(props.text)) {
          const keyField = props.namedChildren.find((field) =>
            field.type === "field" && fieldName(field) === "key" && fieldValue(field)?.text.trim() === index
          );
          highlights.push(fieldValue(keyField ?? props) ?? keyField ?? props);
        }

        const assignment = assignmentAncestor(call, node);
        if (assignment && indexedTarget.test(assignmentLeft(assignment.text))) {
          const indexNode = [...context.walk(assignment)].find((candidate) =>
            candidate.type === "identifier" && candidate.text === index && candidate.startIndex < call.startIndex
          );
          highlights.push(indexNode ?? assignment);
        }
      }

      if (highlights.length === 0) continue;
      diagnostics.push({
        node: highlights[0],
        highlights,
        message: `Loop index ${index} is used as React child identity.`,
        help: "Use a stable item key when children can be inserted, removed, reordered, or kept alive for exit animation.",
      });
    }

    return diagnostics;
  },
};
