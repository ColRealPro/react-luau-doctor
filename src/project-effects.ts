import fs from "node:fs";
import path from "node:path";
import type { SyntaxNode, SyntaxTree } from "./syntax";
import { variableListTargets } from "./ast/walk";
import {
  buildUniqueFeatureAliases,
  moduleKeys,
  normalizeRequireTarget,
  resolveModuleReference,
  type ModuleIdentity,
} from "./module-resolution";
import { apiFunctionReference, apiInstanceMethodReference } from "./api-reference";
import { parseLuau } from "./parser";
import type { AnalysisWorkerPool } from "./parallel";
import type { ScanFileInput, SourceEffectModuleSummary, SourceEffectStep } from "./types";


export interface ProjectEffectParseCacheEntry {
  source: string;
  tree: SyntaxTree;
}

export type CachedMutationOrigin =
  | { kind: "receiver" }
  | { kind: "parameter"; index: number }
  | { kind: "external" }
  | { kind: "local" }
  | { kind: "result"; targetId: string; argumentOrigins: Array<CachedMutationOrigin | null> };

export interface EffectSite {
  line: number;
  code: string;
}

export interface CachedMutationCall {
  targetId: string;
  site?: EffectSite;
  receiverOrigin: CachedMutationOrigin | null;
  argumentOrigins: Array<CachedMutationOrigin | null>;
}

export interface CachedSourceEffectFunction {
  id: string;
  moduleId: string;
  localName: string | null;
  memberName: string | null;
  exported: boolean;
  directEffect: boolean;
  /** First code in this function that changes outside state */
  effectSite?: EffectSite;
  receiverSite?: EffectSite;
  mutatesReceiver: boolean;
  mutatedParameterIndexes: number[];
  dependencies: string[];
  mutationCalls: CachedMutationCall[];
  /** Call results this function mutates, resolved through each callee's returns */
  mutatedOrigins?: CachedMutationOrigin[];
  mutatedOriginSites?: EffectSite[];
  returnOrigins?: CachedMutationOrigin[];
}

export interface CachedSourceEffectModule {
  hash: string;
  id: string;
  keys: string[];
  importedModuleIds: string[];
  functions: CachedSourceEffectFunction[];
  instanceFactories: string[];
}

export interface ProjectSourceEffectsBuildResult {
  effects: Map<string, SourceEffectModuleSummary>;
  cacheModules: Record<string, CachedSourceEffectModule>;
}

export interface EffectWorkerIndexInput extends ModuleIdentity {
  relativePath: string;
  source: string;
}

export interface IndexedEffectWorkerModule {
  id: string;
  relativePath: string;
  importedModuleIds: string[];
  instanceFactories: string[];
  exportedFunctionId?: string;
}

export interface AnalyzedEffectWorkerModule {
  id: string;
  functions: CachedSourceEffectFunction[];
}

export type ProjectEffectsProgressPhase =
  | "parse"
  | "index-functions"
  | "analyze-calls"
  | "assemble-graph"
  | "resolve"
  | "propagate"
  | "summarize";

export interface ProjectEffectsProgress {
  phase: ProjectEffectsProgressPhase;
  current: number;
  total: number;
  file?: string;
}

interface ParsedRecord extends ModuleIdentity {
  source: string;
  tree: SyntaxTree;
  exportName: string | null;
  imports: Map<string, string>;
}

interface MutationCall {
  targetId: string;
  site: EffectSite;
  receiverRoot: string | null;
  argumentRoots: Array<string | null>;
}

interface ResultRoot {
  targetId: string;
  argumentRoots: Array<string | null>;
}

interface FunctionRecord {
  id: string;
  moduleId: string;
  localName: string | null;
  memberName: string | null;
  exported: boolean;
  method: boolean;
  node: SyntaxNode;
  body: SyntaxNode;
  parameters: string[];
  directEffect: boolean;
  effectSite: EffectSite | null;
  receiverSite: EffectSite | null;
  mutatesReceiver: boolean;
  mutatedParameterIndexes: Set<number>;
  dependencies: Set<string>;
  mutationCalls: MutationCall[];
  parameterOrigins: Map<string, number>;
  externalRoots: Set<string>;
  ownedRoots: Set<string>;
  localNames: Set<string>;
  resultRoots: Map<string, ResultRoot>;
  mutatedResults: ResultRoot[];
  mutatedResultSites: EffectSite[];
  returnOrigins: CachedMutationOrigin[];
}

export interface EffectWorkerState {
  relativePath: string;
  source: string;
  record: ParsedRecord;
  functions: FunctionRecord[];
}

function normalizeRelative(value: string): string {
  return value.split(path.sep).join("/");
}

function child(node: SyntaxNode, type: string): SyntaxNode | null {
  return node.namedChildren.find((candidate) => candidate.type === type) ?? null;
}

function topLevelReturnName(root: SyntaxNode): string | null {
  for (const node of [...root.namedChildren].reverse()) {
    if (node.type !== "return_statement") continue;
    const expressions = child(node, "expression_list");
    const value = expressions?.namedChildren[0];
    if (value?.type === "identifier") return value.text;
    return null;
  }
  return null;
}

function topLevelImports(root: SyntaxNode, moduleAliases: Map<string, string>): Map<string, string> {
  const imports = new Map<string, string>();
  for (const node of root.namedChildren) {
    if (node.type !== "variable_declaration") continue;
    const { names, expressions } = declarationParts(node);
    for (let index = 0; index < names.length; index += 1) {
      const expression = expressions[index] ?? expressions[0];
      if (expression?.type !== "function_call") continue;
      const text = expression.text.trim();
      const match = text.match(/^require\s*\((.*?)\)\s*$/s);
      if (!match) continue;
      const moduleId = resolveModuleReference(normalizeRequireTarget(match[1]), moduleAliases);
      if (moduleId) imports.set(names[index], moduleId);
    }
  }
  return imports;
}

function parameterNames(node: SyntaxNode): string[] {
  const parameters = child(node, "parameters");
  if (!parameters) return [];
  const result: string[] = [];
  for (const parameter of parameters.namedChildren) {
    if (parameter.type !== "parameter") continue;
    const identifier = parameter.namedChildren.find((candidate) => candidate.type === "identifier");
    if (identifier) result.push(identifier.text);
  }
  return result;
}

function declarationParts(node: SyntaxNode): { names: string[]; expressions: SyntaxNode[] } {
  if (node.type !== "variable_declaration") return { names: [], expressions: [] };
  const assignment = child(node, "assignment_statement");
  const variables = assignment ? child(assignment, "variable_list") : child(node, "variable_list");
  const expressions = assignment ? child(assignment, "expression_list") : null;
  return {
    names: variableListTargets(variables).filter((candidate) => candidate.type === "identifier").map((candidate) => candidate.text),
    expressions: expressions?.namedChildren ?? [],
  };
}

function assignmentSides(node: SyntaxNode): { left: SyntaxNode[]; right: SyntaxNode[] } {
  if (node.type !== "assignment_statement" && node.type !== "update_statement") return { left: [], right: [] };
  return {
    left: child(node, "variable_list")?.namedChildren ?? [],
    right: child(node, "expression_list")?.namedChildren ?? [],
  };
}

function callPath(node: SyntaxNode): string | null {
  if (node.type !== "function_call") return null;
  const name = node.childForFieldName("name") ?? node.namedChildren[0];
  return name ? name.text.replace(/\s+/g, "") : null;
}

function unwrapExpression(node: SyntaxNode): SyntaxNode {
  let current = node;
  while ((current.type === "cast_expression" || current.type === "parenthesized_expression") && current.namedChildren[0]) {
    current = current.namedChildren[0];
  }
  return current;
}

function rootIdentifier(input: SyntaxNode | null | undefined): string | null {
  if (!input) return null;
  const node = unwrapExpression(input);
  if (node.type === "identifier") return node.text;
  if (
    node.type === "dot_index_expression" ||
    node.type === "bracket_index_expression" ||
    node.type === "method_index_expression"
  ) {
    return rootIdentifier(node.namedChildren[0]);
  }
  const text = node.text.trim();
  const root = text.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? null;
  // Literals such as `nil` and operators such as `not` never name a value
  return root && LUAU_KEYWORDS.has(root) ? null : root;
}

const LUAU_KEYWORDS = new Set(["nil", "true", "false", "not"]);

function callArguments(node: SyntaxNode): SyntaxNode[] {
  if (node.type !== "function_call") return [];
  return node.childForFieldName("arguments")?.namedChildren ?? [];
}

function builtinMutatedArgumentIndexes(path: string, argumentCount: number): number[] {
  switch (path.replace(/\s+/g, "")) {
    case "rawset":
    case "setmetatable":
    case "table.clear":
    case "table.freeze":
    case "table.insert":
    case "table.remove":
    case "table.sort":
      return argumentCount > 0 ? [0] : [];
    case "table.move":
      // table.move writes into the optional destination table, or back into the
      // source table when the destination argument is omitted.
      return argumentCount >= 5 ? [4] : argumentCount > 0 ? [0] : [];
    default:
      return [];
  }
}

