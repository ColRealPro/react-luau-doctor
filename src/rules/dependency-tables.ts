import {
  reactApiPath,
  resolveLocalValue,
  unwrapExpression,
} from "../ast/local-values";
import type { SyntaxNode } from "../syntax";
import type { RuleContext } from "../types";

export const HOOK_ARGUMENTS = new Map<
  string,
  { callbackIndex: number; depsIndex: number }
>([
  ["React.useEffect", { callbackIndex: 0, depsIndex: 1 }],
  ["React.useLayoutEffect", { callbackIndex: 0, depsIndex: 1 }],
  ["React.useMemo", { callbackIndex: 0, depsIndex: 1 }],
  ["React.useCallback", { callbackIndex: 0, depsIndex: 1 }],
  ["React.useImperativeHandle", { callbackIndex: 1, depsIndex: 2 }],
]);

const tableCache = new WeakMap<RuleContext, Map<number, SyntaxNode | null>>();

export function resolveDependencyTable(
  context: RuleContext,
  expression: SyntaxNode | undefined,
): SyntaxNode | null {
  if (!expression) return null;

  const resolved = resolveLocalValue(context, expression);

  if (
    !resolved ||
    resolved.returnIndex !== 0 ||
    resolved.value.type !== "table_constructor"
  )
    return null;

  const table = resolved.value;

  if (unwrapExpression(expression).id === table.id) return table;

  let cache = tableCache.get(context);

  if (!cache) {
    cache = new Map();
    tableCache.set(context, cache);
  }

  if (cache.has(expression.id)) return cache.get(expression.id) ?? null;

  const refersToTable = (node: SyntaxNode) =>
    resolveLocalValue(context, node)?.value.id === table.id;
  let result: SyntaxNode | null = table;

  // Resolving a local proves its initial value, not that its contents stayed unchanged
  for (const node of context.walk()) {
    if (
      node.startIndex <= table.endIndex ||
      node.startIndex >= expression.startIndex
    )
      continue;

    if (
      node.type === "assignment_statement" ||
      node.type === "update_statement"
    ) {
      const targets =
        node.namedChildren.find((child) => child.type === "variable_list")
          ?.namedChildren ?? [];

      if (
        targets.some(
          (target) =>
            ["dot_index_expression", "bracket_index_expression"].includes(
              target.type,
            ) &&
            target.namedChildren[0] &&
            refersToTable(target.namedChildren[0]),
        )
      ) {
        result = null;
        break;
      }
    }

    if (node.type !== "function_call") continue;

    const name = node.childForFieldName("name");
    const receiver =
      name?.type === "method_index_expression" ? name.namedChildren[0] : null;
    const shape = HOOK_ARGUMENTS.get(reactApiPath(context, node) ?? "");
    const args = context.callArguments(node);

    if (
      (receiver && refersToTable(receiver)) ||
      args.some(
        (arg, index) => refersToTable(arg) && index !== shape?.depsIndex,
      )
    ) {
      result = null;
      break;
    }
  }

  cache.set(expression.id, result);

  return result;
}
