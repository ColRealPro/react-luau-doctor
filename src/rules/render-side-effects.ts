import type { SyntaxNode } from "../syntax";
import type { RuleContext, RuleDefinition, SourceEffectModuleSummary } from "../types";
import { normalizeRequireTarget, resolveModuleReference } from "../module-resolution";
import { knownYieldReason } from "../roblox-semantics";
import { callNameNode } from "./helpers";

interface SourceBinding<T> {
  declaration: SyntaxNode;
  value: T | null;
}

type SourceBindings<T> = Map<string, SourceBinding<T>[]>;

interface EffectInstance {
  summary: SourceEffectModuleSummary;
  persistent: boolean;
}

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
  if (node.type !== "assignment_statement" || node.parent?.type === "variable_declaration") return { names: [], expressions: [] };
  const variables = node.namedChildren.find((child) => child.type === "variable_list");
  const expressions = node.namedChildren.find((child) => child.type === "expression_list");
  return {
    names: variables?.namedChildren.filter((child) => child.type === "identifier").map((child) => child.text) ?? [],
    expressions: expressions?.namedChildren ?? [],
  };
}

function bindingParts(node: SyntaxNode): { names: string[]; expressions: SyntaxNode[] } {
  return node.type === "variable_declaration" ? declarationParts(node) : assignmentParts(node);
}

function addSourceBinding<T>(bindings: SourceBindings<T>, name: string, declaration: SyntaxNode, value: T | null): void {
  const existing = bindings.get(name) ?? [];
  existing.push({ declaration, value });
  bindings.set(name, existing);
}

function nearestScopeContainer(node: SyntaxNode, context: RuleContext): SyntaxNode {
  const owner = context.nearestFunction(node);
  let current = node.parent;
  while (current) {
    if (current.type === "block") return current;
    if (owner && current.id === owner.node.id) return owner.body ?? owner.node;
    current = current.parent;
  }
  return context.root;
}

function declarationVisibleAt(declaration: SyntaxNode, node: SyntaxNode, context: RuleContext): boolean {
  if (declaration.startIndex >= node.startIndex) return false;
  const container = nearestScopeContainer(declaration, context);
  return node.startIndex >= container.startIndex && node.endIndex <= container.endIndex;
}

function functionParameterNames(node: SyntaxNode): Set<string> {
  const result = new Set<string>();
  const parameters = node.childForFieldName("parameters")
    ?? node.namedChildren.find((child) => child.type === "parameters");
  for (const parameter of parameters?.namedChildren ?? []) {
    if (parameter.type === "identifier") result.add(parameter.text);
    for (const child of parameter.namedChildren) {
      if (child.type === "identifier") result.add(child.text);
    }
  }
  return result;
}

