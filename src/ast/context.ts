import type { SyntaxNode } from "../syntax";
import type { FunctionInfo, RuleContext, SourceFile } from "../types";
import { nodeKey, normalizeExpressionText, walk } from "./walk";

export function createRuleContext(file: SourceFile): RuleContext {
  // buildReactModel already materialized the root traversal. Reuse those node
  // wrappers here and only materialize subtrees lazily when a rule needs one.
  const allNodes = file.model.allNodes;
  const calls = allNodes.filter((node) => node.type === "function_call");
  const traversalCache = new Map<number, SyntaxNode[]>([[file.root.id, allNodes]]);
  const callPathCache = new Map<number, string | null>();
  const resolvedCallPathCache = new Map<string, string>();
  const nearestFunctionCache = new Map<number, FunctionInfo | null>();
  const componentCache = new Map<number, FunctionInfo | null>();

  const traversal = (node: SyntaxNode): SyntaxNode[] => {
    const key = node.id;
    const existing = traversalCache.get(key);
    if (existing) return existing;
    const result = walk(node);
    traversalCache.set(key, result);
    return result;
  };

  const getCallPath = (node: SyntaxNode): string | null => {
    if (node.type !== "function_call") return null;
    const key = node.id;
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
    const key = node.id;
    if (nearestFunctionCache.has(key)) return nearestFunctionCache.get(key) ?? null;

    const visited: number[] = [key];
    let current = node.parent;
    let result: FunctionInfo | null = null;
    while (current) {
      const info = file.model.functionByNode.get(nodeKey(current));
      if (info) {
        result = info;
        break;
      }
      if (nearestFunctionCache.has(current.id)) {
        result = nearestFunctionCache.get(current.id) ?? null;
        break;
      }
      visited.push(current.id);
      current = current.parent;
    }

    for (const visitedKey of visited) nearestFunctionCache.set(visitedKey, result);
    return result;
  };

  const containingComponent = (node: SyntaxNode): FunctionInfo | null => {
    const key = node.id;
    if (componentCache.has(key)) return componentCache.get(key) ?? null;

    const visited: number[] = [key];
    let current = node.parent;
    let result: FunctionInfo | null = null;
    while (current) {
      const info = file.model.functionByNode.get(nodeKey(current));
      if (info?.isComponent) {
        result = info;
        break;
      }
      if (componentCache.has(current.id)) {
        result = componentCache.get(current.id) ?? null;
        break;
      }
      visited.push(current.id);
      current = current.parent;
    }

    for (const visitedKey of visited) componentCache.set(visitedKey, result);
    return result;
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