function expressionCreatesOwnedValue(input: SyntaxNode, owned: Set<string>): boolean {
  const node = unwrapExpression(input);
  if (node.type === "table_constructor" || node.type === "function_definition") return true;
  if (node.type !== "function_call") return false;

  const path = callPath(node)?.replace(/\s+/g, "") ?? "";
  if (path === "table.clone" || path === "table.create" || path === "table.pack") return true;
  if (path !== "setmetatable" && path !== "table.freeze") return false;

  const first = callArguments(node)[0];
  if (!first) return false;
  if (first.type === "table_constructor") return true;
  const root = rootIdentifier(first);
  return Boolean(root && owned.has(root));
}

// Engine calls such as GetChildren or string.split return a value nothing else holds yet
function createsFreshEngineValue(node: SyntaxNode): boolean {
  if (node.type !== "function_call") return false;
  const path = callPath(node) ?? "";
  const method = path.match(/:([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
  return (method ? apiInstanceMethodReference(method) : apiFunctionReference(path))?.allocation === "new";
}

const createsFreshInstance = (node: SyntaxNode) => /^Instance\.new$|:Clone$/.test(callPath(node) ?? "");

function effectSite(node: SyntaxNode): EffectSite {
  return { line: node.startPosition.row + 1, code: node.text.split(/\r?\n/)[0].trim().slice(0, 120) };
}

function markDirectEffect(fn: { directEffect: boolean; effectSite?: EffectSite | null }, site: EffectSite | undefined): boolean {
  if (fn.directEffect) return false;
  fn.directEffect = true;
  fn.effectSite ??= site;
  return true;
}

function directNodes(body: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node !== body && (node.type === "function_definition" || node.type === "function_declaration")) return;
    result.push(node);
    for (const candidate of node.namedChildren) visit(candidate);
  };
  visit(body);
  return result;
}

function topLevelFunctionRecords(record: ParsedRecord): FunctionRecord[] {
  const functions: FunctionRecord[] = [];
  let anonymousExportIndex = 0;

  const add = (
    node: SyntaxNode,
    body: SyntaxNode | null,
    localName: string | null,
    memberName: string | null,
    method: boolean,
    exported: boolean,
  ): void => {
    if (!body) return;
    const key = memberName ? `member:${memberName}` : localName ? `local:${localName}` : `export:${anonymousExportIndex++}`;
    functions.push({
      id: `${record.id}::${key}`,
      moduleId: record.id,
      localName,
      memberName,
      exported,
      method,
      node,
      body,
      parameters: parameterNames(node),
      directEffect: false,
      effectSite: null,
      receiverSite: null,
      mutatesReceiver: false,
      mutatedParameterIndexes: new Set<number>(),
      dependencies: new Set<string>(),
      mutationCalls: [],
      parameterOrigins: new Map<string, number>(),
      externalRoots: new Set<string>(),
      ownedRoots: new Set<string>(),
      localNames: new Set<string>(),
      resultRoots: new Map<string, ResultRoot>(),
      mutatedResults: [],
      mutatedResultSites: [],
      returnOrigins: [],
    });
  };

  for (const node of record.tree.rootNode.namedChildren) {
    if (node.type === "function_declaration") {
      const nameNode = node.namedChildren.find((candidate) =>
        ["identifier", "dot_index_expression", "method_index_expression"].includes(candidate.type),
      );
      const body = child(node, "block");
      const text = nameNode?.text.replace(/\s+/g, "") ?? "";
      const methodMatch = text.match(/^([A-Za-z_][A-Za-z0-9_]*)[:.]([A-Za-z_][A-Za-z0-9_]*)$/);
      if (methodMatch && methodMatch[1] === record.exportName) {
        add(node, body, null, methodMatch[2], nameNode?.type === "method_index_expression", false);
      } else if (nameNode?.type === "identifier") {
        add(node, body, text, null, false, record.exportName === text);
      }
      continue;
    }

    if (node.type === "variable_declaration") {
      const { names, expressions } = declarationParts(node);
      for (let index = 0; index < names.length; index += 1) {
        const expression = expressions[index] ?? expressions[0];
        if (expression?.type !== "function_definition") continue;
        add(expression, child(expression, "block"), names[index], null, false, record.exportName === names[index]);
      }
      continue;
    }

    if (node.type === "assignment_statement") {
      const { left, right } = assignmentSides(node);
      for (let index = 0; index < left.length; index += 1) {
        const expression = right[index] ?? right[0];
        if (expression?.type !== "function_definition") continue;
        const text = left[index].text.replace(/\s+/g, "");
        const memberMatch = text.match(/^([A-Za-z_][A-Za-z0-9_]*)[.:]([A-Za-z_][A-Za-z0-9_]*)$/);
        if (memberMatch && memberMatch[1] === record.exportName) {
          add(expression, child(expression, "block"), null, memberMatch[2], text.includes(":"), false);
        }
      }
      continue;
    }

    if (node.type === "return_statement") {
      const expressions = child(node, "expression_list");
      const expression = expressions?.namedChildren[0];
      if (expression?.type === "function_definition") add(expression, child(expression, "block"), null, null, false, true);
    }
  }

  return functions;
}


function returnedFactoryMember(fn: FunctionRecord, moduleExportName: string | null): boolean {
  if (!fn.memberName || !moduleExportName) return false;
  const header = fn.node.text.slice(0, Math.max(0, fn.body.startIndex - fn.node.startIndex));
  const escaped = moduleExportName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`:\\s*${escaped}\\b`).test(header)) return true;

  for (const node of directNodes(fn.body)) {
    if (node.type !== "return_statement") continue;
    if (new RegExp(`\\bsetmetatable\\s*\\([\\s\\S]*?\\b${escaped}\\b`).test(node.text)) return true;
  }
  return false;
}

function moduleLevelInstanceAliases(record: ParsedRecord, summariesByModuleId: Map<string, SourceEffectModuleSummary>): Map<string, string> {
  const result = new Map<string, string>();
  for (const node of record.tree.rootNode.namedChildren) {
    if (node.type !== "variable_declaration") continue;
    const { names, expressions } = declarationParts(node);
    for (let index = 0; index < names.length; index += 1) {
      const expression = expressions[index] ?? expressions[0];
      if (expression?.type !== "function_call") continue;
      const path = callPath(expression);
      const match = path?.match(/^([A-Za-z_][A-Za-z0-9_]*)[.:]([A-Za-z_][A-Za-z0-9_]*)$/);
      if (!match) continue;
      const moduleId = record.imports.get(match[1]);
      const summary = moduleId ? summariesByModuleId.get(moduleId) : null;
      if (moduleId && summary?.instanceFactories.has(match[2])) result.set(names[index], moduleId);
    }
  }
  return result;
}

function resolveCallTarget(
  node: SyntaxNode,
  record: ParsedRecord,
  localFunctions: Map<string, string>,
  memberFunctions: Map<string, string>,
  instanceAliases: Map<string, string>,
  exportedFunctions: Map<string, string>,
  locals: Set<string>,
  parameters: Set<string>,
): { targetId: string; receiverRoot: string | null } | null {
  const path = callPath(node);
  if (!path) return null;

  const localTarget = !locals.has(path) && !parameters.has(path) ? localFunctions.get(path) : null;
  if (localTarget) return { targetId: localTarget, receiverRoot: null };

  const member = path.match(/^([A-Za-z_][A-Za-z0-9_]*)([:.])([A-Za-z_][A-Za-z0-9_]*)$/);
  if (member) {
    const receiver = member[1];
    if (receiver === "self" || (receiver === record.exportName && !locals.has(receiver) && !parameters.has(receiver))) {
      const target = memberFunctions.get(member[3]);
      if (target) return { targetId: target, receiverRoot: member[2] === ":" ? receiver : null };
    }

    const moduleId = instanceAliases.get(receiver)
      ?? (!locals.has(receiver) && !parameters.has(receiver) ? record.imports.get(receiver) : undefined);
    if (moduleId) {
      return {
        targetId: `${moduleId}::member:${member[3]}`,
        receiverRoot: member[2] === ":" ? receiver : null,
      };
    }
    return null;
  }

  if (locals.has(path) || parameters.has(path)) return null;
  const moduleId = record.imports.get(path);
  const target = moduleId ? exportedFunctions.get(moduleId) : null;
  return target ? { targetId: target, receiverRoot: null } : null;
}

