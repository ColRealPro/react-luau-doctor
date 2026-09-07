import type { Node as SyntaxNode } from "web-tree-sitter";
import type { FunctionInfo, RuleContext } from "../types";
import { rootIdentifier, sameNode } from "../ast/walk";

export const CONDITIONAL_TYPES = new Set([
  "if_statement",
  "if_expression",
  "for_statement",
  "while_statement",
  "repeat_statement",
]);

export function isHookPath(path: string): boolean {
  const final = path.split(/[.:]/).at(-1) ?? "";
  return /^use[A-Z0-9_]/.test(final);
}


export function assignmentTargetNode(statement: SyntaxNode): SyntaxNode {
  return statement.namedChildren[0] ?? statement;
}

export function tableStartNode(table: SyntaxNode): SyntaxNode {
  return table.children.find((child) => child.type === "{") ?? table;
}

export function identifierNode(node: SyntaxNode, name: string): SyntaxNode | null {
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === "identifier" && current.text === name) return current;
    for (let index = current.namedChildren.length - 1; index >= 0; index -= 1) stack.push(current.namedChildren[index]);
  }
  return null;
}

export function callNameNode(call: SyntaxNode): SyntaxNode {
  return call.childForFieldName("name") ?? call;
}

export function fieldNameNode(field: SyntaxNode): SyntaxNode {
  return field.childForFieldName("name") ?? field;
}

export function firstFunctionArgument(context: RuleContext, call: SyntaxNode): SyntaxNode | null {
  return context.callArguments(call).find((arg) => arg.type === "function_definition") ?? null;
}

export function directComponentForCall(context: RuleContext, call: SyntaxNode): FunctionInfo | null {
  const fn = context.nearestFunction(call);
  return fn?.isComponent ? fn : null;
}

export function findAncestorBetween(node: SyntaxNode, stop: SyntaxNode, predicate: (node: SyntaxNode) => boolean): SyntaxNode | null {
  let current = node.parent;
  while (current && !sameNode(current, stop)) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return null;
}

export function declarationNames(node: SyntaxNode): string[] {
  if (node.type !== "variable_declaration") return [];
  const beforeEquals = node.text.split("=")[0] ?? "";
  return beforeEquals
    .replace(/^\s*local\s+/, "")
    .split(",")
    .map((piece) => piece.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? null)
    .filter((name): name is string => Boolean(name));
}

export function callRoot(path: string): string | null {
  return rootIdentifier(path);
}

export function isNestedInsideFunction(node: SyntaxNode, boundary: SyntaxNode): boolean {
  let current = node.parent;
  while (current && !sameNode(current, boundary)) {
    if (current.type === "function_definition" || current.type === "function_declaration") return true;
    current = current.parent;
  }
  return false;
}

export function functionHasReturnedBefore(call: SyntaxNode, fn: FunctionInfo, context: RuleContext): boolean {
  if (!fn.body) return false;
  for (const node of context.walk(fn.body)) {
    if (node.endIndex > call.startIndex) continue;
    if (node.type !== "return_statement") continue;
    if (isNestedInsideFunction(node, fn.node)) continue;
    return true;
  }
  return false;
}

export function parseDependencyRoots(node: SyntaxNode | undefined): Set<string> {
  const result = new Set<string>();
  if (!node || node.type !== "table_constructor") return result;

  for (const child of node.namedChildren) {
    const root = rootIdentifier(child.text);
    if (root) result.add(root);
  }
  return result;
}

export function assignmentLeft(text: string): string {
  const match = text.match(/^(.*?)(?:\+=|-=|\*=|\/=|%=|\^=|\.\.=|\/=|=)/s);
  return match?.[1]?.trim() ?? "";
}

export function functionInfoForNode(context: RuleContext, node: SyntaxNode | null): FunctionInfo | null {
  if (!node) return null;
  return context.model.functionByNode.get(node.id) ?? null;
}

export function stateBindingsFor(context: RuleContext, owner: FunctionInfo): typeof context.model.stateBindings {
  return context.model.stateBindings.filter((binding) => binding.owner === owner);
}

export function isEffectPath(path: string): boolean {
  return path === "React.useEffect" || path === "React.useLayoutEffect";
}

export function dependencyExpressions(node: SyntaxNode | undefined): SyntaxNode[] {
  if (!node || node.type !== "table_constructor") return [];
  return node.namedChildren
    .filter((child) => child.type === "field")
    .map((field) => {
      const name = field.childForFieldName("name");
      if (name && field.text.trim().startsWith("[")) return name;
      return field.namedChildren.find((child) => !sameNode(child, name)) ?? name ?? field;
    });
}

export function fieldName(node: SyntaxNode): string | null {
  if (node.type !== "field") return null;
  const name = node.childForFieldName("name");
  return name?.type === "identifier" ? name.text : null;
}

export function fieldValue(node: SyntaxNode): SyntaxNode | null {
  if (node.type !== "field") return null;
  const name = node.childForFieldName("name");
  if (!name) return node.namedChildren[0] ?? null;
  return node.namedChildren.find((child) => child.startIndex > name.endIndex) ?? null;
}

