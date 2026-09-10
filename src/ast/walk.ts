import type { SyntaxNode } from "../syntax";

export function walk(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  const stack = [node];

  while (stack.length > 0) {
    const current = stack.pop()!;
    result.push(current);

    const children = current.namedChildren;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }

  return result;
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


export function parameterBindingNames(parameters: SyntaxNode | null | undefined): string[] {
  if (!parameters) return [];
  const result: string[] = [];
  for (const parameter of parameters.namedChildren) {
    if (parameter.type !== "parameter") continue;
    const identifier = parameter.namedChildren.find((child) => child.type === "identifier");
    if (identifier) result.push(identifier.text);
  }
  return [...new Set(result)];
}

export function rootIdentifier(text: string): string | null {
  const match = text.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  return match?.[1] ?? null;
}

export function normalizeExpressionText(text: string): string {
  return text.replace(/\s+/g, "").replace(/^\((.*)\)$/s, "$1");
}

export function nodeKey(node: SyntaxNode): number {
  return node.id;
}

export function sameNode(left: SyntaxNode | null | undefined, right: SyntaxNode | null | undefined): boolean {
  return Boolean(left && right && nodeKey(left) === nodeKey(right));
}
