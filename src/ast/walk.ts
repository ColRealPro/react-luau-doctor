import type { Node as SyntaxNode } from "web-tree-sitter";

export function* walk(node: SyntaxNode): Iterable<SyntaxNode> {
  yield node;
  for (const child of node.namedChildren) {
    yield* walk(child);
  }
}

export function ancestors(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  let current = node.parent;
  while (current) {
    result.push(current);
    current = current.parent;
  }
  return result;
}

export function nearestAncestor(node: SyntaxNode, predicate: (candidate: SyntaxNode) => boolean): SyntaxNode | null {
  let current = node.parent;
  while (current) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return null;
}

export function descendantsOfType(node: SyntaxNode, type: string): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (const candidate of walk(node)) {
    if (candidate.type === type) result.push(candidate);
  }
  return result;
}

export function rootIdentifier(text: string): string | null {
  const match = text.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  return match?.[1] ?? null;
}

export function normalizeExpressionText(text: string): string {
  return text.replace(/\s+/g, "").replace(/^\((.*)\)$/s, "$1");
}

export function nodeKey(node: SyntaxNode): string {
  return `${node.type}:${node.startIndex}:${node.endIndex}`;
}

export function sameNode(left: SyntaxNode | null | undefined, right: SyntaxNode | null | undefined): boolean {
  return Boolean(left && right && nodeKey(left) === nodeKey(right));
}
