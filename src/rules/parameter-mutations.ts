import type { SyntaxNode } from "../syntax";
import { moduleKeys, normalizeRequireTarget, resolveModuleReference } from "../module-resolution";
import { normalizeExpressionText, rootIdentifier, sameNode } from "../ast/walk";
import type { FunctionInfo, RuleContext, SourceEffectModuleSummary, StateBinding } from "../types";

export type MutationValueOrigin =
  | { kind: "props"; name: string }
  | { kind: "state"; binding: StateBinding }
  | { kind: "fresh" }
  | { kind: "unknown" };

interface ImportBinding {
  declaration: SyntaxNode;
  summary: SourceEffectModuleSummary;
}

interface BindingLookup {
  node: SyntaxNode;
  expression: SyntaxNode | null;
}

interface MutationAnalysis {
  currentSummary: SourceEffectModuleSummary | null;
  imports: Map<string, ImportBinding>;
  mutatingFactoryMembers: Set<string>;
  callIndexes: Map<number, ReadonlySet<number>>;
  originCache: Map<string, MutationValueOrigin>;
}

const analysisCache = new WeakMap<RuleContext, MutationAnalysis>();
const EMPTY_INDEXES: ReadonlySet<number> = new Set<number>();

function declarationParts(node: SyntaxNode): { names: string[]; expressions: SyntaxNode[] } {
  if (node.type !== "variable_declaration") return { names: [], expressions: [] };
  const assignment = node.namedChildren.find((child) => child.type === "assignment_statement");
  const variables = assignment?.namedChildren.find((child) => child.type === "variable_list")
    ?? node.namedChildren.find((child) => child.type === "variable_list");
  const expressions = assignment?.namedChildren.find((child) => child.type === "expression_list");
  return {
    names: variables?.namedChildren.filter((child) => child.type === "identifier").map((child) => child.text) ?? [],
    expressions: expressions?.namedChildren ?? [],
  };
}

function assignmentParts(node: SyntaxNode): { names: string[]; expressions: SyntaxNode[] } {
  if (node.type !== "assignment_statement" || node.parent?.type === "variable_declaration") {
    return { names: [], expressions: [] };
  }
  const variables = node.namedChildren.find((child) => child.type === "variable_list");
  const expressions = node.namedChildren.find((child) => child.type === "expression_list");
  return {
    names: variables?.namedChildren.filter((child) => child.type === "identifier").map((child) => child.text) ?? [],
    expressions: expressions?.namedChildren ?? [],
  };
}

function expressionForName(node: SyntaxNode, name: string): SyntaxNode | null | undefined {
  const { names, expressions } = node.type === "variable_declaration" ? declarationParts(node) : assignmentParts(node);
  const index = names.indexOf(name);
  if (index < 0) return undefined;
  return expressions[index] ?? expressions[0] ?? null;
}

function currentModuleSummary(context: RuleContext): SourceEffectModuleSummary | null {
  for (const key of moduleKeys(context.relativePath)) {
    const summary = context.project.sourceEffects.get(key);
    if (summary) return summary;
  }
  return null;
}

function topLevelImports(context: RuleContext): Map<string, ImportBinding> {
  const result = new Map<string, ImportBinding>();
  for (const node of context.root.namedChildren) {
    if (node.type !== "variable_declaration") continue;
    const { names, expressions } = declarationParts(node);
    for (let index = 0; index < names.length; index += 1) {
      const expression = expressions[index] ?? expressions[0];
      if (expression?.type !== "function_call") continue;
      const match = expression.text.match(/^\s*require\s*\((.*?)\)\s*$/s);
      if (!match) continue;
      const summary = resolveModuleReference(normalizeRequireTarget(match[1]), context.project.sourceEffects);
      if (summary) result.set(names[index], { declaration: node, summary });
    }
  }
  return result;
}

function analysisFor(context: RuleContext): MutationAnalysis {
  const cached = analysisCache.get(context);
  if (cached) return cached;
  const imports = topLevelImports(context);
  const mutatingFactoryMembers = new Set<string>();
  for (const { summary } of imports.values()) {
    if (summary.instanceFactories.size === 0) continue;
    for (const member of summary.mutatingMemberParameters.keys()) mutatingFactoryMembers.add(member);
  }
  const result: MutationAnalysis = {
    currentSummary: currentModuleSummary(context),
    imports,
    mutatingFactoryMembers,
    callIndexes: new Map(),
    originCache: new Map(),
  };
  analysisCache.set(context, result);
  return result;
}

