import type { SyntaxNode } from "../syntax";
import type { RuleContext } from "../types";
import { simpleTypeAliases } from "../parser-compat";
import { assignmentLeft, declarationNames } from "./helpers";

export type CollectionKeyKind = "array" | "dictionary" | "unknown";

export function isUnshadowedBuiltin(site: SyntaxNode, name: string): boolean {
  for (let current = site.parent; current; current = current.parent) {
    if (current.type === "block" || current.type === "chunk") {
      if (current.namedChildren.some((statement) => statement.startIndex < site.startIndex && (
        (statement.type === "variable_declaration" && declarationNames(statement).includes(name)) ||
        (statement.type === "function_declaration" && statement.childForFieldName("name")?.text === name) ||
        (statement.type === "assignment_statement" && assignmentLeft(statement.text) === name)
      ))) return false;
    }
    if (current.type === "function_definition" || current.type === "function_declaration") {
      if (current.childForFieldName("parameters")?.namedChildren.some((parameter) => parameter.namedChildren[0]?.text === name)) return false;
    }
    if (current.type === "for_statement") {
      const variables = current.namedChildren.find((child) => child.type === "for_generic_clause")
        ?.namedChildren.find((child) => child.type === "variable_list");
      if (variables?.namedChildren.some((variable) => variable.text === name)) return false;
    }
  }
  return true;
}

// These are local syntax hints, not a replacement for Luau type checking.
export function collectionKeyKindResolver(context: RuleContext): (expression: SyntaxNode, site: SyntaxNode) => CollectionKeyKind {
  const scopes = [...context.walk()].filter((node) => node.type === "block" || node.type === "chunk");
  const writes = [...context.walk()].filter((node) => node.type === "assignment_statement" && node.parent?.type !== "variable_declaration");
  const aliases = simpleTypeAliases(context.source).map((alias) => ({
    ...alias,
    // Compatibility parsing masks aliases. A function's first alias can
    // therefore precede the parser's reported body start.
    scope: scopes.filter((scope) => (scope.startIndex <= alias.startIndex ||
      ((scope.parent?.type === "function_definition" || scope.parent?.type === "function_declaration") &&
        (scope.parent.childForFieldName("parameters")?.endIndex ?? scope.startIndex) < alias.startIndex)) && scope.endIndex > alias.startIndex)
      .sort((a, b) => b.startIndex - a.startIndex)[0] ?? context.root,
  }));

  function enclosingScopes(site: SyntaxNode): SyntaxNode[] {
    const result = [];
    for (let current: SyntaxNode | null = site; current; current = current.parent) {
      if (current.type === "block" || current.type === "chunk") result.push(current);
    }
    return result;
  }

  function typeKind(text: string, fields: string[], site: SyntaxNode, seen = new Set<string>()): CollectionKeyKind {
    const type = text.trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(type)) {
      if (seen.has(type)) return "unknown";
      seen.add(type);
      for (const scope of enclosingScopes(site)) {
        const alias = aliases.filter((entry) => entry.name === type && entry.scope.id === scope.id && entry.startIndex < site.startIndex).at(-1);
        if (alias) return typeKind(alias.type, fields, site, seen);
      }
      return "unknown";
    }
    if (!type.startsWith("{") || !type.endsWith("}")) return "unknown";
    const body = type.slice(1, -1);
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < body.length; index += 1) {
      const char = body[index];
      if ("{[(<".includes(char)) depth += 1;
      else if ("}])>".includes(char)) depth -= 1;
      if (depth < 0) return "unknown";
      if (depth === 0 && (char === "," || char === ";")) {
        parts.push(body.slice(start, index).trim());
        start = index + 1;
      }
    }
    if (depth !== 0) return "unknown";
    parts.push(body.slice(start).trim());
    const entries = parts.filter(Boolean);
    if (fields.length > 0) {
      const field = entries.map((entry) => entry.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+)$/))
        .find((entry) => entry?.[1] === fields[0]);
      return field ? typeKind(field[2], fields.slice(1), site, new Set(seen)) : "unknown";
    }
    if (entries.some((entry) => /^\[\s*string\s*\]\s*:/.test(entry)) &&
      entries.every((entry) => /^\[\s*string\s*\]\s*:/.test(entry) || /^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(entry))) return "dictionary";
    // Numeric indexers can also describe maps keyed by stable numeric IDs.
    if (entries.some((entry) => /^\[/.test(entry))) return "unknown";
    if (entries.length > 0 && entries.every((entry) => /^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(entry))) return "dictionary";
    if (entries.length === 1 && !entries[0].includes(":")) return "array";
    return "unknown";
  }

  function resolve(expression: SyntaxNode, site: SyntaxNode, seen = new Set<number>()): CollectionKeyKind {
    if (seen.has(expression.id)) return "unknown";
    seen.add(expression.id);
    if (expression.type === "table_constructor") {
      const fields = expression.namedChildren.filter((node) => node.type === "field");
      if (fields.length === 0) return "unknown";
      if (fields.every((field) => !field.childForFieldName("name"))) return "array";
      if (fields.every((field) => ["identifier", "string"].includes(field.childForFieldName("name")?.type ?? ""))) return "dictionary";
      return "unknown";
    }
    if (expression.type === "function_call" && context.getCallPath(expression) === "table.clone" && isUnshadowedBuiltin(expression, "table")) {
      const source = context.callArguments(expression)[0];
      return source ? resolve(source, site, seen) : "unknown";
    }
    const path = expression.text.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)(\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*$/);
    if (!path) return "unknown";
    const [name, ...fields] = expression.text.replace(/\s+/g, "").split(".");
    for (let current: SyntaxNode | null = site; current; current = current.parent) {
      if (current.type === "block" || current.type === "chunk") {
        for (const statement of [...current.namedChildren].reverse()) {
          if (statement.startIndex >= site.startIndex) continue;
          if (statement.type === "assignment_statement" && assignmentLeft(statement.text) === name) return "unknown";
          if (statement.type !== "variable_declaration" || !declarationNames(statement).includes(name)) continue;
          if (writes.some((write) => write.startIndex > statement.endIndex && write.startIndex < site.startIndex &&
            write.startIndex >= current.startIndex && write.endIndex <= current.endIndex &&
            context.nearestFunction(write) === context.nearestFunction(site) &&
            assignmentLeft(write.text).match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1] === name)) return "unknown";
          // Multiple binding/type lists need proper type resolution; keep them uncertain.
          if (declarationNames(statement).length !== 1) return "unknown";
          const assignment = statement.namedChildren.find((child) => child.type === "assignment_statement");
          const variables = assignment?.namedChildren.find((child) => child.type === "variable_list");
          const annotation = variables?.text.match(/^[A-Za-z_][A-Za-z0-9_]*\s*:\s*([\s\S]+)$/)?.[1];
          if (annotation) return typeKind(annotation, fields, statement);
          if (fields.length > 0) return "unknown";
          const value = assignment?.namedChildren.find((child) => child.type === "expression_list")?.namedChildren[0];
          return value ? resolve(value, statement, seen) : "unknown";
        }
      }
      if (current.type === "function_definition" || current.type === "function_declaration") {
        const parameter = current.childForFieldName("parameters")?.namedChildren.find((child) =>
          child.namedChildren[0]?.text === name
        );
        if (parameter) {
          const annotation = parameter.text.match(/^[A-Za-z_][A-Za-z0-9_]*\s*:\s*([\s\S]+)$/)?.[1];
          return annotation ? typeKind(annotation, fields, current) : "unknown";
        }
      }
    }
    return "unknown";
  }
  return resolve;
}