// Values reassigned to a fresh table earlier in the same block are owned at
// this point even when the variable started as an alias of a parameter
function latestBlockAssignmentIsOwned(root: string, node: SyntaxNode, owned: Set<string>, boundary: SyntaxNode): boolean {
  let statement = node;
  while (statement.id !== boundary.id && statement.parent) {
    const parent = statement.parent;
    if (parent.type === "block" || parent.type === "chunk") {
      const siblings = parent.namedChildren;
      for (let index = siblings.findIndex((sibling) => sibling.id === statement.id) - 1; index >= 0; index -= 1) {
        const sibling = siblings[index];
        if (sibling.type === "variable_declaration") {
          if (declarationParts(sibling).names.includes(root)) return false;
          continue;
        }
        if (sibling.type === "assignment_statement") {
          const { left, right } = assignmentSides(sibling);
          const targetIndex = left.findIndex((target) => target.type === "identifier" && target.text === root);
          if (targetIndex >= 0) {
            const value = right[targetIndex];
            return Boolean(value && expressionCreatesOwnedValue(value, owned));
          }
        }
        const reassignsLater = directNodes(sibling).some((candidate) =>
          candidate.type === "assignment_statement" &&
          assignmentSides(candidate).left.some((target) => target.type === "identifier" && target.text === root),
        );
        if (reassignsLater) return false;
      }
    }
    if (parent.id === boundary.id) break;
    statement = parent;
  }
  return false;
}

function iteratedCollection(clause: SyntaxNode): SyntaxNode | null {
  const collection = child(clause, "expression_list")?.namedChildren[0] ?? null;
  if (collection?.type !== "function_call") return collection;
  const path = callPath(collection);
  return path === "pairs" || path === "ipairs" ? callArguments(collection)[0] ?? null : collection;
}

const compactText = (node: SyntaxNode) => node.text.replace(/\s+/g, "");

function disjuncts(condition: SyntaxNode): SyntaxNode[] {
  const node = unwrapExpression(condition);
  if (node.type === "binary_expression" && node.children.some((part) => part.type === "or"))
    return node.namedChildren.flatMap(disjuncts);
  return [node];
}

// `x == nil`, `nil == x`, and `not x` test whether a slot is still empty
function emptySlotTested(condition: SyntaxNode): SyntaxNode | null {
  const node = unwrapExpression(condition);
  if (node.type === "unary_expression" && node.children[0]?.type === "not")
    return node.childForFieldName("operand");
  if (node.type !== "binary_expression" || !node.children.some((part) => part.type === "==")) return null;
  const [left, right] = node.namedChildren;
  if (right?.type === "nil") return left ?? null;
  if (left?.type === "nil") return right ?? null;
  return null;
}

function filledSlotTested(condition: SyntaxNode): SyntaxNode | null {
  const node = unwrapExpression(condition);
  if (node.type !== "binary_expression") return node;
  if (!node.children.some((part) => part.type === "~=")) return null;
  const [left, right] = node.namedChildren;
  if (right?.type === "nil") return left ?? null;
  if (left?.type === "nil") return right ?? null;
  return null;
}

function assignsSlot(block: SyntaxNode, slot: string): boolean {
  for (const node of block.namedChildren) {
    if (node.type !== "assignment_statement") continue;
    if (assignmentSides(node).left.some((target) => compactText(target) === slot)) return true;
  }
  return false;
}

// Writes that only fill an empty slot leave the same value on every later call,
// so lazy caches and one-time initialization are not observable effects
function fillsEmptySlot(statement: SyntaxNode, target: string, body: SyntaxNode, aliases: Map<string, string>): boolean {
  const slot = (node: SyntaxNode | null) => {
    if (!node) return null;
    const text = compactText(node);
    return aliases.get(text) ?? text;
  };

  // `slot = slot or value` keeps any value already there
  const { left, right } = assignmentSides(statement);
  const value = right[left.findIndex((candidate) => slot(candidate) === target)];
  const defaulted = value && unwrapExpression(value);
  if (defaulted?.type === "binary_expression" && defaulted.children.some((part) => part.type === "or") && slot(defaulted.namedChildren[0]) === target)
    return true;

  for (let current = statement; current.parent && current.id !== body.id; current = current.parent) {
    const parent = current.parent;

    if (parent.type === "if_statement" && parent.childForFieldName("consequence")?.id === current.id) {
      const condition = parent.childForFieldName("condition");
      for (const tested of condition ? disjuncts(condition).map(emptySlotTested) : []) {
        const guarded = slot(tested);
        if (guarded && (guarded === target || assignsSlot(current, guarded))) return true;
      }
    }

    if (parent.type !== "block" && parent.id !== body.id) continue;
    for (const sibling of parent.namedChildren) {
      if (sibling.startIndex >= current.startIndex) break;
      if (sibling.type !== "if_statement" || sibling.namedChildren.some((part) => part.type === "elseif_statement" || part.type === "else_statement")) continue;
      const returns = sibling.childForFieldName("consequence")?.namedChildren.at(-1)?.type === "return_statement";
      const condition = sibling.childForFieldName("condition");
      if (returns && condition && slot(filledSlotTested(condition)) === target) return true;
    }
  }

  return false;
}

const slotRoot = (slot: string) => slot.match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0] ?? null;

function functionSlotAliases(nodes: SyntaxNode[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const node of nodes) {
    if (node.type !== "variable_declaration") continue;
    const { names, expressions } = declarationParts(node);
    const expression = expressions[0] && unwrapExpression(expressions[0]);
    if (names.length === 1 && expression && ["identifier", "dot_index_expression", "bracket_index_expression"].includes(expression.type))
      aliases.set(names[0], compactText(expression));
  }
  return aliases;
}

// Locals that hold a cache table's contents, such as `local list = cache[key]`,
// mapped to the cache they come from
function cacheAliasNames(nodes: SyntaxNode[], caches: Set<string>, outer?: Map<string, string>): Map<string, string> {
  const aliases = new Map<string, string>();
  const cacheOf = (root: string | null) => root ? aliases.get(root) ?? outer?.get(root) ?? (caches.has(root) ? root : null) : null;
  for (const node of nodes) {
    if (node.type === "for_generic_clause") {
      const cache = cacheOf(rootIdentifier(iteratedCollection(node)));
      if (!cache) continue;
      for (const target of variableListTargets(child(node, "variable_list"))) aliases.set(target.text, cache);
      continue;
    }
    if (node.type !== "variable_declaration") continue;
    const { names, expressions } = declarationParts(node);
    for (let index = 0; index < names.length; index += 1) {
      const expression = expressions[index] ?? expressions[0];
      const cache = expression ? cacheOf(rootIdentifier(expression)) : null;
      if (cache) aliases.set(names[index], cache);
    }
  }
  return aliases;
}

function slotFilledIn(nodes: SyntaxNode[], slot: string, aliases: Map<string, string>): boolean {
  return nodes.some((node) => {
    if (node.type !== "assignment_statement" || node.parent?.type === "variable_declaration") return false;
    const { left, right } = assignmentSides(node);
    return left.some((target, index) => {
      const text = compactText(target);
      return (aliases.get(text) ?? text) === slot && right[index]?.type !== "nil";
    });
  });
}

function returnsSlot(statement: SyntaxNode, slot: string, aliases: Map<string, string>): boolean {
  const returned = child(statement, "expression_list")?.namedChildren[0];
  if (!returned) return false;
  const text = compactText(unwrapExpression(returned));
  return (aliases.get(text) ?? text) === slot;
}

// A memoizing miss branch follows a lookup of cache[key] that returns the cached
// value when present, and fills cache[key] before the function returns, so its
// writes run at most once per key
function inMemoizedMissBranch(
  statement: SyntaxNode,
  body: SyntaxNode,
  aliases: Map<string, string>,
  caches: Set<string>,
): boolean {
  const slot = (node: SyntaxNode | null) => {
    if (!node) return null;
    const text = compactText(node);
    const resolved = aliases.get(text) ?? text;
    const root = slotRoot(resolved);
    return root && caches.has(root) && resolved !== root ? resolved : null;
  };

  for (let current = statement; current.parent && current.id !== body.id; current = current.parent) {
    const parent = current.parent;

    if (parent.type === "if_statement" && parent.childForFieldName("consequence")?.id === current.id) {
      const condition = parent.childForFieldName("condition");
      const fillsAndReturns = (guarded: string) =>
        slotFilledIn(directNodes(current), guarded, aliases) &&
        directNodes(body).some((node) => node.type === "return_statement" && node.startIndex > parent.endIndex && returnsSlot(node, guarded, aliases));
      for (const guarded of condition ? disjuncts(condition).map((tested) => slot(emptySlotTested(tested))) : []) {
        if (guarded && fillsAndReturns(guarded)) return true;
      }
    }

    if (parent.type !== "block" && parent.id !== body.id) continue;
    const siblings = parent.namedChildren;
    for (let index = 0; index < siblings.length && siblings[index].startIndex < current.startIndex; index += 1) {
      const sibling = siblings[index];
      if (sibling.type !== "if_statement" || sibling.namedChildren.some((part) => part.type === "elseif_statement" || part.type === "else_statement")) continue;
      const exit = sibling.childForFieldName("consequence")?.namedChildren.at(-1);
      const condition = sibling.childForFieldName("condition");
      const guarded = condition ? slot(filledSlotTested(condition)) : null;
      if (!guarded || exit?.type !== "return_statement" || !returnsSlot(exit, guarded, aliases)) continue;
      if (slotFilledIn(siblings.slice(index + 1).flatMap(directNodes), guarded, aliases)) return true;
    }
  }

  return false;
}