function directChildContaining(block: SyntaxNode, node: SyntaxNode): SyntaxNode | null {
  for (const child of block.namedChildren) {
    if (child.startIndex <= node.startIndex && child.endIndex >= node.endIndex) return child;
  }
  return null;
}

function visibleBinding(name: string, node: SyntaxNode, owner: FunctionInfo): BindingLookup | null {
  let current: SyntaxNode | null = node;
  while (current && !sameNode(current, owner.node)) {
    const parent: SyntaxNode | null = current.parent;
    if (parent?.type === "block") {
      const containing = directChildContaining(parent, node);
      const beforeIndex = containing?.startIndex ?? node.startIndex;
      const children = parent.namedChildren;
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child.startIndex >= beforeIndex) continue;
        if (child.type !== "variable_declaration" && child.type !== "assignment_statement") continue;
        const expression = expressionForName(child, name);
        if (expression !== undefined) return { node: child, expression };
      }
    }
    current = parent;
  }
  return null;
}

function isTopLevelFunctionVisible(context: RuleContext, name: string, owner: FunctionInfo): boolean {
  for (const node of context.root.namedChildren) {
    if (node.startIndex >= owner.node.startIndex) break;
    if (node.type === "function_declaration") {
      const declared = node.childForFieldName("name")?.text.replace(/\s+/g, "") ?? "";
      if (declared === name) return true;
      continue;
    }
    if (node.type !== "variable_declaration") continue;
    const { names, expressions } = declarationParts(node);
    const index = names.indexOf(name);
    if (index < 0) continue;
    if ((expressions[index] ?? expressions[0])?.type === "function_definition") return true;
  }
  return false;
}

function moduleBindingVisible(binding: ImportBinding, name: string, call: SyntaxNode, owner: FunctionInfo): boolean {
  if (binding.declaration.startIndex >= owner.node.startIndex) return false;
  if (owner.parameters.includes(name)) return false;
  return visibleBinding(name, call, owner) === null;
}

function builtinMutatedParameterIndexes(path: string, argumentCount: number): ReadonlySet<number> {
  switch (path) {
    case "rawset":
    case "setmetatable":
    case "table.clear":
    case "table.freeze":
    case "table.insert":
    case "table.remove":
    case "table.sort":
      return argumentCount > 0 ? new Set([0]) : EMPTY_INDEXES;
    case "table.move":
      return argumentCount >= 5 ? new Set([4]) : argumentCount > 0 ? new Set([0]) : EMPTY_INDEXES;
    default:
      return EMPTY_INDEXES;
  }
}