function loopBindsName(node: SyntaxNode, name: string): boolean {
  if (node.type !== "for_statement") return false;
  const header = node.text.split(/\bdo\b/s, 1)[0] ?? "";
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*for\\s+(?:${escaped}\\s*=|[^\\n]*\\b${escaped}\\b[^\\n]*\\bin\\b)`, "s").test(header);
}

function bindingShadowedAfterDeclaration(declaration: SyntaxNode, node: SyntaxNode, name: string): boolean {
  let current = node.parent;
  while (current) {
    // Once we reach a scope that already contains the source binding, binders
    // outside that scope cannot shadow the binding at this use site.
    if (declaration.startIndex >= current.startIndex && declaration.endIndex <= current.endIndex) return false;
    if (
      (current.type === "function_definition" || current.type === "function_declaration")
      && functionParameterNames(current).has(name)
    ) return true;
    if (loopBindsName(current, name)) return true;
    current = current.parent;
  }
  return false;
}

function resolveSourceBinding<T>(
  bindings: SourceBindings<T>,
  name: string,
  node: SyntaxNode,
  context: RuleContext,
): T | null {
  const candidates = bindings.get(name);
  if (!candidates) return null;

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (!declarationVisibleAt(candidate.declaration, node, context)) continue;
    if (bindingShadowedAfterDeclaration(candidate.declaration, node, name)) return null;
    return candidate.value;
  }
  return null;
}

function sourceEffectImports(context: RuleContext): SourceBindings<SourceEffectModuleSummary> {
  const result: SourceBindings<SourceEffectModuleSummary> = new Map();
  for (const node of context.walk(context.root)) {
    if (node.type !== "variable_declaration" && node.type !== "assignment_statement") continue;
    if (node.type === "assignment_statement" && node.parent?.type === "variable_declaration") continue;
    const { names, expressions } = bindingParts(node);
    for (let index = 0; index < names.length; index += 1) {
      const expression = expressions[index] ?? expressions[0];
      const requireMatch = expression?.type === "function_call"
        ? expression.text.match(/^\s*require\s*\((.*?)\)\s*$/s)
        : null;
      const summary = requireMatch
        ? resolveModuleReference(normalizeRequireTarget(requireMatch[1]), context.project.sourceEffects)
        : null;
      addSourceBinding(result, names[index], node, summary);
    }
  }
  return result;
}

function factorySummaryFromCall(
  call: SyntaxNode,
  context: RuleContext,
  imports: SourceBindings<SourceEffectModuleSummary>,
): SourceEffectModuleSummary | null {
  const path = context.getCallPath(call)?.replace(/\s+/g, "") ?? "";
  const match = path.match(/^([A-Za-z_][A-Za-z0-9_]*)[.:]([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!match) return null;
  const summary = resolveSourceBinding(imports, match[1], call, context);
  if (!summary?.instanceFactories.has(match[2])) return null;
  return summary;
}

function returnedFactorySummary(
  callback: SyntaxNode,
  context: RuleContext,
  imports: SourceBindings<SourceEffectModuleSummary>,
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
  imports: SourceBindings<SourceEffectModuleSummary>,
): SourceBindings<EffectInstance> {
  const result: SourceBindings<EffectInstance> = new Map();

  for (const node of context.walk(context.root)) {
    if (node.type !== "variable_declaration" && node.type !== "assignment_statement") continue;
    if (node.type === "assignment_statement" && node.parent?.type === "variable_declaration") continue;
    const { names, expressions } = bindingParts(node);
    for (let index = 0; index < names.length; index += 1) {
      const expression = expressions[index] ?? expressions[0];
      let instance: EffectInstance | null = null;
      if (expression?.type === "function_call") {
        const directFactory = factorySummaryFromCall(expression, context, imports);
        if (directFactory) {
          // An instance created at module scope persists across renders. A fresh
          // factory result created inside render is local to that render and
          // receiver-only mutation is not externally observable by itself.
          instance = {
            summary: directFactory,
            persistent: context.nearestFunction(node) === null,
          };
        } else if (context.resolveCallPath(context.getCallPath(expression) ?? "") === "React.useMemo") {
          const callback = context.callArguments(expression)[0];
          if (callback?.type === "function_definition") {
            const memoizedFactory = returnedFactorySummary(callback, context, imports);
            if (memoizedFactory) instance = { summary: memoizedFactory, persistent: true };
          }
        }
      } else if (expression?.type === "identifier") {
        instance = resolveSourceBinding(result, expression.text, expression, context);
      }
      addSourceBinding(result, names[index], node, instance);
    }
  }

  return result;
}

function sourceInferredEffectCall(
  call: SyntaxNode,
  context: RuleContext,
  imports: SourceBindings<SourceEffectModuleSummary>,
  instances: SourceBindings<EffectInstance>,
): boolean {
  const path = context.getCallPath(call)?.replace(/\s+/g, "") ?? "";
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(path)) {
    const direct = resolveSourceBinding(imports, path, call, context);
    if (direct?.effectfulExport) return true;
  }

  const member = path.match(/^([A-Za-z_][A-Za-z0-9_]*)[.:]([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!member) return false;

  const instance = resolveSourceBinding(instances, member[1], call, context);
  if (instance) {
    if (instance.summary.effectfulMembers.has(member[2])) return true;
    return instance.persistent && instance.summary.mutatingMembers.has(member[2]);
  }

  const imported = resolveSourceBinding(imports, member[1], call, context);
  if (!imported) return false;
  // The imported module table is itself persistent project state, so a method
  // that mutates its receiver is observable even if it has no other effects.
  return imported.effectfulMembers.has(member[2]) || imported.mutatingMembers.has(member[2]);
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
  /:unmount$/,
];

function hasNestedKnownRenderSideEffect(call: SyntaxNode, context: RuleContext): boolean {
  for (const node of context.walk(call)) {
    if (node.startIndex === call.startIndex && node.endIndex === call.endIndex) continue;
    if (node.type !== "function_call") continue;
    const path = context.resolveCallPath(context.getCallPath(node) ?? "");
    if (path === "task.spawn" || path === "task.defer" || path === "task.delay") return true;
    if (knownYieldReason(path, node, context) || RENDER_EFFECT_PATTERNS.some(pattern => pattern.test(path))) return true;
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
      const reason = knownYieldReason(path, call, context);
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