const CACHE_READERS = new Set(["pairs", "ipairs", "next", "rawget", "table.insert", "table.remove", "table.clear"]);
const CACHE_REMOVERS = new Set(["table.remove", "table.clear"]);

function isTableConstructor(input: SyntaxNode): boolean {
  const node = unwrapExpression(input);
  if (node.type === "table_constructor") return true;
  return node.type === "function_call" &&
    callPath(node) === "setmetatable" &&
    callArguments(node)[0]?.type === "table_constructor";
}

// Private module tables that are only ever filled by memoizing lookups. Their
// entries can always be rebuilt by another lookup, so filling, indexing, and
// pruning them is not an effect observable outside the module
function moduleCacheTables(record: ParsedRecord): Set<string> {
  const root = record.tree.rootNode;
  const declarations = new Map<string, SyntaxNode>();
  for (const node of root.namedChildren) {
    if (node.type !== "variable_declaration") continue;
    const { names, expressions } = declarationParts(node);
    if (names.length === 1 && expressions.length === 1 && isTableConstructor(expressions[0]) && names[0] !== record.exportName)
      declarations.set(names[0], node);
  }
  if (declarations.size === 0) return new Set();

  const caches = new Set(declarations.keys());
  const allNodes: SyntaxNode[] = [];
  const visit = (node: SyntaxNode): void => {
    allNodes.push(node);
    for (const candidate of node.namedChildren) visit(candidate);
  };
  visit(root);

  // Using the table itself for anything but indexing, iteration, or table
  // library edits lets it escape, or shadows it with another binding
  for (const node of allNodes) {
    if (node.type !== "identifier" || !caches.has(node.text)) continue;
    const parent = node.parent;
    if (!parent) continue;
    if (parent.parent?.parent?.id === declarations.get(node.text)?.id && parent.type === "variable_list") continue;
    if ((parent.type === "dot_index_expression" || parent.type === "bracket_index_expression") && parent.namedChildren[0]?.id === node.id) continue;
    if (parent.type === "unary_expression" && parent.children[0]?.type === "#") continue;
    if (parent.type === "expression_list" && parent.parent?.type === "for_generic_clause" && parent.namedChildren[0]?.id === node.id) continue;
    const call = parent.parent;
    if (parent.type === "arguments" && call?.type === "function_call" && parent.namedChildren[0]?.id === node.id && CACHE_READERS.has(callPath(call) ?? "")) continue;
    caches.delete(node.text);
  }

  const scopes = new Map<number, { body: SyntaxNode; nodes: SyntaxNode[]; slotAliases: Map<string, string> }>();
  const scopeChain = (node: SyntaxNode) => {
    const chain: Array<{ body: SyntaxNode; nodes: SyntaxNode[]; slotAliases: Map<string, string> }> = [];
    for (let current: SyntaxNode | null = node.parent; current; current = current.parent) {
      const isFunction = current.type === "function_definition" || current.type === "function_declaration";
      const body = isFunction ? child(current, "block") : current.id === root.id ? current : null;
      if (!body) continue;
      let scope = scopes.get(body.id);
      if (!scope) {
        const nodes = directNodes(body);
        scope = { body, nodes, slotAliases: functionSlotAliases(nodes) };
        scopes.set(body.id, scope);
      }
      chain.push(scope);
    }
    return chain;
  };

  const insertions: Array<{ statement: SyntaxNode; root: string }> = [];
  for (const node of allNodes) {
    if ((node.type === "assignment_statement" && node.parent?.type !== "variable_declaration") || node.type === "update_statement") {
      const { left, right } = assignmentSides(node);
      left.forEach((target, index) => {
        const root = rootIdentifier(target);
        if (target.type === "identifier" || !root) return;
        if (node.type === "assignment_statement" && right[index]?.type === "nil") return;
        insertions.push({ statement: node, root });
      });
      continue;
    }
    if (node.type !== "function_call") continue;
    const path = callPath(node) ?? "";
    if (CACHE_REMOVERS.has(path)) continue;
    const arguments_ = callArguments(node);
    for (const index of builtinMutatedArgumentIndexes(path, arguments_.length)) {
      const root = rootIdentifier(arguments_[index]);
      if (root) insertions.push({ statement: node, root });
    }
  }

  let changed = true;
  while (changed && caches.size > 0) {
    changed = false;
    const aliasesByBody = new Map<number, Map<string, string>>();
    const aliasesFor = (chain: ReturnType<typeof scopeChain>): Map<string, string> | undefined => {
      let aliases: Map<string, string> | undefined;
      for (const scope of [...chain].reverse()) {
        let scoped = aliasesByBody.get(scope.body.id);
        if (!scoped) {
          scoped = cacheAliasNames(scope.nodes, caches, aliases);
          aliasesByBody.set(scope.body.id, scoped);
        }
        aliases = new Map([...(aliases ?? []), ...scoped]);
      }
      return aliases;
    };
    for (const { statement, root: name } of insertions) {
      const chain = scopeChain(statement);
      const cache = aliasesFor(chain)?.get(name) ?? (caches.has(name) ? name : null);
      if (!cache) continue;
      const scope = chain[0];
      if (scope && inMemoizedMissBranch(statement, scope.body, scope.slotAliases, caches)) continue;
      caches.delete(cache);
      changed = true;
    }
  }

  return caches;
}

