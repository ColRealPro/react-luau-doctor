import type { Node as SyntaxNode } from "web-tree-sitter";
import type { FunctionInfo, RuleContext, SourceFile } from "../types";
import { nodeKey, normalizeExpressionText, walk } from "./walk";

export function createRuleContext(file: SourceFile): RuleContext {
  // Most rules traverse the same AST repeatedly. Materialize the root traversal
  // once and memoize subtree traversals so rule execution shares that work.
  const allNodes = [...walk(file.root)];
  const calls = allNodes.filter((node) => node.type === "function_call");
  const traversalCache = new Map<string, SyntaxNode[]>([[nodeKey(file.root), allNodes]]);
  const callPathCache = new Map<string, string | null>();
  const resolvedCallPathCache = new Map<string, string>();
  const nearestFunctionCache = new Map<string, FunctionInfo | null>();
  const componentCache = new Map<string, FunctionInfo | null>();

  const traversal = (node: SyntaxNode): SyntaxNode[] => {
    const key = nodeKey(node);
    const existing = traversalCache.get(key);
    if (existing) return existing;
    const result = [...walk(node)];
    traversalCache.set(key, result);
    return result;
  };

  const getCallPath = (node: SyntaxNode): string | null => {
    if (node.type !== "function_call") return null;
    const key = nodeKey(node);
    if (callPathCache.has(key)) return callPathCache.get(key) ?? null;
    const name = node.childForFieldName("name");
    const result = name ? normalizeExpressionText(name.text) : null;
    callPathCache.set(key, result);
    return result;
  };

  const resolveCallPath = (value: string): string => {
    const normalized = normalizeExpressionText(value);
    const cached = resolvedCallPathCache.get(normalized);
    if (cached) return cached;

    const direct = file.model.aliases.get(normalized);
    if (direct) {
      resolvedCallPathCache.set(normalized, direct);
      return direct;
    }

    const namespaceMatch = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)\.(.+)$/);
    let result = normalized;
    if (namespaceMatch && file.model.reactNamespaces.has(namespaceMatch[1])) {
      result = `React.${namespaceMatch[2]}`;
    } else if (namespaceMatch && file.model.reactRobloxNamespaces.has(namespaceMatch[1])) {
      result = `ReactRoblox.${namespaceMatch[2]}`;
    }
    resolvedCallPathCache.set(normalized, result);
    return result;
  };

  const callArguments = (node: SyntaxNode): SyntaxNode[] => {
    return node.childForFieldName("arguments")?.namedChildren ?? [];
  };

  const nearestFunction = (node: SyntaxNode): FunctionInfo | null => {
    const key = nodeKey(node);
    if (nearestFunctionCache.has(key)) return nearestFunctionCache.get(key) ?? null;
    let current = node.parent;
    while (current) {
      const info = file.model.functionByNode.get(nodeKey(current));
      if (info) {
        nearestFunctionCache.set(key, info);
        return info;
      }
      current = current.parent;
    }
    nearestFunctionCache.set(key, null);
    return null;
  };

  const containingComponent = (node: SyntaxNode): FunctionInfo | null => {
    const key = nodeKey(node);
    if (componentCache.has(key)) return componentCache.get(key) ?? null;
    let current = node.parent;
    while (current) {
      const info = file.model.functionByNode.get(nodeKey(current));
      if (info?.isComponent) {
        componentCache.set(key, info);
        return info;
      }
      current = current.parent;
    }
    componentCache.set(key, null);
    return null;
  };

  const isDirectlyExecutedInFunction = (node: SyntaxNode, fn: FunctionInfo): boolean => nearestFunction(node) === fn;

  return {
    ...file,
    findCalls: () => calls,
    getCallPath,
    resolveCallPath,
    callArguments,
    nearestFunction,
    containingComponent,
    isDirectlyExecutedInFunction,
    walk: (node = file.root) => traversal(node),
  };
}
