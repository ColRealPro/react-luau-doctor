import type { SyntaxNode } from "../syntax";
import type { FunctionInfo, RuleContext } from "../types";
import { normalizeExpressionText, parameterBindingNames } from "./walk";

interface LocalValue {
  value: SyntaxNode;
  returnIndex: number;
}

const valueCache = new WeakMap<RuleContext, Map<number, LocalValue | null>>();
const apiCache = new WeakMap<RuleContext, Map<number, string | null>>();

export function isUnboundIdentifier(
  context: RuleContext,
  node: SyntaxNode,
): boolean {
  return (
    node.type === "identifier" && visibleValue(context, node) === undefined
  );
}

export function localValueBinding(
  context: RuleContext,
  node: SyntaxNode,
): LocalValue | null | undefined {
  return node.type === "identifier" ? visibleValue(context, node) : null;
}

export function unwrapExpression(node: SyntaxNode): SyntaxNode {
  while (
    ["parenthesized_expression", "cast_expression"].includes(node.type) &&
    node.namedChildren[0]
  ) {
    node = node.namedChildren[0];
  }

  return node;
}

function assignedValue(
  statement: SyntaxNode,
  name: string,
): LocalValue | null | undefined {
  const assignment =
    statement.type === "variable_declaration"
      ? statement.namedChildren.find(
          (child) => child.type === "assignment_statement",
        )
      : statement;

  const variables = assignment?.namedChildren.find(
    (child) => child.type === "variable_list",
  );

  const expressions =
    assignment?.namedChildren.find((child) => child.type === "expression_list")
      ?.namedChildren ?? [];

  const index =
    variables?.namedChildren.findIndex(
      (child) => child.type === "identifier" && child.text === name,
    ) ?? -1;

  if (index < 0) return undefined;

  const value = expressions[index] ?? expressions.at(-1);

  if (!value) return null;

  const returnIndex = Math.max(0, index - expressions.length + 1);

  if (returnIndex > 0 && value.type !== "function_call") return null;

  return { value, returnIndex };
}

function visibleValue(
  context: RuleContext,
  node: SyntaxNode,
): LocalValue | null | undefined {
  const name = node.text;
  let current = node.parent;

  while (current) {
    if (
      ["function_definition", "function_declaration"].includes(current.type) &&
      parameterBindingNames(current.childForFieldName("parameters")).includes(
        name,
      )
    )
      return null;

    if (current.type === "for_statement") {
      const header = current.text.split(/\bdo\b/, 1)[0];

      const names = header
        .match(/^\s*for\s+(.+?)\s*(?:=|\bin\b)/s)?.[1]
        .split(",")
        .map((part) => part.trim());

      if (names?.includes(name)) return null;
    }

    if (current.type === "block" || current.id === context.root.id) {
      for (const child of [...current.namedChildren].reverse()) {
        if (child.startIndex >= node.startIndex) continue;

        if (
          child.type === "function_declaration" &&
          child.childForFieldName("name")?.text === name
        ) {
          return { value: child, returnIndex: 0 };
        }

        if (
          child.type === "variable_declaration" ||
          child.type === "assignment_statement"
        ) {
          if (child.endIndex > node.startIndex) continue;

          const value = assignedValue(child, name);

          if (value !== undefined) return value;
        } else if (
          child.endIndex < node.startIndex &&
          child.type !== "function_declaration"
        ) {
          // A conditional reassignment makes the earlier value uncertain
          for (const nested of context.walk(child)) {
            if (
              nested.type !== "assignment_statement" ||
              nested.parent?.type === "variable_declaration"
            )
              continue;

            if (
              context.nearestFunction(nested) !== context.nearestFunction(node)
            )
              continue;

            if (assignedValue(nested, name) !== undefined) return null;
          }
        }
      }
    }

    current = current.parent;
  }

  return undefined;
}

export function resolveLocalValue(
  context: RuleContext,
  expression: SyntaxNode,
  seen = new Set<number>(),
): LocalValue | null {
  const node = unwrapExpression(expression);

  if (seen.has(node.id)) return null;

  let cache = valueCache.get(context);

  if (!cache) {
    cache = new Map();
    valueCache.set(context, cache);
  }

  if (cache.has(node.id)) return cache.get(node.id) ?? null;

  seen.add(node.id);

  const binding =
    node.type === "identifier"
      ? visibleValue(context, node)
      : { value: node, returnIndex: 0 };

  const result = !binding
    ? null
    : binding.returnIndex > 0 || node.type !== "identifier"
      ? binding
      : resolveLocalValue(context, binding.value, seen);

  cache.set(node.id, result);

  return result;
}

export function resolveLocalFunction(
  context: RuleContext,
  expression: SyntaxNode,
): FunctionInfo | null {
  const resolved = resolveLocalValue(context, expression);

  if (!resolved || resolved.returnIndex !== 0) return null;

  return context.model.functionByNode.get(resolved.value.id) ?? null;
}

export function reactApiPath(
  context: RuleContext,
  call: SyntaxNode,
): string | null {
  let cache = apiCache.get(context);

  if (!cache) {
    cache = new Map();
    apiCache.set(context, cache);
  }

  if (cache.has(call.id)) return cache.get(call.id) ?? null;

  const result = resolveReactApiPath(context, call);
  cache.set(call.id, result);

  return result;
}

function resolveReactApiPath(
  context: RuleContext,
  call: SyntaxNode,
): string | null {
  const name = call.childForFieldName("name");

  if (!name) return null;

  const resolved = resolveLocalValue(context, name);

  if (!resolved || resolved.returnIndex !== 0) return null;

  const path = normalizeExpressionText(resolved.value.text);

  const match = path.match(
    /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/,
  );

  if (!match) return null;

  const namespace = resolved.value.namedChildren[0];

  if (!namespace) return null;

  const visible = visibleValue(context, namespace);

  if (visible === null) return null;

  const binding = resolveLocalValue(context, namespace);

  if (
    visible !== undefined &&
    (!binding || !/^require\s*\(.*\bReact\b.*\)$/s.test(binding.value.text))
  )
    return null;

  if (visible === undefined && !context.model.reactNamespaces.has(match[1]))
    return null;

  // An unbound React namespace is supported by the existing React model
  return `React.${match[2]}`;
}