function importedFactorySummary(
  context: RuleContext,
  receiver: string,
  call: SyntaxNode,
  owner: FunctionInfo,
  analysis: MutationAnalysis,
): SourceEffectModuleSummary | null {
  const binding = visibleBinding(receiver, call, owner);
  if (!binding?.expression) return null;
  const expression = binding.expression;
  if (expression.type === "identifier") {
    return importedFactorySummary(context, expression.text, expression, owner, analysis);
  }
  if (expression.type !== "function_call") return null;
  const path = normalizeExpressionText(context.getCallPath(expression) ?? "");
  const match = path.match(/^([A-Za-z_][A-Za-z0-9_]*)[.:]([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!match) return null;
  const imported = analysis.imports.get(match[1]);
  if (!imported || !moduleBindingVisible(imported, match[1], expression, owner)) return null;
  return imported.summary.instanceFactories.has(match[2]) ? imported.summary : null;
}

export function mightMutateParameters(context: RuleContext, call: SyntaxNode): boolean {
  const path = normalizeExpressionText(context.getCallPath(call) ?? "");
  if (builtinMutatedParameterIndexes(path, context.callArguments(call).length).size > 0) return true;

  const analysis = analysisFor(context);
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(path)) {
    if ((analysis.currentSummary?.localMutatingParameters.get(path)?.size ?? 0) > 0) return true;
    return (analysis.imports.get(path)?.summary.mutatingExportParameters.size ?? 0) > 0;
  }

  const member = path.match(/^([A-Za-z_][A-Za-z0-9_]*)[.:]([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!member) return false;
  if ((analysis.imports.get(member[1])?.summary.mutatingMemberParameters.get(member[2])?.size ?? 0) > 0) return true;
  return analysis.mutatingFactoryMembers.has(member[2]);
}

export function mutatedParameterIndexesForCall(
  context: RuleContext,
  call: SyntaxNode,
  owner: FunctionInfo,
): ReadonlySet<number> {
  const analysis = analysisFor(context);
  const cached = analysis.callIndexes.get(call.id);
  if (cached) return cached;

  const path = normalizeExpressionText(context.getCallPath(call) ?? "");
  const builtin = builtinMutatedParameterIndexes(path, context.callArguments(call).length);
  if (builtin.size > 0) {
    analysis.callIndexes.set(call.id, builtin);
    return builtin;
  }

  let result: ReadonlySet<number> = EMPTY_INDEXES;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(path)) {
    const importBinding = analysis.imports.get(path);
    if (importBinding && moduleBindingVisible(importBinding, path, call, owner)) {
      result = importBinding.summary.mutatingExportParameters;
    } else if (
      !owner.parameters.includes(path)
      && visibleBinding(path, call, owner) === null
      && isTopLevelFunctionVisible(context, path, owner)
    ) {
      result = analysis.currentSummary?.localMutatingParameters.get(path) ?? EMPTY_INDEXES;
    }
  } else {
    const member = path.match(/^([A-Za-z_][A-Za-z0-9_]*)([.:])([A-Za-z_][A-Za-z0-9_]*)$/);
    if (member) {
      const imported = analysis.imports.get(member[1]);
      if (imported && moduleBindingVisible(imported, member[1], call, owner)) {
        result = imported.summary.mutatingMemberParameters.get(member[3]) ?? EMPTY_INDEXES;
      } else {
        const factory = importedFactorySummary(context, member[1], call, owner, analysis);
        result = factory?.mutatingMemberParameters.get(member[3]) ?? EMPTY_INDEXES;
      }
    }
  }

  analysis.callIndexes.set(call.id, result);
  return result;
}

function freshExpression(context: RuleContext, expression: SyntaxNode): boolean {
  if (expression.type === "table_constructor" || expression.type === "function_definition") return true;
  if (expression.type !== "function_call") return false;
  const path = normalizeExpressionText(context.getCallPath(expression) ?? "");
  if (path === "table.clone" || path === "table.create" || path === "table.pack") return true;
  if (path === "setmetatable") {
    const first = context.callArguments(expression)[0];
    return Boolean(first && freshExpression(context, first));
  }
  return false;
}

function stateBindingForName(context: RuleContext, owner: FunctionInfo, name: string, bindingNode: SyntaxNode): StateBinding | null {
  return context.model.stateBindings.find((binding) =>
    binding.owner === owner && binding.valueName === name && sameNode(binding.declaration, bindingNode)
  ) ?? null;
}

function resolveNameOrigin(
  context: RuleContext,
  name: string,
  atNode: SyntaxNode,
  owner: FunctionInfo,
  seen: Set<string>,
): MutationValueOrigin {
  const key = `${owner.node.id}:${name}:${atNode.startIndex}`;
  if (seen.has(key)) return { kind: "unknown" };
  seen.add(key);

  const binding = visibleBinding(name, atNode, owner);
  if (binding) {
    const state = stateBindingForName(context, owner, name, binding.node);
    if (state) return { kind: "state", binding: state };
    if (!binding.expression) return { kind: "unknown" };
    return resolveExpressionOriginInternal(context, binding.expression, owner, seen);
  }

  if (owner.isComponent && owner.parameters[0] === name) return { kind: "props", name };
  return { kind: "unknown" };
}

function resolveExpressionOriginInternal(
  context: RuleContext,
  expression: SyntaxNode,
  owner: FunctionInfo,
  seen: Set<string>,
): MutationValueOrigin {
  if (freshExpression(context, expression)) return { kind: "fresh" };
  const root = rootIdentifier(expression.text);
  if (!root) return { kind: "unknown" };
  return resolveNameOrigin(context, root, expression, owner, seen);
}

export function mutationOriginForExpression(
  context: RuleContext,
  expression: SyntaxNode,
  owner: FunctionInfo,
): MutationValueOrigin {
  const analysis = analysisFor(context);
  const key = `${owner.node.id}:${expression.id}`;
  const cached = analysis.originCache.get(key);
  if (cached) return cached;
  const result = resolveExpressionOriginInternal(context, expression, owner, new Set());
  analysis.originCache.set(key, result);
  return result;
}