function analyzeFunction(
  fn: FunctionRecord,
  record: ParsedRecord,
  localFunctions: Map<string, string>,
  memberFunctions: Map<string, string>,
  moduleSummaries: Map<string, SourceEffectModuleSummary>,
  moduleInstances: Map<string, string>,
  exportedFunctions: Map<string, string>,
  caches: Set<string>,
): void {
  const parameters = new Set(fn.parameters);
  const parameterOrigins = new Map<string, number>(fn.parameters.map((name, index) => [name, index] as const));
  if (fn.method) {
    parameters.add("self");
    parameterOrigins.set("self", -1);
  }
  const locals = new Set<string>();
  const owned = new Set<string>();
  const externalAliases = new Set<string>();
  const resultRoots = new Map<string, ResultRoot>();
  const refLocals = new Set<string>();
  const freshInstances = new Set<string>();
  const parents: Array<{ parent: SyntaxNode; statement: SyntaxNode }> = [];
  const instanceAliases = new Map(moduleInstances);
  const nodes = directNodes(fn.body);
  const returnedNodes: Array<SyntaxNode | null> = [];
  const callTarget = (node: SyntaxNode) => resolveCallTarget(
    node,
    record,
    localFunctions,
    memberFunctions,
    instanceAliases,
    exportedFunctions,
    locals,
    parameters,
  );

  for (const node of nodes) {
    if (node.type === "function_declaration" && node.id !== fn.node.id) {
      const declared = node.childForFieldName("name")?.text.replace(/\s+/g, "") ?? "";
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(declared)) locals.add(declared);
      continue;
    }
    if (node.type === "for_generic_clause") {
      // Iterating a parameter yields its contents, so mutating an item mutates the argument
      const root = rootIdentifier(iteratedCollection(node));
      const parameterOrigin = root ? parameterOrigins.get(root) : undefined;
      if (parameterOrigin === undefined) continue;
      for (const target of variableListTargets(child(node, "variable_list"))) {
        locals.add(target.text);
        parameterOrigins.set(target.text, parameterOrigin);
      }
      continue;
    }
    if (node.type !== "variable_declaration") continue;
    const { names, expressions } = declarationParts(node);
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index];
      const declared = expressions[index] ?? expressions[0];
      const expression = declared && unwrapExpression(declared);
      locals.add(name);
      if (!expression) continue;
      const freshEngineValue = expression.type === "function_call" && !callTarget(expression) && createsFreshEngineValue(expression);
      const createsOwnedValue = freshEngineValue || expressionCreatesOwnedValue(expression, owned);
      if (createsOwnedValue) owned.add(name);
      if (freshEngineValue && createsFreshInstance(expression)) {
        freshInstances.add(name);
        const parent = callArguments(expression)[1];
        if (parent) parents.push({ parent, statement: node });
      }
      const root = rootIdentifier(expression);
      const parameterOrigin = root ? parameterOrigins.get(root) : undefined;
      // A call's first result follows the callee's returned value instead of the callee name
      const target = !createsOwnedValue && index === 0 && expressions[index] && expression.type === "function_call"
        ? callTarget(expression)
        : null;
      if (target) {
        resultRoots.set(name, {
          targetId: target.targetId,
          argumentRoots: callArguments(expression).map((argument) => rootIdentifier(argument)),
        });
      } else if (!createsOwnedValue && root && parameterOrigin !== undefined) {
        // Keep argument/receiver mutation conditional. A caller may pass a fresh
        // render-local value, so it must not become an unconditional effect.
        parameterOrigins.set(name, parameterOrigin);
      } else if (!createsOwnedValue && root && resultRoots.has(root)) {
        resultRoots.set(name, resultRoots.get(root)!);
      } else if (!createsOwnedValue && root && (externalAliases.has(root) || (!locals.has(root) && root !== name))) {
        // Module/global state is externally observable regardless of call-site
        // ownership, so aliases of it remain safe to classify as effects.
        externalAliases.add(name);
      } else if (root && owned.has(root)) {
        owned.add(name);
      }

      if (expression.type === "function_call") {
        const path = callPath(expression)?.replace(/\s+/g, "") ?? "";
        if (path === "React.useRef") refLocals.add(name);
        const match = path.match(/^([A-Za-z_][A-Za-z0-9_]*)[.:]([A-Za-z_][A-Za-z0-9_]*)$/);
        if (match) {
          const moduleId = record.imports.get(match[1]);
          const summary = moduleId ? moduleSummaries.get(moduleId) : null;
          if (moduleId && summary?.instanceFactories.has(match[2])) instanceAliases.set(name, moduleId);
        }
      }
    }
  }

  const slotAliases = functionSlotAliases(nodes);
  const cacheAliases = cacheAliasNames(nodes, caches);
  // Names also bound to other values may not hold cache contents at a given write
  for (const node of nodes) {
    const isAssignment = node.type === "assignment_statement" && node.parent?.type !== "variable_declaration";
    if (node.type !== "variable_declaration" && !isAssignment) continue;
    const { names, expressions } = isAssignment
      ? (({ left, right }) => ({ names: left.map((target) => target.type === "identifier" ? target.text : null), expressions: right }))(assignmentSides(node))
      : declarationParts(node);
    names.forEach((name, index) => {
      if (!name) return;
      const expression = expressions[index] ?? expressions[0];
      const root = expression ? rootIdentifier(expression) : null;
      if (!root || !(caches.has(root) || cacheAliases.has(root))) cacheAliases.delete(name);
    });
  }
  for (const name of [...parameters]) cacheAliases.delete(name);
  const mutatesCache = (root: string) => cacheAliases.has(root) || (caches.has(root) && !locals.has(root) && !parameters.has(root));

  fn.parameterOrigins = parameterOrigins;
  fn.externalRoots = externalAliases;
  fn.ownedRoots = owned;
  fn.localNames = locals;
  fn.resultRoots = resultRoots;
  // A new Instance is private until it joins a tree that is not also new
  const joinsExistingTree = (parent: SyntaxNode) => {
    const root = rootIdentifier(parent);
    return parent.type !== "nil" && !(root && owned.has(root));
  };
  const parentedAt = parents.find(({ parent }) => joinsExistingTree(parent));
  if (parentedAt) markDirectEffect(fn, effectSite(parentedAt.statement));

  // Luau locals are lexically scoped from their declaration onward, so the
  // source-order pass above is enough to propagate aliases through local
  // declarations. Repeated fixed-point rescans of every function body were
  // redundant and particularly expensive on large modules.
  for (const node of nodes) {
    if ((node.type === "assignment_statement" || node.type === "update_statement") && node.parent?.type !== "variable_declaration") {
      const { left, right } = assignmentSides(node);
      for (const [index, target] of left.entries()) {
        if (target.type === "identifier") {
          if (!locals.has(target.text) && !parameters.has(target.text) && !fillsEmptySlot(node, target.text, fn.body, slotAliases))
            markDirectEffect(fn, effectSite(node));
          continue;
        }
        const root = rootIdentifier(target);
        if (!root) continue;
        const value = right[index] ?? right[0];
        const key = target.type === "bracket_index_expression" ? target.namedChildren[1] : null;
        const setsParent = compactText(target) === `${root}.Parent` || (key && (key.type !== "string" || /^["'`]Parent["'`]$/.test(key.text)));
        if (freshInstances.has(root) && setsParent && value && joinsExistingTree(value)) markDirectEffect(fn, effectSite(node));
        if (owned.has(root) || mutatesCache(root)) continue;
        if (fillsEmptySlot(node, compactText(target), fn.body, slotAliases)) continue;
        if (refLocals.has(root) && target.text.replace(/\s+/g, "") === `${root}.current`) continue;
        if (locals.has(root) && latestBlockAssignmentIsOwned(root, node, owned, fn.body)) continue;
        markMutationThroughRoot(fn, root, effectSite(node));
      }
      continue;
    }

    if (node.type === "return_statement") {
      const returned = child(node, "expression_list")?.namedChildren[0];
      returnedNodes.push(returned ?? null);
      continue;
    }

    if (node.type !== "function_call") continue;
    const path = callPath(node);
    if (!path) continue;
    const arguments_ = callArguments(node);

    for (const index of builtinMutatedArgumentIndexes(path, arguments_.length)) {
      const root = rootIdentifier(arguments_[index]);
      if (root && mutatesCache(root)) continue;
      if (root && locals.has(root) && latestBlockAssignmentIsOwned(root, node, owned, fn.body)) continue;
      markMutationThroughRoot(fn, root, effectSite(node));
    }

    const target = callTarget(node);
    if (target) {
      fn.dependencies.add(target.targetId);
      fn.mutationCalls.push({
        targetId: target.targetId,
        site: effectSite(node),
        receiverRoot: target.receiverRoot,
        argumentRoots: arguments_.map((argument) => rootIdentifier(argument)),
      });
    }
  }

  fn.returnOrigins = returnedNodes.map((node) => returnedOrigin(fn, node, callTarget));
}

function markMutationThroughRoot(fn: FunctionRecord, root: string | null, site: EffectSite): boolean {
  if (!root) return false;
  const parameterOrigin = fn.parameterOrigins.get(root);
  if (parameterOrigin !== undefined) {
    if (parameterOrigin === -1) {
      if (fn.mutatesReceiver) return false;
      fn.mutatesReceiver = true;
      fn.receiverSite ??= site;
      return true;
    }
    if (fn.mutatedParameterIndexes.has(parameterOrigin)) return false;
    fn.mutatedParameterIndexes.add(parameterOrigin);
    return true;
  }

  if (fn.ownedRoots.has(root)) return false;
  const result = fn.resultRoots.get(root);
  if (result) {
    if (fn.mutatedResults.includes(result)) return false;
    fn.mutatedResults.push(result);
    fn.mutatedResultSites.push(site);
    return true;
  }
  if (fn.externalRoots.has(root) || !fn.localNames.has(root)) return markDirectEffect(fn, site);
  return false;
}

function propagateLocalMutationEffects(functions: FunctionRecord[]): void {
  const byId = new Map(functions.map((fn) => [fn.id, fn] as const));
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of functions) {
      for (const call of fn.mutationCalls) {
        const target = byId.get(call.targetId);
        if (!target) continue;
        if (target.mutatesReceiver && markMutationThroughRoot(fn, call.receiverRoot, call.site)) changed = true;
        for (const index of target.mutatedParameterIndexes) {
          if (markMutationThroughRoot(fn, call.argumentRoots[index] ?? null, call.site)) changed = true;
        }
      }
    }
  }
}

function mutationOriginForRoot(fn: FunctionRecord, root: string | null, depth = 0): CachedMutationOrigin | null {
  if (!root) return null;
  const parameterOrigin = fn.parameterOrigins.get(root);
  if (parameterOrigin === -1) return { kind: "receiver" };
  if (parameterOrigin !== undefined) return { kind: "parameter", index: parameterOrigin };
  if (fn.ownedRoots.has(root)) return { kind: "local" };
  const result = fn.resultRoots.get(root);
  if (result) return resultOrigin(fn, result, depth);
  if (fn.localNames.has(root)) return { kind: "local" };
  return { kind: "external" };
}

const MAX_RESULT_DEPTH = 8;

function resultOrigin(fn: FunctionRecord, result: ResultRoot, depth: number): CachedMutationOrigin {
  // Too deep to follow means unknown, which is not evidence of an effect
  if (depth >= MAX_RESULT_DEPTH) return { kind: "local" };
  return {
    kind: "result",
    targetId: result.targetId,
    argumentOrigins: result.argumentRoots.map((root) => mutationOriginForRoot(fn, root, depth + 1)),
  };
}

