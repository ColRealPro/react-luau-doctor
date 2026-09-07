import fs from "node:fs";
import path from "node:path";
import type { Node as SyntaxNode, Tree } from "web-tree-sitter";
import {
  buildUniqueFeatureAliases,
  moduleKeys,
  normalizeRequireTarget,
  resolveModuleReference,
  type ModuleIdentity,
} from "./module-resolution";
import { parseLuau } from "./parser";
import type { AnalysisWorkerPool } from "./parallel";
import type { ScanFileInput, SourceEffectModuleSummary } from "./types";


export interface ProjectEffectParseCacheEntry {
  source: string;
  tree: Tree;
}

export type CachedMutationOrigin =
  | { kind: "receiver" }
  | { kind: "parameter"; index: number }
  | { kind: "external" }
  | { kind: "local" };

export interface CachedMutationCall {
  targetId: string;
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
  mutatesReceiver: boolean;
  mutatedParameterIndexes: number[];
  dependencies: string[];
  mutationCalls: CachedMutationCall[];
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
  tree: Tree;
  exportName: string | null;
  imports: Map<string, string>;
}

interface MutationCall {
  targetId: string;
  receiverRoot: string | null;
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
  mutatesReceiver: boolean;
  mutatedParameterIndexes: Set<number>;
  dependencies: Set<string>;
  mutationCalls: MutationCall[];
  parameterOrigins: Map<string, number>;
  externalRoots: Set<string>;
  ownedRoots: Set<string>;
  localNames: Set<string>;
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
    names: variables?.namedChildren.filter((candidate) => candidate.type === "identifier").map((candidate) => candidate.text) ?? [],
    expressions: expressions?.namedChildren ?? [],
  };
}