export function containsIdentifier(node: SyntaxNode | null | undefined, name: string, context: RuleContext): boolean {
  if (!node) return false;
  for (const child of context.walk(node)) {
    if (child.type !== "identifier" || child.text !== name) continue;
    const parent = child.parent;
    if (parent?.type === "dot_index_expression" && sameNode(parent.childForFieldName("field"), child)) continue;
    if (parent?.type === "method_index_expression" && (sameNode(parent.childForFieldName("method"), child) || sameNode(parent.namedChildren.at(-1), child))) continue;
    return true;
  }
  return false;
}

export function ownerStateSetter(context: RuleContext, owner: FunctionInfo, path: string): string | null {
  for (const binding of context.model.stateBindings) {
    if (binding.owner === owner && binding.setterName === path) return binding.valueName;
  }
  return null;
}


function parameterNames(node: SyntaxNode | null): Set<string> {
  const names = new Set<string>();
  if (!node) return names;
  for (const candidate of node.namedChildren) {
    for (const child of [candidate, ...Array.from((function* walkLocal(current: SyntaxNode): Iterable<SyntaxNode> {
      for (const nested of current.namedChildren) {
        yield nested;
        yield* walkLocal(nested);
      }
    })(candidate))]) {
      if (child.type === "identifier") names.add(child.text);
    }
  }
  return names;
}

function blockBindingsBefore(block: SyntaxNode, beforeIndex: number): Set<string> {
  const names = new Set<string>();
  for (const child of block.namedChildren) {
    if (child.startIndex >= beforeIndex) continue;
    if (child.type === "variable_declaration") {
      for (const name of declarationNames(child)) names.add(name);
    } else if (child.type === "function_declaration") {
      const name = child.childForFieldName("name")?.text;
      if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

function loopBindings(loop: SyntaxNode): Set<string> {
  const names = new Set<string>();
  const header = loop.text.split(/\bdo\b/s, 1)[0] ?? "";
  const numeric = header.match(/^\s*for\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/s);
  if (numeric) names.add(numeric[1]);
  const generic = header.match(/^\s*for\s+(.+?)\s+in\b/s);
  if (generic) {
    for (const part of generic[1].split(",")) {
      const name = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
      if (name) names.add(name);
    }
  }
  return names;
}

export function isNameShadowedBetween(node: SyntaxNode, boundary: FunctionInfo, name: string): boolean {
  let current: SyntaxNode | null = node.parent;
  while (current && !sameNode(current, boundary.node)) {
    if (current.type === "function_definition" || current.type === "function_declaration") {
      if (parameterNames(current.childForFieldName("parameters")).has(name)) return true;
    }
    if (current.type === "block" && !sameNode(current.parent, boundary.node) && blockBindingsBefore(current, node.startIndex).has(name)) return true;
    if (current.type === "for_statement" && loopBindings(current).has(name)) return true;
    current = current.parent;
  }
  return false;
}

const topLevelBindingsCache = new WeakMap<FunctionInfo, Map<string, SyntaxNode[]>>();

function topLevelBindings(boundary: FunctionInfo): Map<string, SyntaxNode[]> {
  const cached = topLevelBindingsCache.get(boundary);
  if (cached) return cached;

  const result = new Map<string, SyntaxNode[]>();
  const add = (name: string, node: SyntaxNode): void => {
    const existing = result.get(name) ?? [];
    existing.push(node);
    result.set(name, existing);
  };

  for (const child of boundary.body?.namedChildren ?? []) {
    if (child.type === "variable_declaration") {
      for (const name of declarationNames(child)) add(name, child);
    } else if (child.type === "function_declaration") {
      const declared = child.childForFieldName("name")?.text.replace(/\s+/g, "") ?? "";
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(declared)) add(declared, child);
    }
  }

  topLevelBindingsCache.set(boundary, result);
  return result;
}

export function isBindingShadowedBetween(
  node: SyntaxNode,
  boundary: FunctionInfo,
  name: string,
  declaration: SyntaxNode | null = null,
): boolean {
  if (isNameShadowedBetween(node, boundary, name)) return true;
  if (!boundary.body) return false;

  const afterIndex = declaration?.endIndex ?? boundary.body.startIndex - 1;
  return (topLevelBindings(boundary).get(name) ?? []).some((binding) =>
    binding.startIndex > afterIndex && binding.startIndex < node.startIndex
  );
}

export function containsUnshadowedIdentifier(
  node: SyntaxNode | null | undefined,
  name: string,
  context: RuleContext,
  boundary: FunctionInfo,
): boolean {
  if (!node) return false;
  for (const child of context.walk(node)) {
    if (child.type !== "identifier" || child.text !== name) continue;
    const parent = child.parent;
    if (parent?.type === "dot_index_expression" && sameNode(parent.childForFieldName("field"), child)) continue;
    if (parent?.type === "method_index_expression" && (sameNode(parent.childForFieldName("method"), child) || sameNode(parent.namedChildren.at(-1), child))) continue;
    if (isNameShadowedBetween(child, boundary, name)) continue;
    return true;
  }
  return false;
}

export function directFunctionCalls(context: RuleContext, fn: FunctionInfo): SyntaxNode[] {
  if (!fn.body) return [];
  return [...context.walk(fn.body)].filter((node) => node.type === "function_call" && context.nearestFunction(node) === fn);
}
