import type { SyntaxNode } from "../syntax";
import type { FunctionInfo, RuleContext } from "../types";
import { apiReferenceForCall } from "../api-reference";
import {
  resolveLocalFunction,
  resolveLocalValue,
  unwrapExpression,
} from "./local-values";

export type FreshValueKind = "table" | "function" | "object";

// Follow result expressions only: a fresh argument does not make its call result fresh
// The lifetime changes when inspecting a factory, but module values stay stable
export function freshValueKind(
  context: RuleContext,
  expression: SyntaxNode | null,
  lifetime: FunctionInfo,
  seen = new Set<number>(),
  returnIndex = 0,
  lifetimes = new Set([lifetime]),
): FreshValueKind | null {
  if (!expression) return null;

  const node = unwrapExpression(expression);

  if (seen.has(node.id) || seen.size >= 64) return null;

  const visited = new Set(seen).add(node.id);

  const analyze = (
    value: SyntaxNode | null,
    owner = lifetime,
    index = 0,
  ): FreshValueKind | null =>
    freshValueKind(
      context,
      value,
      owner,
      visited,
      index,
      new Set(lifetimes).add(owner),
    );

  if (node.type === "identifier") {
    const binding = resolveLocalValue(context, node);
    const owner = binding && context.nearestFunction(binding.value);

    if (!binding || !owner || !lifetimes.has(owner)) return null;

    return analyze(binding.value, lifetime, binding.returnIndex);
  }

  if (returnIndex === 0) {
    if (node.type === "table_constructor") return "table";

    if (
      node.type === "function_definition" ||
      node.type === "function_declaration"
    )
      return "function";

    if (node.type === "binary_expression") {
      const operator = node.children.find((child) =>
        ["and", "or"].includes(child.type),
      )?.type;

      if (operator === "and") return analyze(node.childForFieldName("right"));

      if (operator === "or")
        return (
          analyze(node.childForFieldName("left")) ??
          analyze(node.childForFieldName("right"))
        );
    }

    if (node.type === "if_expression") {
      for (const branch of [
        node,
        ...node.namedChildren.filter((child) =>
          ["elseif_clause", "else_clause"].includes(child.type),
        ),
      ]) {
        const kind = analyze(branch.childForFieldName("consequence"));

        if (kind) return kind;
      }
    }
  }

  if (node.type !== "function_call") return null;

  const api = apiReferenceForCall(context, node);

  if (api && returnIndex === 0) {
    if (api.allocation === "argument")
      return analyze(
        context.callArguments(node)[api.argumentIndex ?? 0] ?? null,
      );

    if (api.equality !== "reference") return null;

    return api.returnType === "table" || api.returnType === "function"
      ? api.returnType
      : "object";
  }

  const name = node.childForFieldName("name");
  const factory = name && resolveLocalFunction(context, name);

  if (!factory?.body) return null;

  for (const statement of context.walk(factory.body)) {
    if (
      statement.type !== "return_statement" ||
      context.nearestFunction(statement) !== factory
    )
      continue;

    const values =
      statement.namedChildren.find((child) => child.type === "expression_list")
        ?.namedChildren ?? [];
    const value = values[returnIndex] ?? values.at(-1);

    if (!value) continue;

    const index = Math.max(0, returnIndex - values.length + 1);

    if (index > 0 && value.type !== "function_call") continue;

    const kind = analyze(value, factory, index);

    if (kind) return kind;
  }

  return null;
}