function assignmentSides(node: SyntaxNode): { left: SyntaxNode[]; right: SyntaxNode[] } {
  if (node.type !== "assignment_statement") return { left: [], right: [] };
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

function rootIdentifier(node: SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (
    node.type === "dot_index_expression" ||
    node.type === "bracket_index_expression" ||
    node.type === "method_index_expression"
  ) {
    return rootIdentifier(node.namedChildren[0]);
  }
  const text = node.text.trim();
  return text.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? null;
}

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

function expressionCreatesOwnedValue(node: SyntaxNode, owned: Set<string>): boolean {
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
      mutatesReceiver: false,
      mutatedParameterIndexes: new Set<number>(),
      dependencies: new Set<string>(),
      mutationCalls: [],
      parameterOrigins: new Map<string, number>(),
      externalRoots: new Set<string>(),
      ownedRoots: new Set<string>(),
      localNames: new Set<string>(),
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

function analyzeFunction(
  fn: FunctionRecord,
  record: ParsedRecord,
  localFunctions: Map<string, string>,
  memberFunctions: Map<string, string>,
  moduleSummaries: Map<string, SourceEffectModuleSummary>,
  moduleInstances: Map<string, string>,
  exportedFunctions: Map<string, string>,
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
  const refLocals = new Set<string>();
  const instanceAliases = new Map(moduleInstances);
  const nodes = directNodes(fn.body);

  for (const node of nodes) {
    if (node.type === "function_declaration" && node.id !== fn.node.id) {
      const declared = node.childForFieldName("name")?.text.replace(/\s+/g, "") ?? "";
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(declared)) locals.add(declared);
      continue;
    }
    if (node.type !== "variable_declaration") continue;
    const { names, expressions } = declarationParts(node);
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index];
      const expression = expressions[index] ?? expressions[0];
      locals.add(name);
      if (!expression) continue;
      const createsOwnedValue = expressionCreatesOwnedValue(expression, owned);
      if (createsOwnedValue) owned.add(name);
      const root = rootIdentifier(expression);
      const parameterOrigin = root ? parameterOrigins.get(root) : undefined;
      if (!createsOwnedValue && root && parameterOrigin !== undefined) {
        // Keep argument/receiver mutation conditional. A caller may pass a fresh
        // render-local value, so it must not become an unconditional effect.
        parameterOrigins.set(name, parameterOrigin);
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

  fn.parameterOrigins = parameterOrigins;
  fn.externalRoots = externalAliases;
  fn.ownedRoots = owned;
  fn.localNames = locals;

  // Luau locals are lexically scoped from their declaration onward, so the
  // source-order pass above is enough to propagate aliases through local
  // declarations. Repeated fixed-point rescans of every function body were
  // redundant and particularly expensive on large modules.
  for (const node of nodes) {
    if (node.type === "assignment_statement" && node.parent?.type !== "variable_declaration") {
      const { left } = assignmentSides(node);
      for (const target of left) {
        if (target.type === "identifier") {
          if (!locals.has(target.text) && !parameters.has(target.text)) fn.directEffect = true;
          continue;
        }
        const root = rootIdentifier(target);
        if (!root) continue;
        if (owned.has(root)) continue;
        if (refLocals.has(root) && target.text.replace(/\s+/g, "") === `${root}.current`) continue;
        const parameterOrigin = parameterOrigins.get(root);
        if (parameterOrigin !== undefined) {
          if (parameterOrigin === -1) fn.mutatesReceiver = true;
          else fn.mutatedParameterIndexes.add(parameterOrigin);
          continue;
        }
        if (externalAliases.has(root) || !locals.has(root)) fn.directEffect = true;
      }
      continue;
    }

    if (node.type !== "function_call") continue;
    const path = callPath(node);
    if (!path) continue;
    const arguments_ = callArguments(node);

    for (const index of builtinMutatedArgumentIndexes(path, arguments_.length)) {
      markMutationThroughRoot(fn, rootIdentifier(arguments_[index]));
    }

    const localTarget = !locals.has(path) && !parameters.has(path) ? localFunctions.get(path) : null;
    if (localTarget) {
      fn.dependencies.add(localTarget);
      fn.mutationCalls.push({
        targetId: localTarget,
        receiverRoot: null,
        argumentRoots: arguments_.map((argument) => rootIdentifier(argument)),
      });
    }

    const sameMember = path.match(/^([A-Za-z_][A-Za-z0-9_]*)([:.])([A-Za-z_][A-Za-z0-9_]*)$/);
    if (sameMember) {
      const receiver = sameMember[1];
      if (receiver === "self" || (receiver === record.exportName && !locals.has(receiver) && !parameters.has(receiver))) {
        const target = memberFunctions.get(sameMember[3]);
        if (target) {
          fn.dependencies.add(target);
          fn.mutationCalls.push({
            targetId: target,
            receiverRoot: sameMember[2] === ":" ? receiver : null,
            argumentRoots: arguments_.map((argument) => rootIdentifier(argument)),
          });
        }
      }
    }

    const importedMember = path.match(/^([A-Za-z_][A-Za-z0-9_]*)([.:])([A-Za-z_][A-Za-z0-9_]*)$/);
    if (importedMember) {
      const root = importedMember[1];
      const moduleId = instanceAliases.get(root)
        ?? (!locals.has(root) && !parameters.has(root) ? record.imports.get(root) : undefined);
      if (moduleId) {
        const target = `${moduleId}::member:${importedMember[3]}`;
        fn.dependencies.add(target);
        fn.mutationCalls.push({
          targetId: target,
          receiverRoot: importedMember[2] === ":" ? root : null,
          argumentRoots: arguments_.map((argument) => rootIdentifier(argument)),
        });
      }
    } else if (!locals.has(path) && !parameters.has(path)) {
      const moduleId = record.imports.get(path);
      const target = moduleId ? exportedFunctions.get(moduleId) : null;
      if (target) {
        fn.dependencies.add(target);
        fn.mutationCalls.push({
          targetId: target,
          receiverRoot: null,
          argumentRoots: arguments_.map((argument) => rootIdentifier(argument)),
        });
      }
    }
  }
}

function markMutationThroughRoot(fn: FunctionRecord, root: string | null): boolean {
  if (!root) return false;
  const parameterOrigin = fn.parameterOrigins.get(root);
  if (parameterOrigin !== undefined) {
    if (parameterOrigin === -1) {
      if (fn.mutatesReceiver) return false;
      fn.mutatesReceiver = true;
      return true;
    }
    if (fn.mutatedParameterIndexes.has(parameterOrigin)) return false;
    fn.mutatedParameterIndexes.add(parameterOrigin);
    return true;
  }

  if (fn.ownedRoots.has(root)) return false;
  if (fn.externalRoots.has(root) || !fn.localNames.has(root)) {
    if (fn.directEffect) return false;
    fn.directEffect = true;
    return true;
  }
  if (fn.localNames.has(root)) return false;
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
        if (target.mutatesReceiver && markMutationThroughRoot(fn, call.receiverRoot)) changed = true;
        for (const index of target.mutatedParameterIndexes) {
          if (markMutationThroughRoot(fn, call.argumentRoots[index] ?? null)) changed = true;
        }
      }
    }
  }
}

function mutationOriginForRoot(fn: FunctionRecord, root: string | null): CachedMutationOrigin | null {
  if (!root) return null;
  const parameterOrigin = fn.parameterOrigins.get(root);
  if (parameterOrigin === -1) return { kind: "receiver" };
  if (parameterOrigin !== undefined) return { kind: "parameter", index: parameterOrigin };
  if (fn.ownedRoots.has(root) || fn.localNames.has(root)) return { kind: "local" };
  if (fn.externalRoots.has(root) || !fn.localNames.has(root)) return { kind: "external" };
  return null;
}

