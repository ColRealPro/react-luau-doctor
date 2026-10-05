import type { SyntaxNode } from "../syntax";
import type { RuleContext, RuleDefinition } from "../types";
import { assignmentLeft, fieldName, fieldValue } from "./helpers";
import { collectionKeyKindResolver, isUnshadowedBuiltin, type CollectionKeyKind } from "./collection-key-kind";

function loopIdentity(
  context: RuleContext,
  loop: SyntaxNode,
  kindFor: (expression: SyntaxNode, site: SyntaxNode) => CollectionKeyKind,
): { index: string; kind: CollectionKeyKind } | null {
  const numeric = loop.text.match(/^\s*for\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/s);
  if (numeric) return { index: numeric[1], kind: "array" };
  const clause = loop.namedChildren.find((child) => child.type === "for_generic_clause");
  const variables = clause?.namedChildren.find((child) => child.type === "variable_list")?.namedChildren;
  if (!variables || variables.length < 2) return null;
  let collection = clause?.namedChildren.find((child) => child.type === "expression_list")?.namedChildren[0];
  if (!collection) return null;
  if (collection.type === "function_call") {
    const path = context.getCallPath(collection);
    if (path === "ipairs" && isUnshadowedBuiltin(collection, "ipairs")) return { index: variables[0].text, kind: "array" };
    if (path === "pairs" && isUnshadowedBuiltin(collection, "pairs")) collection = context.callArguments(collection)[0];
  }
  return collection ? { index: variables[0].text, kind: kindFor(collection, loop) } : null;
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
    let resolveKind: ReturnType<typeof collectionKeyKindResolver> | undefined;
    const kindFor = (expression: SyntaxNode, site: SyntaxNode): CollectionKeyKind =>
      (resolveKind ??= collectionKeyKindResolver(context))(expression, site);

    for (const node of context.walk()) {
      if (node.type !== "for_statement") continue;
      const identity = loopIdentity(context, node, kindFor);
      if (!identity || identity.kind === "dictionary") continue;
      const { index, kind } = identity;
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
        message: kind === "array"
          ? `Loop index ${index} is used as React child identity.`
          : `Loop key ${index} may be an array position used as React child identity.`,
        ...(kind === "unknown" ? {
          explanation: "This collection's key type could not be established. Luau generic iteration can yield either array positions or dictionary keys.",
          caveat: "A stable dictionary key is valid child identity. Review this only if the loop key represents the item's current position.",
        } : {}),
        help: "Use a stable item key when children can be inserted, removed, reordered, or kept alive for exit animation.",
      });
    }

    return diagnostics;
  },
};