function returnedOrigin(
  fn: FunctionRecord,
  returned: SyntaxNode | null,
  callTarget: (node: SyntaxNode) => { targetId: string } | null,
): CachedMutationOrigin {
  if (!returned) return { kind: "local" };
  const node = unwrapExpression(returned);
  if (expressionCreatesOwnedValue(node, fn.ownedRoots)) return { kind: "local" };
  if (["nil", "true", "false", "number", "string"].includes(node.type)) return { kind: "local" };
  if (node.type === "function_call") {
    const target = callTarget(node);
    if (target) {
      return resultOrigin(fn, {
        targetId: target.targetId,
        argumentRoots: callArguments(node).map((argument) => rootIdentifier(argument)),
      }, 0);
    }
    return createsFreshEngineValue(node) ? { kind: "local" } : { kind: "external" };
  }
  return mutationOriginForRoot(fn, rootIdentifier(node)) ?? { kind: "external" };
}

function cachedMutationCalls(fn: FunctionRecord): CachedMutationCall[] {
  return fn.mutationCalls.map((call) => ({
    targetId: call.targetId,
    site: call.site,
    receiverOrigin: mutationOriginForRoot(fn, call.receiverRoot),
    argumentOrigins: call.argumentRoots.map((root) => mutationOriginForRoot(fn, root)),
  }));
}

function cachedFunctionState(fn: FunctionRecord): CachedSourceEffectFunction {
  return {
    id: fn.id,
    moduleId: fn.moduleId,
    localName: fn.localName,
    memberName: fn.memberName,
    exported: fn.exported,
    directEffect: fn.directEffect,
    ...(fn.effectSite ? { effectSite: fn.effectSite } : {}),
    ...(fn.receiverSite ? { receiverSite: fn.receiverSite } : {}),
    mutatesReceiver: fn.mutatesReceiver,
    mutatedParameterIndexes: [...fn.mutatedParameterIndexes].sort((a, b) => a - b),
    dependencies: [...fn.dependencies].sort(),
    mutationCalls: cachedMutationCalls(fn),
    mutatedOrigins: fn.mutatedResults.map((result) => resultOrigin(fn, result, 0)),
    mutatedOriginSites: fn.mutatedResultSites,
    returnOrigins: fn.returnOrigins,
  };
}

function applyCachedMutationOrigin(
  fn: CachedSourceEffectFunction,
  origin: CachedMutationOrigin | null,
  byId: Map<string, CachedSourceEffectFunction>,
  site: EffectSite | undefined,
  depth = 0,
): boolean {
  if (!origin || origin.kind === "local" || depth >= MAX_RESULT_DEPTH) return false;
  if (origin.kind === "external") return markDirectEffect(fn, site);
  if (origin.kind === "result") {
    // Mutating a call result mutates whatever the callee can return
    const target = byId.get(origin.targetId);
    const returns = target?.returnOrigins ?? [{ kind: "external" } as const];
    let changed = false;
    for (const returned of returns) {
      if (applyCachedMutationOrigin(fn, substituteArguments(returned, origin.argumentOrigins), byId, site, depth + 1)) changed = true;
    }
    return changed;
  }
  if (origin.kind === "receiver") {
    if (fn.mutatesReceiver) return false;
    fn.mutatesReceiver = true;
    fn.receiverSite ??= site;
    return true;
  }
  if (fn.mutatedParameterIndexes.includes(origin.index)) return false;
  fn.mutatedParameterIndexes.push(origin.index);
  fn.mutatedParameterIndexes.sort((a, b) => a - b);
  return true;
}

// Callee origins name callee parameters, so map them onto the caller's arguments
function substituteArguments(
  origin: CachedMutationOrigin,
  argumentOrigins: Array<CachedMutationOrigin | null>,
): CachedMutationOrigin | null {
  if (origin.kind === "parameter") return argumentOrigins[origin.index] ?? { kind: "local" };
  if (origin.kind === "receiver") return { kind: "external" };
  if (origin.kind === "result") {
    return {
      kind: "result",
      targetId: origin.targetId,
      argumentOrigins: origin.argumentOrigins.map((argument) => argument && substituteArguments(argument, argumentOrigins)),
    };
  }
  return origin;
}

function propagateMutationEffects(functions: CachedSourceEffectFunction[]): void {
  const byId = new Map(functions.map((fn) => [fn.id, fn] as const));
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of functions) {
      for (const [index, origin] of (fn.mutatedOrigins ?? []).entries()) {
        if (applyCachedMutationOrigin(fn, origin, byId, fn.mutatedOriginSites?.[index])) changed = true;
      }
      for (const call of fn.mutationCalls) {
        const target = byId.get(call.targetId);
        if (!target) continue;
        if (target.mutatesReceiver && applyCachedMutationOrigin(fn, call.receiverOrigin, byId, call.site)) changed = true;
        for (const index of target.mutatedParameterIndexes) {
          if (applyCachedMutationOrigin(fn, call.argumentOrigins[index] ?? null, byId, call.site)) changed = true;
        }
      }
    }
  }
}

export async function indexEffectModuleForWorker(
  input: EffectWorkerIndexInput,
  moduleAliases: Map<string, string>,
): Promise<{ indexed: IndexedEffectWorkerModule; state: EffectWorkerState; tree: SyntaxTree }> {
  const tree = await parseLuau(input.source);
  const imports = topLevelImports(tree.rootNode, moduleAliases);

  const record: ParsedRecord = {
    id: input.id,
    keys: input.keys,
    source: input.source,
    tree,
    exportName: topLevelReturnName(tree.rootNode),
    imports,
  };
  const functions = topLevelFunctionRecords(record);
  const instanceFactories: string[] = [];
  for (const fn of functions) {
    if (fn.memberName && returnedFactoryMember(fn, record.exportName)) instanceFactories.push(fn.memberName);
  }
  const exportedFunctionId = functions.find((fn) => fn.exported && !fn.memberName)?.id;

  return {
    indexed: {
      id: input.id,
      relativePath: input.relativePath,
      importedModuleIds: [...new Set(imports.values())].sort(),
      instanceFactories: instanceFactories.sort(),
      exportedFunctionId,
    },
    state: { relativePath: input.relativePath, source: input.source, record, functions },
    tree,
  };
}

export function analyzeEffectModuleForWorker(
  state: EffectWorkerState,
  moduleSummaries: Map<string, SourceEffectModuleSummary>,
  exportedFunctions: Map<string, string>,
): AnalyzedEffectWorkerModule {
  const localFunctions = new Map<string, string>();
  const memberFunctions = new Map<string, string>();
  for (const fn of state.functions) {
    if (fn.localName) localFunctions.set(fn.localName, fn.id);
    if (fn.memberName) memberFunctions.set(fn.memberName, fn.id);
  }
  const moduleInstances = moduleLevelInstanceAliases(state.record, moduleSummaries);
  const caches = moduleCacheTables(state.record);
  for (const fn of state.functions) {
    analyzeFunction(fn, state.record, localFunctions, memberFunctions, moduleSummaries, moduleInstances, exportedFunctions, caches);
  }
  propagateLocalMutationEffects(state.functions);
  return {
    id: state.record.id,
    functions: state.functions.map(cachedFunctionState),
  };
}