function cachedMutationCalls(fn: FunctionRecord): CachedMutationCall[] {
  return fn.mutationCalls.map((call) => ({
    targetId: call.targetId,
    receiverOrigin: mutationOriginForRoot(fn, call.receiverRoot),
    argumentOrigins: call.argumentRoots.map((root) => mutationOriginForRoot(fn, root)),
  }));
}

function applyCachedMutationOrigin(fn: CachedSourceEffectFunction, origin: CachedMutationOrigin | null): boolean {
  if (!origin || origin.kind === "local") return false;
  if (origin.kind === "external") {
    if (fn.directEffect) return false;
    fn.directEffect = true;
    return true;
  }
  if (origin.kind === "receiver") {
    if (fn.mutatesReceiver) return false;
    fn.mutatesReceiver = true;
    return true;
  }
  if (fn.mutatedParameterIndexes.includes(origin.index)) return false;
  fn.mutatedParameterIndexes.push(origin.index);
  fn.mutatedParameterIndexes.sort((a, b) => a - b);
  return true;
}

function propagateMutationEffects(functions: CachedSourceEffectFunction[]): void {
  const byId = new Map(functions.map((fn) => [fn.id, fn] as const));
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of functions) {
      for (const call of fn.mutationCalls) {
        const target = byId.get(call.targetId);
        if (!target) continue;
        if (target.mutatesReceiver && applyCachedMutationOrigin(fn, call.receiverOrigin)) changed = true;
        for (const index of target.mutatedParameterIndexes) {
          if (applyCachedMutationOrigin(fn, call.argumentOrigins[index] ?? null)) changed = true;
        }
      }
    }
  }
}

export async function indexEffectModuleForWorker(
  input: EffectWorkerIndexInput,
  moduleAliases: Map<string, string>,
): Promise<{ indexed: IndexedEffectWorkerModule; state: EffectWorkerState; tree: Tree }> {
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
  for (const fn of state.functions) {
    analyzeFunction(fn, state.record, localFunctions, memberFunctions, moduleSummaries, moduleInstances, exportedFunctions);
  }
  propagateLocalMutationEffects(state.functions);
  return {
    id: state.record.id,
    functions: state.functions.map((fn) => ({
      id: fn.id,
      moduleId: fn.moduleId,
      localName: fn.localName,
      memberName: fn.memberName,
      exported: fn.exported,
      directEffect: fn.directEffect,
      mutatesReceiver: fn.mutatesReceiver,
      mutatedParameterIndexes: [...fn.mutatedParameterIndexes].sort((a, b) => a - b),
      dependencies: [...fn.dependencies].sort(),
      mutationCalls: cachedMutationCalls(fn),
    })),
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
      for (const fn of functions) {
        analyzeFunction(fn, record, localFunctions, memberFunctions, summariesByModuleId, moduleInstances, exportedFunctions);
      }
      propagateLocalMutationEffects(functions);
      analyzedFunctionStatesByModule.set(moduleId, functions.map((fn) => ({
        id: fn.id,
        moduleId: fn.moduleId,
        localName: fn.localName,
        memberName: fn.memberName,
        exported: fn.exported,
        directEffect: fn.directEffect,
        mutatesReceiver: fn.mutatesReceiver,
        mutatedParameterIndexes: [...fn.mutatedParameterIndexes].sort((a, b) => a - b),
        dependencies: [...fn.dependencies].sort(),
        mutationCalls: cachedMutationCalls(fn),
      })));
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
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const effectfulId = queue[queueIndex++];
    for (const dependent of reverseDependencies.get(effectfulId) ?? []) {
      if (effectful.has(dependent)) continue;
      effectful.add(dependent);
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

  const summarizeTotal = Math.max(1, functions.length + 1);
  onProgress?.({ phase: "summarize", current: 0, total: summarizeTotal });
  for (const summary of summariesByModuleId.values()) {
    summary.effectfulMembers.clear();
    summary.effectfulExport = false;
    summary.mutatingMembers.clear();
    summary.mutatingExportParameters.clear();
    summary.mutatingMemberParameters.clear();
    summary.localMutatingParameters.clear();
  }
  for (let index = 0; index < functions.length; index += 1) {
    const fn = functions[index];
    const summary = summariesByModuleId.get(fn.moduleId);
    if (summary && fn.memberName && fn.mutatesReceiver) summary.mutatingMembers.add(fn.memberName);
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

