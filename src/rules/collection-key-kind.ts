import type { SyntaxNode } from "../syntax";
import type { RuleContext } from "../types";
import { resolveLocalFunction } from "../ast/local-values";
import { variableListTargets } from "../ast/walk";
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
      if (variableListTargets(variables).some((variable) => variable.text === name)) return false;
    }
  }
  return true;
}

// These are local syntax hints, not a replacement for Luau type checking.
export function collectionKeyKindResolver(context: RuleContext): (expression: SyntaxNode, site: SyntaxNode) => CollectionKeyKind {
  const writes = [...context.walk()].filter((node) => node.type === "assignment_statement" && node.parent?.type !== "variable_declaration");

  const aliases = [...context.walk()].flatMap((node) => {
    if (node.type !== "type_definition") return [];

    // Generic aliases have no `=` directly after their name and stay unresolved
    const name = node.childForFieldName("name");
    const equals = node.children.find((child) => child.type === "=");
    const type = equals ? node.childForFieldName("value") : null;

    if (!name || !type || !node.parent) return [];

    return [{ name: name.text, type: type.text, startIndex: node.startIndex, scope: node.parent }];
  });

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

  function rootName(target: string): string | undefined {
    return target.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
  }

  function isInstanceFromChildren(expression: SyntaxNode): boolean {
    if (expression.type !== "identifier") return false;

    for (let current = expression.parent; current; current = current.parent) {
      if (current.type !== "for_statement") continue;

      const clause = current.namedChildren.find((child) => child.type === "for_generic_clause");
      const variables = variableListTargets(clause?.namedChildren.find((child) => child.type === "variable_list"));
      if (!variables.some((variable) => variable.text === expression.text)) continue;
      if (variables[1]?.text !== expression.text) return false;

      const collection = clause?.namedChildren.find((child) => child.type === "expression_list")?.namedChildren[0];
      return Boolean(collection && /:(GetChildren|GetDescendants)$/.test(context.getCallPath(collection) ?? ""));
    }

    return false;
  }

  function writtenKeyKind(target: SyntaxNode, name: string): CollectionKeyKind {
    if (target.type === "dot_index_expression") return "dictionary";
    if (target.type !== "bracket_index_expression") return "unknown";

    const key = target.namedChildren[1];
    if (!key) return "unknown";

    if (key.type === "string") return "dictionary";

    if (key.type === "binary_expression") {
      if (key.children.some((child) => child.type === "..")) return "dictionary";
      if (new RegExp(`^#\\s*${name}\\s*\\+\\s*1$`).test(key.text.trim())) return "array";
    }

    if (key.type === "function_call" && context.getCallPath(key) === "tostring" && isUnshadowedBuiltin(key, "tostring")) return "dictionary";
    if (key.type === "dot_index_expression" && key.namedChildren[1]?.text === "Name" && isInstanceFromChildren(key.namedChildren[0])) return "dictionary";

    return "unknown";
  }

  // Element writes and array-only table calls show how a collection is shaped before the loop reads it
  function usageEvidence(name: string, declaration: SyntaxNode, scope: SyntaxNode, site: SyntaxNode): { writes: CollectionKeyKind[]; arrayCalls: number } {
    const evidence: CollectionKeyKind[] = [];
    let arrayCalls = 0;

    const inRange = (node: SyntaxNode) => node.startIndex > declaration.endIndex && node.startIndex < site.startIndex &&
      node.startIndex >= scope.startIndex && node.endIndex <= scope.endIndex;

    for (const write of writes) {
      if (!inRange(write)) continue;

      const target = write.namedChildren.find((child) => child.type === "variable_list")?.namedChildren[0];
      if (!target || target.type === "identifier" || rootName(target.text) !== name) continue;

      // Nested writes such as t[k].field change values, not the collection keys
      if (target.namedChildren[0]?.text !== name) continue;

      evidence.push(writtenKeyKind(target, name));
    }

    for (const call of context.findCalls()) {
      if (!inRange(call)) continue;

      const path = context.getCallPath(call);
      if (path !== "table.insert" && path !== "table.sort" && path !== "table.remove") continue;
      if (!isUnshadowedBuiltin(call, "table") || context.callArguments(call)[0]?.text.trim() !== name) continue;

      arrayCalls += 1;
    }

    return { writes: evidence, arrayCalls };
  }

  function memoResult(call: SyntaxNode, seen: Set<number>): CollectionKeyKind {
    const factory = context.callArguments(call)[0];
    const fn = factory && (factory.type === "function_definition"
      ? context.model.functionByNode.get(factory.id) ?? null
      : resolveLocalFunction(context, factory));

    if (!fn?.body) return "unknown";

    // Early returns of the same table are judged by its final shape
    const returns = new Map<string, SyntaxNode>();
    for (const node of context.walk(fn.body)) {
      if (node.type !== "return_statement" || context.nearestFunction(node) !== fn) continue;

      const returned = node.namedChildren.find((child) => child.type === "expression_list")?.namedChildren[0];
      returns.set(returned?.type === "identifier" ? returned.text : `#${node.id}`, node);
    }

    const kinds = [...returns.values()].map((node) => {
      const returned = node.namedChildren.find((child) => child.type === "expression_list")?.namedChildren[0];
      return returned ? resolve(returned, node, seen) : "unknown";
    });

    return kinds.length > 0 && kinds.every((kind) => kind === kinds[0]) ? kinds[0] : "unknown";
  }

  function resolve(expression: SyntaxNode, site: SyntaxNode, seen = new Set<number>()): CollectionKeyKind {
    if (seen.has(expression.id)) return "unknown";
    seen.add(expression.id);

    if (expression.type === "function_call" && context.resolveCallPath(context.getCallPath(expression) ?? "") === "React.useMemo") {
      return memoResult(expression, seen);
    }

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
            assignmentLeft(write.text) === name)) return "unknown";
          // Multiple binding/type lists need proper type resolution; keep them uncertain.
          if (declarationNames(statement).length !== 1) return "unknown";
          const assignment = statement.namedChildren.find((child) => child.type === "assignment_statement");
          const variables = assignment?.namedChildren.find((child) => child.type === "variable_list");
          const annotation = variables?.text.match(/^[A-Za-z_][A-Za-z0-9_]*\s*:\s*([\s\S]+)$/)?.[1];
          if (annotation) return typeKind(annotation, fields, statement);
          if (fields.length > 0) return "unknown";
          const value = assignment?.namedChildren.find((child) => child.type === "expression_list")?.namedChildren[0];
          const base = value ? resolve(value, statement, seen) : "unknown";
          const { writes: written, arrayCalls } = usageEvidence(name, statement, current, site);
          if (base !== "unknown") return written.every((kind) => kind === base) ? base : "unknown";

          const evidence = arrayCalls > 0 ? [...written, "array" as const] : written;
          if (evidence.length === 0 || evidence.some((kind) => kind !== evidence[0])) return "unknown";

          // A string-keyed write only proves the shape when the table started empty
          const startsEmpty = value?.type === "table_constructor" && value.namedChildren.length === 0;
          return evidence[0] === "array" || startsEmpty ? evidence[0] : "unknown";
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