export async function buildProjectSourceEffects(
  root: string,
  candidates: ScanFileInput[],
  parseCache?: Map<string, ProjectEffectParseCacheEntry>,
  onProgress?: (progress: ProjectEffectsProgress) => void,
  fileHashes: Readonly<Record<string, string>> = {},
  cachedModules: Readonly<Record<string, CachedSourceEffectModule>> = {},
  workerPool?: AnalysisWorkerPool,
): Promise<ProjectSourceEffectsBuildResult> {
  interface CandidateIdentity extends ModuleIdentity {
    relativePath: string;
    candidate: ScanFileInput;
    hash: string;
  }

  const identities: CandidateIdentity[] = [];
  for (const candidate of candidates) {
    const relativePath = normalizeRelative(candidate.relativePath ?? path.relative(root, candidate.absolutePath));
    const id = relativePath.toLowerCase();
    identities.push({
      id,
      keys: moduleKeys(relativePath),
      relativePath,
      candidate,
      hash: fileHashes[relativePath] ?? "",
    });
  }

  const moduleIdFeatures = new Map(identities.map((record) => [record.id, record.id] as const));
  const moduleAliases = buildUniqueFeatureAliases(identities, moduleIdFeatures);
  const currentIds = new Set(identities.map((identity) => identity.id));
  const cachedIds = new Set(Object.values(cachedModules).map((module) => module.id));
  const sameFileSet = currentIds.size === cachedIds.size && [...currentIds].every((id) => cachedIds.has(id));

  const dirtyIds = new Set<string>();
  if (!sameFileSet) {
    for (const identity of identities) dirtyIds.add(identity.id);
  } else {
    for (const identity of identities) {
      const cached = cachedModules[identity.relativePath];
      if (!cached || cached.hash !== identity.hash) dirtyIds.add(identity.id);
    }

    // A changed module can alter whether one of its members is an instance
    // factory. Re-analyze direct importers so instance-method dependencies are
    // refreshed, while all other unchanged modules keep their cached graph.
    if (dirtyIds.size > 0) {
      for (const module of Object.values(cachedModules)) {
        if (module.importedModuleIds.some((moduleId) => dirtyIds.has(moduleId))) dirtyIds.add(module.id);
      }
    }
  }

  const cachedFunctionStates = new Map<string, CachedSourceEffectFunction[]>();
  const analyzedFunctionStatesByModule = new Map<string, CachedSourceEffectFunction[]>();
  const importedModuleIdsByModule = new Map<string, string[]>();
  const summariesByModuleId = new Map<string, SourceEffectModuleSummary>();
  const exportedFunctions = new Map<string, string>();

  if (workerPool && dirtyIds.size >= 16) {
    const workerInputs: EffectWorkerIndexInput[] = [];
    for (const identity of identities) {
      if (!dirtyIds.has(identity.id)) continue;
      const { candidate } = identity;
      if (candidate.source === undefined && !fs.existsSync(candidate.absolutePath)) continue;
      workerInputs.push({
        id: identity.id,
        keys: identity.keys,
        relativePath: identity.relativePath,
        source: candidate.source ?? fs.readFileSync(candidate.absolutePath, "utf8"),
      });
    }

    let parsedCount = identities.length - workerInputs.length;
    onProgress?.({ phase: "parse", current: parsedCount, total: candidates.length });
    const indexedModules = await workerPool.indexEffectModules(workerInputs, moduleAliases, (count, file) => {
      parsedCount += count;
      onProgress?.({ phase: "parse", current: Math.min(parsedCount, candidates.length), total: candidates.length, file });
    });
    onProgress?.({ phase: "parse", current: candidates.length, total: candidates.length });

    const indexedById = new Map(indexedModules.map((module) => [module.id, module] as const));
    const functionIndexTotal = Math.max(1, identities.length * 2);
    onProgress?.({ phase: "index-functions", current: 0, total: functionIndexTotal });

    for (let identityIndex = 0; identityIndex < identities.length; identityIndex += 1) {
      const identity = identities[identityIndex];
      const indexed = indexedById.get(identity.id);
      if (indexed) {
        importedModuleIdsByModule.set(identity.id, indexed.importedModuleIds);
        summariesByModuleId.set(identity.id, {
          effectfulMembers: new Set<string>(),
          effectfulExport: false,
          mutatingMembers: new Set<string>(),
          mutatingExportParameters: new Set<number>(),
          mutatingMemberParameters: new Map<string, Set<number>>(),
          localMutatingParameters: new Map<string, Set<number>>(),
          instanceFactories: new Set(indexed.instanceFactories),
        });
        if (indexed.exportedFunctionId) exportedFunctions.set(identity.id, indexed.exportedFunctionId);
      } else {
        const cached = cachedModules[identity.relativePath];
        const functions = cached?.functions ?? [];
        cachedFunctionStates.set(identity.id, functions);
        importedModuleIdsByModule.set(identity.id, cached?.importedModuleIds ?? []);
        summariesByModuleId.set(identity.id, {
          effectfulMembers: new Set<string>(),
          effectfulExport: false,
          mutatingMembers: new Set<string>(),
          mutatingExportParameters: new Set<number>(),
          mutatingMemberParameters: new Map<string, Set<number>>(),
          localMutatingParameters: new Map<string, Set<number>>(),
          instanceFactories: new Set(cached?.instanceFactories ?? []),
        });
        const exported = functions.find((fn) => fn.exported && !fn.memberName);
        if (exported) exportedFunctions.set(identity.id, exported.id);
      }
      if ((identityIndex & 63) === 63 || identityIndex + 1 === identities.length) {
        onProgress?.({ phase: "index-functions", current: Math.min(functionIndexTotal, identityIndex + 1), total: functionIndexTotal });
      }
    }
    onProgress?.({ phase: "index-functions", current: functionIndexTotal, total: functionIndexTotal });

    const callAnalysisTotal = Math.max(1, indexedModules.length);
    let analyzedCount = 0;
    onProgress?.({ phase: "analyze-calls", current: 0, total: callAnalysisTotal });
    const analyzedModules = await workerPool.analyzeEffectModules(summariesByModuleId, exportedFunctions, (count) => {
      analyzedCount += count;
      onProgress?.({ phase: "analyze-calls", current: Math.min(analyzedCount, callAnalysisTotal), total: callAnalysisTotal });
    });
    for (const module of analyzedModules) analyzedFunctionStatesByModule.set(module.id, module.functions);
    onProgress?.({ phase: "analyze-calls", current: callAnalysisTotal, total: callAnalysisTotal });
  } else {
    const rawRecords = new Map<string, ParsedRecord>();
    onProgress?.({ phase: "parse", current: 0, total: candidates.length });
    for (let candidateIndex = 0; candidateIndex < identities.length; candidateIndex += 1) {
      const identity = identities[candidateIndex];
      const { candidate, relativePath } = identity;
      try {
        if (!dirtyIds.has(identity.id)) continue;
        if (candidate.source === undefined && !fs.existsSync(candidate.absolutePath)) continue;
        const source = candidate.source ?? fs.readFileSync(candidate.absolutePath, "utf8");
        const tree = await parseLuau(source);
        parseCache?.set(relativePath, { source, tree });
        const imports = topLevelImports(tree.rootNode, moduleAliases);
        rawRecords.set(identity.id, {
          id: identity.id,
          keys: identity.keys,
          source,
          tree,
          exportName: topLevelReturnName(tree.rootNode),
          imports,
        });
      } catch {
        // Parse diagnostics are handled by the normal scanner. An unparseable module
        // simply cannot contribute source-derived effect information.
      } finally {
        onProgress?.({ phase: "parse", current: candidateIndex + 1, total: candidates.length, file: relativePath });
      }
    }

    const functionIndexTotal = Math.max(1, identities.length * 2);
    onProgress?.({ phase: "index-functions", current: 0, total: functionIndexTotal });
    const functionsByModule = new Map<string, FunctionRecord[]>();

    for (const identity of identities) {
      const record = rawRecords.get(identity.id);
      if (record) {
        const functions = topLevelFunctionRecords(record);
        functionsByModule.set(identity.id, functions);
        importedModuleIdsByModule.set(identity.id, [...new Set(record.imports.values())].sort());
        const summary: SourceEffectModuleSummary = {
          effectfulMembers: new Set<string>(),
          effectfulExport: false,
          mutatingMembers: new Set<string>(),
          mutatingExportParameters: new Set<number>(),
          mutatingMemberParameters: new Map<string, Set<number>>(),
          localMutatingParameters: new Map<string, Set<number>>(),
          instanceFactories: new Set<string>(),
        };
        for (const fn of functions) {
          if (fn.memberName && returnedFactoryMember(fn, record.exportName)) summary.instanceFactories.add(fn.memberName);
        }
        summariesByModuleId.set(identity.id, summary);
      } else {
        const cached = cachedModules[identity.relativePath];
        cachedFunctionStates.set(identity.id, cached?.functions ?? []);
        importedModuleIdsByModule.set(identity.id, cached?.importedModuleIds ?? []);
        summariesByModuleId.set(identity.id, {
          effectfulMembers: new Set<string>(),
          effectfulExport: false,
          mutatingMembers: new Set<string>(),
          mutatingExportParameters: new Set<number>(),
          mutatingMemberParameters: new Map<string, Set<number>>(),
          localMutatingParameters: new Map<string, Set<number>>(),
          instanceFactories: new Set(cached?.instanceFactories ?? []),
        });
      }
      const indexedCount = summariesByModuleId.size;
      if ((indexedCount & 63) === 0 || indexedCount === identities.length) {
        onProgress?.({ phase: "index-functions", current: indexedCount, total: functionIndexTotal });
      }
    }

    for (let identityIndex = 0; identityIndex < identities.length; identityIndex += 1) {
      const identity = identities[identityIndex];
      const parsedFunctions = functionsByModule.get(identity.id);
      if (parsedFunctions) {
        const exported = parsedFunctions.find((fn) => fn.exported && !fn.memberName);
        if (exported) exportedFunctions.set(identity.id, exported.id);
      } else {
        const exported = (cachedFunctionStates.get(identity.id) ?? []).find((fn) => fn.exported && !fn.memberName);
        if (exported) exportedFunctions.set(identity.id, exported.id);
      }
      if ((identityIndex & 63) === 63 || identityIndex + 1 === identities.length) {
        onProgress?.({ phase: "index-functions", current: identities.length + identityIndex + 1, total: functionIndexTotal });
      }
    }

    const callAnalysisTotal = Math.max(1, rawRecords.size);
    onProgress?.({ phase: "analyze-calls", current: 0, total: callAnalysisTotal });
    let analyzedModuleCount = 0;
    for (const [moduleId, record] of rawRecords) {
      const localFunctions = new Map<string, string>();
      const memberFunctions = new Map<string, string>();
      const functions = functionsByModule.get(moduleId) ?? [];
      for (const fn of functions) {
        if (fn.localName) localFunctions.set(fn.localName, fn.id);
        if (fn.memberName) memberFunctions.set(fn.memberName, fn.id);
      }
      const moduleInstances = moduleLevelInstanceAliases(record, summariesByModuleId);
      const caches = moduleCacheTables(record);
      for (const fn of functions) {
        analyzeFunction(fn, record, localFunctions, memberFunctions, summariesByModuleId, moduleInstances, exportedFunctions, caches);
      }
      propagateLocalMutationEffects(functions);
      analyzedFunctionStatesByModule.set(moduleId, functions.map(cachedFunctionState));
      analyzedModuleCount += 1;
      if ((analyzedModuleCount & 31) === 0 || analyzedModuleCount === rawRecords.size) {
        onProgress?.({ phase: "analyze-calls", current: analyzedModuleCount, total: callAnalysisTotal });
      }
    }
  }

  const graphAssemblyTotal = Math.max(1, identities.length);
  onProgress?.({ phase: "assemble-graph", current: 0, total: graphAssemblyTotal });
  const functionStates = new Map<string, CachedSourceEffectFunction>();
  const cacheModulesResult: Record<string, CachedSourceEffectModule> = {};
  let assembledCount = 0;
  for (const identity of identities) {
    const states: CachedSourceEffectFunction[] = (analyzedFunctionStatesByModule.get(identity.id) ?? cachedFunctionStates.get(identity.id) ?? [])
      .map((fn) => ({
        ...fn,
        mutatesReceiver: fn.mutatesReceiver ?? false,
        mutatedParameterIndexes: [...(fn.mutatedParameterIndexes ?? [])],
        dependencies: [...fn.dependencies],
        mutationCalls: [...(fn.mutationCalls ?? [])],
      }));
    for (const fn of states) functionStates.set(fn.id, fn);
    const summary = summariesByModuleId.get(identity.id)!;
    cacheModulesResult[identity.relativePath] = {
      hash: identity.hash,
      id: identity.id,
      keys: identity.keys,
      importedModuleIds: importedModuleIdsByModule.get(identity.id) ?? [],
      functions: states,
      instanceFactories: [...summary.instanceFactories].sort(),
    };
    assembledCount += 1;
    if ((assembledCount & 63) === 0 || assembledCount === identities.length) {
      onProgress?.({ phase: "assemble-graph", current: assembledCount, total: graphAssemblyTotal });
    }
  }

  // Parameter/receiver mutation is conditional on what each caller passes.
  // Resolve that information across the complete project graph before seeding
  // unconditional side effects, so wrappers preserve precise parameter effects
  // instead of becoming globally impure.
  propagateMutationEffects([...functionStates.values()]);

  // Build a reverse dependency graph once, then propagate effectfulness only
  // through callers that can actually become affected. This avoids repeatedly
  // rescanning every function until a fixed point is reached.
  const reverseDependencies = new Map<string, string[]>();
  const functions = [...functionStates.values()];
  onProgress?.({ phase: "resolve", current: 0, total: functions.length });
  for (let index = 0; index < functions.length; index += 1) {
    const fn = functions[index];
    for (const dependency of fn.dependencies) {
      if (!functionStates.has(dependency)) continue;
      const dependents = reverseDependencies.get(dependency);
      if (dependents) dependents.push(fn.id);
      else reverseDependencies.set(dependency, [fn.id]);
    }
    if ((index & 127) === 127 || index + 1 === functions.length) {
      onProgress?.({ phase: "resolve", current: index + 1, total: functions.length });
    }
  }

  const effectful = new Set<string>();
  const queue: string[] = [];
  for (const fn of functions) {
    if (!fn.directEffect) continue;
    effectful.add(fn.id);
    queue.push(fn.id);
  }

  onProgress?.({ phase: "propagate", current: 0, total: Math.max(1, functions.length) });
  // The effectful callee each dependent was first reached through
  const effectSources = new Map<string, string>();
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const effectfulId = queue[queueIndex++];
    for (const dependent of reverseDependencies.get(effectfulId) ?? []) {
      if (effectful.has(dependent)) continue;
      effectful.add(dependent);
      effectSources.set(dependent, effectfulId);
      queue.push(dependent);
    }
    if ((queueIndex & 63) === 0 || queueIndex === queue.length) {
      onProgress?.({ phase: "propagate", current: Math.min(queueIndex, Math.max(1, functions.length)), total: Math.max(1, functions.length) });
    }
  }
  // The work queue may visit only the effectful subset of the graph. Explicitly
  // mark the phase complete once the queue is exhausted instead of leaving a
  // partially filled progress bar behind.
  onProgress?.({ phase: "propagate", current: Math.max(1, functions.length), total: Math.max(1, functions.length) });

  const relativePaths = new Map(identities.map((identity) => [identity.id, identity.relativePath] as const));
  const stepName = (fn: CachedSourceEffectFunction) => {
    const file = relativePaths.get(fn.moduleId) ?? fn.moduleId;
    const parts = file.replace(/\.luau?$/, "").split("/");
    const moduleName = parts.at(-1) === "init" && parts.length > 1 ? parts.at(-2)! : parts.at(-1)!;
    return fn.memberName ? `${moduleName}.${fn.memberName}` : fn.localName ?? moduleName;
  };
  const effectTrace = (fn: CachedSourceEffectFunction): SourceEffectStep[] => {
    const steps: SourceEffectStep[] = [];
    const seen = new Set<string>();
    for (let current: CachedSourceEffectFunction | undefined = fn; current && !seen.has(current.id);) {
      seen.add(current.id);
      const sourceId = effectSources.get(current.id);
      const site = sourceId
        ? current.mutationCalls.find((call) => call.targetId === sourceId)?.site
        : current.effectSite;
      steps.push({ name: stepName(current), file: relativePaths.get(current.moduleId) ?? current.moduleId, ...site });
      current = sourceId ? functionStates.get(sourceId) : undefined;
    }
    return steps;
  };

  const summarizeTotal = Math.max(1, functions.length + 1);
  onProgress?.({ phase: "summarize", current: 0, total: summarizeTotal });
  for (const summary of summariesByModuleId.values()) {
    summary.effectfulMembers.clear();
    summary.effectTraces = new Map();
    summary.receiverTraces = new Map();
    summary.effectfulExport = false;
    summary.mutatingMembers.clear();
    summary.mutatingExportParameters.clear();
    summary.mutatingMemberParameters.clear();
    summary.localMutatingParameters.clear();
  }
  for (let index = 0; index < functions.length; index += 1) {
    const fn = functions[index];
    const summary = summariesByModuleId.get(fn.moduleId);
    if (summary && fn.memberName && fn.mutatesReceiver) {
      summary.mutatingMembers.add(fn.memberName);
      summary.receiverTraces?.set(fn.memberName, [{ name: stepName(fn), file: relativePaths.get(fn.moduleId) ?? fn.moduleId, ...fn.receiverSite }]);
    }
    if (summary && fn.mutatedParameterIndexes.length > 0) {
      if (fn.exported && !fn.memberName) {
        for (const parameterIndex of fn.mutatedParameterIndexes) summary.mutatingExportParameters.add(parameterIndex);
      }
      if (fn.memberName) {
        summary.mutatingMemberParameters.set(fn.memberName, new Set(fn.mutatedParameterIndexes));
      }
      if (fn.localName) {
        summary.localMutatingParameters.set(fn.localName, new Set(fn.mutatedParameterIndexes));
      }
    }
    if (summary && effectful.has(fn.id)) {
      if (fn.memberName) summary.effectfulMembers.add(fn.memberName);
      if (fn.exported) summary.effectfulExport = true;
      if (fn.memberName || fn.exported) summary.effectTraces?.set(fn.memberName ?? "", effectTrace(fn));
    }
    if ((index & 127) === 127 || index + 1 === functions.length) {
      onProgress?.({ phase: "summarize", current: index + 1, total: summarizeTotal });
    }
  }

  // Alias construction can still be noticeable on large projects, so reserve
  // the final progress unit until it is genuinely complete.
  const effects = buildUniqueFeatureAliases(identities, summariesByModuleId);
  onProgress?.({ phase: "summarize", current: summarizeTotal, total: summarizeTotal });

  return {
    effects,
    cacheModules: cacheModulesResult,
  };
}

