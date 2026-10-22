import { resolveLocalValue, unwrapExpression } from "../ast/local-values";
import { normalizeExpressionText, sameNode } from "../ast/walk";
import { normalizeRequireTarget, resolveModuleReference } from "../module-resolution";
import { hookReturnsStoreCopies } from "../project-model";
import type { SyntaxNode } from "../syntax";
import type { DiagnosticInput, FunctionInfo, RuleContext, RuleDefinition, StateBinding } from "../types";

import {
  callNameNode,
  containsIdentifier,
  declarationNames,
  dependencyExpressions,
  fieldName,
  fieldValue,
  functionInfoForNode,
  isEffectPath,
  isHookPath,
  stateBindingsFor,
} from "./helpers";

const RENDER_CALLBACK_HOOKS = new Set(["React.useCallback", "React.useMemo"]);
const DEFERRED_CALLS = new Set(["task.spawn", "task.defer", "task.delay", "spawn", "delay"]);
const COMPARISONS = new Set(["==", "~=", "<", "<=", ">", ">="]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function listText(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function hasOperator(node: SyntaxNode, operators: Set<string>): boolean {
  return node.children.some((child) => operators.has(child.type));
}

// `useStore()` or `useStore() or fallback`
function hookCallIn(value: SyntaxNode): SyntaxNode | null {
  const node = unwrapExpression(value);

  if (node.type === "binary_expression" && hasOperator(node, new Set(["or"]))) {
    const left = node.childForFieldName("left");
    return left ? hookCallIn(left) : null;
  }

  return node.type === "function_call" ? node : null;
}

function snapshotHookName(context: RuleContext, dependency: SyntaxNode): string | null {
  if (dependency.type !== "identifier") return null;

  const resolved = resolveLocalValue(context, dependency);
  const call = resolved && resolved.returnIndex === 0 ? hookCallIn(resolved.value) : null;
  const callee = call?.childForFieldName("name");

  if (callee?.type !== "identifier") return null;

  const hook = resolveLocalValue(context, callee);
  if (!hook || hook.returnIndex !== 0) return null;

  const local = context.model.functionByNode.get(hook.value.id);

  if (local) return local.isHook && local.name && hookReturnsStoreCopies(local.node.text, local.name) ? local.name : null;

  if (context.getCallPath(hook.value) !== "require") return null;

  const target = context.callArguments(hook.value)[0];

  return target ? resolveModuleReference(normalizeRequireTarget(target.text), context.project.snapshotHooks) : null;
}

function callReceivingFunction(context: RuleContext, fn: FunctionInfo): string | null {
  const args = fn.node.parent;
  const call = args?.parent;

  if (call?.type !== "function_call" || !sameNode(call.childForFieldName("arguments"), args)) return null;

  return context.resolveCallPath(context.getCallPath(call) ?? "");
}

function hookReceivingFunction(context: RuleContext, fn: FunctionInfo): string | null {
  const path = callReceivingFunction(context, fn);

  return path && isHookPath(path) ? path : null;
}

// Code in the effect itself, or in work it schedules with task.spawn and similar, runs on every re-run
function runsWithEffect(context: RuleContext, node: SyntaxNode, effect: FunctionInfo): boolean {
  let fn = context.nearestFunction(node);

  while (fn && fn !== effect) {
    if (!DEFERRED_CALLS.has(callReceivingFunction(context, fn) ?? "")) return false;

    fn = context.nearestFunction(fn.node);
  }

  return fn === effect;
}

// Innermost first, or null when the node is not inside owner
function functionsBetween(context: RuleContext, node: SyntaxNode, owner: FunctionInfo): FunctionInfo[] | null {
  const chain: FunctionInfo[] = [];
  let fn = context.nearestFunction(node);

  while (fn && fn !== owner) {
    chain.push(fn);
    fn = context.nearestFunction(fn.node);
  }

  return fn === owner ? chain : null;
}

function functionLabel(fn: FunctionInfo): string | null {
  if (fn.name) return fn.name;

  return fn.node.parent?.type === "field" ? fieldName(fn.node.parent) : null;
}

// Places outside effects and hook callbacks where the setter runs or is handed out, which
// makes the state something the user edits rather than a mirror of the store
function handlerEdits(context: RuleContext, owner: FunctionInfo, setterName: string): string[] {
  const labels = new Set<string>();

  for (const node of context.walk(owner.body ?? owner.node)) {
    if (node.type !== "identifier" || node.text !== setterName) continue;

    const parent = node.parent;
    if (parent?.type === "dot_index_expression" && sameNode(parent.childForFieldName("field"), node)) continue;

    const chain = functionsBetween(context, node, owner);
    if (!chain) continue;

    if (chain.some((fn) => {
      const hook = hookReceivingFunction(context, fn);
      return hook !== null && !RENDER_CALLBACK_HOOKS.has(hook);
    }))
      continue;

    const isCall = parent?.type === "function_call" && sameNode(parent.childForFieldName("name"), node);

    if (isCall) {
      if (chain.length === 0 || hookReceivingFunction(context, chain[0]) === "React.useMemo") continue;

      labels.add(chain.map(functionLabel).find(Boolean) ?? "a handler");
    } else if (parent?.type === "field" && sameNode(fieldValue(parent), node) && parent.childForFieldName("name")) {
      labels.add(fieldName(parent) ?? "a handler");
    } else if (owner.isHook && chain.length === 0 && parent?.type === "expression_list" && parent.parent?.type === "return_statement") {
      labels.add(`callers of ${owner.name ?? "this hook"}`);
    }
  }

  return [...labels];
}

function containsAny(node: SyntaxNode | null | undefined, names: Set<string>, context: RuleContext): boolean {
  return [...names].some((name) => containsIdentifier(node, name, context));
}

// Locals in the effect that hold data read from the snapshot
function snapshotDerivedNames(context: RuleContext, effect: FunctionInfo, snapshot: string): Set<string> {
  const names = new Set([snapshot]);

  for (const node of context.walk(effect.body ?? effect.node)) {
    if (!runsWithEffect(context, node, effect)) continue;

    if (node.type === "variable_declaration") {
      if (containsAny(node.namedChildren[0]?.namedChildren.find((child) => child.type === "expression_list"), names, context))
        for (const name of declarationNames(node)) names.add(name);
    } else if (node.type === "for_statement") {
      const header = node.text.split(/\bdo\b/, 1)[0];
      const loop = header.match(/^\s*for\s+(.+?)\s*(?:=|\bin\b)([\s\S]*)$/);

      if (loop && [...names].some((name) => new RegExp(`\\b${name}\\b`).test(loop[2])))
        for (const part of loop[1].split(",")) {
          const name = part.trim().match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
          if (name) names.add(name);
        }
    }
  }

  return names;
}

// Static fields the effect reads from the snapshot, or null when it uses the table as a whole
function readFields(context: RuleContext, effect: FunctionInfo, snapshot: string): string[] | null {
  const fields = new Set<string>();

  for (const node of context.walk(effect.body ?? effect.node)) {
    if (node.type !== "identifier" || node.text !== snapshot) continue;

    const parent = node.parent;

    if (parent?.type === "dot_index_expression" && sameNode(parent.childForFieldName("field"), node)) continue;
    if (!parent || !sameNode(parent.namedChildren[0], node) || parent.parent?.type === "variable_list") return null;

    const key = parent.childForFieldName("field");

    if (parent.type === "dot_index_expression" && key) fields.add(`${snapshot}.${key.text}`);
    else if (parent.type === "bracket_index_expression" && key?.type === "string" && IDENTIFIER.test(key.text.slice(1, -1)))
      fields.add(`${snapshot}.${key.text.slice(1, -1)}`);
    else return null;
  }

  return fields.size > 0 ? [...fields] : null;
}

// The other side of a comparison the identifier takes part in, looking through `not` and parentheses
function comparedOperand(node: SyntaxNode): SyntaxNode | null {
  let current = node;

  while (
    current.parent?.type === "parenthesized_expression" ||
    (current.parent?.type === "unary_expression" && hasOperator(current.parent, new Set(["not"])))
  )
    current = current.parent;

  const parent = current.parent;
  if (parent?.type !== "binary_expression" || !hasOperator(parent, COMPARISONS)) return null;

  const left = parent.childForFieldName("left");

  return sameNode(left, current) ? parent.childForFieldName("right") : left;
}

function returnsFrom(context: RuleContext, node: SyntaxNode): boolean {
  const owner = context.nearestFunction(node);

  return [...context.walk(node)].some((child) => child.type === "return_statement" && context.nearestFunction(child) === owner);
}

interface WriteFacts {
  effect: FunctionInfo;
  // State this effect sets, which a seed guard checks before writing
  written: Set<string>;
  // State this effect overwrites with snapshot data that handlers also edit
  clobbered: Set<string>;
  derived: Set<string>;
  isEdited(name: string): boolean;
}

// `flag` or `not flag`, and whether the condition holds when flag is truthy
function flagCondition(condition: SyntaxNode): { name: string; truthy: boolean } | null {
  let node = unwrapExpression(condition);
  let truthy = true;

  if (node.type === "unary_expression" && hasOperator(node, new Set(["not"]))) {
    const operand = node.childForFieldName("operand");
    if (!operand) return null;

    node = unwrapExpression(operand);
    truthy = false;
  }

  return node.type === "identifier" ? { name: node.text, truthy } : null;
}

function contains(node: SyntaxNode | null, inner: SyntaxNode): boolean {
  return Boolean(node && node.startIndex <= inner.startIndex && inner.endIndex <= node.endIndex);
}

// A condition on state the effect sets, or on a ref, usually means it only seeds once. Comparing
// edited state with snapshot data is not a guard, since it differs as soon as the user edits it
function isGuardedSeed(context: RuleContext, write: SyntaxNode, facts: WriteFacts): boolean {
  for (const node of context.walk(facts.effect.body ?? facts.effect.node)) {
    if (node.startIndex >= write.startIndex) break;
    if (node.type !== "if_statement" && node.type !== "elseif_statement") continue;
    if (!runsWithEffect(context, node, facts.effect)) continue;
    const encloses = node.endIndex >= write.endIndex;
    if (!encloses && !returnsFrom(context, node)) continue;

    const condition = node.childForFieldName("condition");
    if (!condition) continue;

    // Skipping the write while an edit flag is set protects the edits
    const flag = flagCondition(condition);
    const writeRunsWhenTrue = encloses && contains(node.childForFieldName("consequence"), write);

    if (flag && writeRunsWhenTrue !== flag.truthy && !facts.clobbered.has(flag.name) && facts.isEdited(flag.name))
      return true;

    for (const part of context.walk(condition)) {
      if (part.type === "dot_index_expression" && part.childForFieldName("field")?.text === "current") return true;
      if (part.type !== "identifier" || !facts.written.has(part.text)) continue;
      if (part.parent?.type === "dot_index_expression" && sameNode(part.parent.childForFieldName("field"), part)) continue;

      const other = comparedOperand(part);
      if (other && facts.clobbered.has(part.text) && containsAny(other, facts.derived, context)) continue;

      return true;
    }
  }

  return false;
}

function isMergingUpdater(context: RuleContext, argument: SyntaxNode): boolean {
  const updater = functionInfoForNode(context, argument);
  const previous = updater?.parameters[0];

  return Boolean(previous && containsIdentifier(updater.body, previous, context));
}

export const noSnapshotOverwritingEdits: RuleDefinition = {
  id: "react-luau/no-snapshot-overwriting-edits",
  category: "Effects",
  severity: "warning",
  description: "Effects should not copy a store snapshot into state that handlers edit, since every store change discards those edits",

  guidance: {
    explanation:
      "A hook that copies its store on every change returns a new table even when the fields an effect reads are unchanged. An effect that depends on it re-runs on unrelated updates and overwrites state the user is editing",
    help: "Depend on the fields the effect reads, or select them with a hook that only changes when they do",
    caveat: "A field dependency only changes when the store replaces that field's table. If the store mutates nested tables in place, select the field with a hook that copies it",
  },

  run(context) {
    const diagnostics: DiagnosticInput[] = [];

    for (const call of context.findCalls()) {
      if (!isEffectPath(context.resolveCallPath(context.getCallPath(call) ?? ""))) continue;

      const [callback, deps] = context.callArguments(call);
      if (deps?.type !== "table_constructor") continue;

      const dependencies = dependencyExpressions(deps);
      const snapshots = dependencies
        .map((dependency) => ({ dependency, hook: snapshotHookName(context, dependency) }))
        .filter((entry): entry is { dependency: SyntaxNode; hook: string } => entry.hook !== null);

      if (snapshots.length === 0) continue;

      const owner = context.nearestFunction(call);
      const effect = functionInfoForNode(context, callback ?? null);

      if (!owner || !(owner.isComponent || owner.isHook) || !effect) continue;

      const bindings = new Map<string, StateBinding>(
        stateBindingsFor(context, owner).map((binding) => [binding.setterName, binding]),
      );

      const setterCalls = [...context.walk(effect.body ?? effect.node)].filter(
        (node) =>
          node.type === "function_call" &&
          bindings.has(context.getCallPath(node) ?? "") &&
          runsWithEffect(context, node, effect),
      );

      if (setterCalls.length === 0) continue;

      const written = new Set(setterCalls.map((node) => bindings.get(context.getCallPath(node)!)!.valueName));
      const edits = new Map<string, string[]>();
      const existingDeps = new Set(dependencies.map((dependency) => normalizeExpressionText(dependency.text)));

      for (const { dependency, hook } of snapshots) {
        const snapshot = dependency.text;
        const derived = snapshotDerivedNames(context, effect, snapshot);

        const writes = setterCalls.filter((write) => {
          const argument = context.callArguments(write)[0];

          return Boolean(argument) &&
            containsAny(argument, derived, context) &&
            !(argument.type === "function_definition" && isMergingUpdater(context, argument));
        });

        const editsFor = (binding: StateBinding): string[] => {
          if (!edits.has(binding.setterName)) edits.set(binding.setterName, handlerEdits(context, owner, binding.setterName));
          return edits.get(binding.setterName)!;
        };

        const editedWrites = writes.filter((write) => editsFor(bindings.get(context.getCallPath(write)!)!).length > 0);

        const facts: WriteFacts = {
          effect,
          written,
          clobbered: new Set(editedWrites.map((write) => bindings.get(context.getCallPath(write)!)!.valueName)),
          derived,
          isEdited: (name) => {
            const binding = [...bindings.values()].find((candidate) => candidate.valueName === name);
            return Boolean(binding && editsFor(binding).length > 0);
          },
        };

        const overwritten: SyntaxNode[] = [];
        const states: string[] = [];
        const editors = new Set<string>();

        for (const write of editedWrites) {
          if (isGuardedSeed(context, write, facts)) continue;

          const binding = bindings.get(context.getCallPath(write)!)!;
          const writeEdits = editsFor(binding);

          overwritten.push(callNameNode(write));
          if (!states.includes(binding.valueName)) states.push(binding.valueName);
          for (const edit of writeEdits) editors.add(edit);
        }

        if (overwritten.length === 0) continue;

        const fields = readFields(context, effect, snapshot);
        const stateText = listText(states);
        const editorText = listText([...editors].slice(0, 3)) + (editors.size > 3 ? " and others" : "");
        const narrowedDeps = fields
          ? `{ ${dependencies
              .flatMap((entry) =>
                sameNode(entry, dependency) ? fields.filter((field) => !existingDeps.has(field)) : [entry.sourceText],
              )
              .join(", ")} }`
          : null;

        diagnostics.push({
          node: dependency,
          highlights: overwritten,
          message: `${snapshot} is a new table after every ${hook}() store change, so this effect keeps overwriting ${stateText} and discards edits from ${editorText}`,
          summary: `Unrelated store changes reset ${stateText}`,
          explanation: `${hook}() copies its whole store each time any part of it changes. This effect depends on ${snapshot}, so it re-runs on those unrelated changes and replaces ${stateText}, which ${editorText} also update`,

          help: fields
            ? `Depend on ${listText(fields)} instead of ${snapshot}, or select ${fields.length === 1 ? "it" : "them"} with a hook that only changes when ${fields.length === 1 ? "it does" : "they do"}`
            : `Build ${stateText} from the fields ${states.length === 1 ? "it edits" : "they edit"} and depend on those, or copy ${snapshot} only when editing starts`,

          ...(narrowedDeps
            ? {
                fixPreview: {
                  kind: "exact" as const,
                  before: deps.sourceText,
                  after: narrowedDeps,
                  note: "The effect then only re-runs when the fields it reads change",
                },
              }
            : {}),
        });
      }
    }

    return diagnostics;
  },
};
