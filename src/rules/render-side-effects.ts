import type { Node as SyntaxNode } from "web-tree-sitter";
import type { RuleContext, RuleDefinition, SourceEffectModuleSummary } from "../types";
import { normalizeRequireTarget, resolveModuleReference } from "../module-resolution";
import { knownYieldReason } from "../roblox-semantics";
import { callNameNode } from "./helpers";

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

function sourceEffectImports(context: RuleContext): Map<string, SourceEffectModuleSummary> {
  const result = new Map<string, SourceEffectModuleSummary>();
  for (const node of context.walk(context.root)) {
    if (node.type !== "variable_declaration") continue;
    const match = node.text.match(/^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\s*\((.*?)\)\s*$/s);
    if (!match) continue;
    const summary = resolveModuleReference(normalizeRequireTarget(match[2]), context.project.sourceEffects);
    if (summary) result.set(match[1], summary);
  }
  return result;
}

function factorySummaryFromCall(
  call: SyntaxNode,
  context: RuleContext,
  imports: Map<string, SourceEffectModuleSummary>,
): SourceEffectModuleSummary | null {
  const path = context.getCallPath(call)?.replace(/\s+/g, "") ?? "";
  const match = path.match(/^([A-Za-z_][A-Za-z0-9_]*)[.:]([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!match) return null;
  const summary = imports.get(match[1]);
  if (!summary?.instanceFactories.has(match[2])) return null;
  return summary;
}

function returnedFactorySummary(
  callback: SyntaxNode,
  context: RuleContext,
  imports: Map<string, SourceEffectModuleSummary>,
): SourceEffectModuleSummary | null {
  for (const node of context.walk(callback)) {
    if (node !== callback && (node.type === "function_definition" || node.type === "function_declaration")) continue;
    if (node.type !== "return_statement") continue;
    const expressions = node.namedChildren.find((child) => child.type === "expression_list");
    const value = expressions?.namedChildren[0];
    if (value?.type === "function_call") return factorySummaryFromCall(value, context, imports);
  }
  return null;
}

function sourceEffectInstances(
  context: RuleContext,
  imports: Map<string, SourceEffectModuleSummary>,
): Map<string, SourceEffectModuleSummary> {
  const result = new Map<string, SourceEffectModuleSummary>();

  for (const node of context.walk(context.root)) {
    if (node.type !== "variable_declaration") continue;
    const { names, expressions } = declarationParts(node);
    for (let index = 0; index < names.length; index += 1) {
      const expression = expressions[index] ?? expressions[0];
      if (!expression) continue;
      let summary: SourceEffectModuleSummary | null = null;
      if (expression.type === "function_call") {
        summary = factorySummaryFromCall(expression, context, imports);
        if (!summary && context.resolveCallPath(context.getCallPath(expression) ?? "") === "React.useMemo") {
          const callback = context.callArguments(expression)[0];
          if (callback?.type === "function_definition") summary = returnedFactorySummary(callback, context, imports);
        }
      } else if (expression.type === "identifier") {
        summary = result.get(expression.text) ?? null;
      }
      if (summary) result.set(names[index], summary);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of context.walk(context.root)) {
      if (node.type !== "variable_declaration") continue;
      const { names, expressions } = declarationParts(node);
      for (let index = 0; index < names.length; index += 1) {
        if (result.has(names[index])) continue;
        const expression = expressions[index] ?? expressions[0];
        if (expression?.type !== "identifier") continue;
        const summary = result.get(expression.text);
        if (!summary) continue;
        result.set(names[index], summary);
        changed = true;
      }
    }
  }
  return result;
}

function sourceInferredEffectCall(
  call: SyntaxNode,
  context: RuleContext,
  imports: Map<string, SourceEffectModuleSummary>,
  instances: Map<string, SourceEffectModuleSummary>,
): boolean {
  const path = context.getCallPath(call)?.replace(/\s+/g, "") ?? "";
  const direct = imports.get(path);
  if (direct?.effectfulExport) return true;

  const member = path.match(/^([A-Za-z_][A-Za-z0-9_]*)[.:]([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!member) return false;
  const summary = imports.get(member[1]) ?? instances.get(member[1]);
  return summary?.effectfulMembers.has(member[2]) ?? false;
}


const RENDER_EFFECT_PATTERNS = [
  /^Instance\.new$/,
  /tween[^:]*:(?:Create|Play)$/i,
  /:Connect$/,
  /:BindAction$/,
  /:BindActionAtPriority$/,
  /:BindActivate$/,
  /BindToRenderStep$/,
  /BindToSimulation$/,
  /:Destroy$/,
  /:render$/,
  /:unmount$/,
];

function hasNestedKnownRenderSideEffect(call: SyntaxNode, context: RuleContext): boolean {
  for (const node of context.walk(call)) {
    if (node.startIndex === call.startIndex && node.endIndex === call.endIndex) continue;
    if (node.type !== "function_call") continue;
    const path = context.resolveCallPath(context.getCallPath(node) ?? "");
    if (path === "task.spawn" || path === "task.defer" || path === "task.delay") return true;
    if (knownYieldReason(path) || RENDER_EFFECT_PATTERNS.some(pattern => pattern.test(path))) return true;
  }
  return false;
}

export const noYieldInRender: RuleDefinition = {
  id: "react-luau/no-yield-in-render",
  category: "Correctness",
  severity: "error",
  description: "React render functions must not yield.",
  run(context) {
    const diagnostics = [];
    for (const call of context.findCalls()) {
      const component = context.containingComponent(call);
      if (!component || !context.isDirectlyExecutedInFunction(call, component)) continue;
      const path = context.resolveCallPath(context.getCallPath(call) ?? "");
      const reason = knownYieldReason(path);
      if (!reason) continue;
      diagnostics.push({
        node: callNameNode(call),
        message: `${path} can yield during component render.`,
        help: `Move yielding work outside render, usually into an effect or an external data-loading boundary. The bundled Roblox yield metadata recognizes ${reason} as a yielding API.`,
      });
    }
    return diagnostics;
  },
};

export const noTaskSpawnInRender: RuleDefinition = {
  id: "react-luau/no-task-spawn-in-render",
  category: "Correctness",
  severity: "error",
  description: "Do not schedule asynchronous work during render.",
  run(context) {
    const diagnostics = [];
    for (const call of context.findCalls()) {
      const component = context.containingComponent(call);
      if (!component || !context.isDirectlyExecutedInFunction(call, component)) continue;
      const path = context.getCallPath(call);
      if (path !== "task.spawn" && path !== "task.defer" && path !== "task.delay") continue;
      diagnostics.push({
        node: callNameNode(call),
        message: `${path} schedules work during component render.`,
        help: "Move the scheduled work into an effect or the event that actually owns the side effect.",
      });
    }
    return diagnostics;
  },
};

export const noSideEffectsInRender: RuleDefinition = {
  id: "react-luau/no-side-effects-in-render",
  category: "Correctness",
  severity: "error",
  description: "Do not create Instances, start tweens, subscribe, or perform other externally observable side effects during component render.",
  run(context) {
    const diagnostics = [];
    const effectImports = sourceEffectImports(context);
    const effectInstances = sourceEffectInstances(context, effectImports);


    for (const call of context.findCalls()) {
      const component = context.containingComponent(call);
      if (!component || !context.isDirectlyExecutedInFunction(call, component)) continue;
      const path = context.resolveCallPath(context.getCallPath(call) ?? "");
      const knownPattern = RENDER_EFFECT_PATTERNS.some((pattern) => pattern.test(path));
      let inferredFromSource = sourceInferredEffectCall(call, context, effectImports, effectInstances);
      // Report the inner operation rather than duplicating it on an inferred wrapper.
      if (inferredFromSource && hasNestedKnownRenderSideEffect(call, context)) inferredFromSource = false;
      if (!knownPattern && !inferredFromSource) continue;
      diagnostics.push({
        node: callNameNode(call),
        message: inferredFromSource && !knownPattern
          ? `${path} runs during render, and code it calls eventually changes state outside the current render.`
          : `${path} performs a side effect directly during component render.`,
        help: inferredFromSource && !knownPattern
          ? "Move this call into an effect, event handler, or another committed lifecycle boundary so an abandoned render cannot still change application state."
          : "Move imperative work into an effect or event handler with explicit ownership and cleanup. Use React.createElement for React-owned Instances; destroy imperative Instances, cancel tweens, and disconnect subscriptions when their owner is cleaned up.",
        fixPreview: inferredFromSource && !knownPattern
          ? {
              kind: "pattern" as const,
              before: call.text,
              after: `React.useEffect(function()
	${call.text}
end, { -- dependencies })`,
              note: "The exact owner depends on intent: use an effect for committed lifecycle work, or move the call into the event that actually triggers the mutation.",
            }
          : undefined,
      });
    }

    return diagnostics;
  },
};
