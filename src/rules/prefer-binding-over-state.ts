import type { Node as SyntaxNode } from "web-tree-sitter";
import { normalizeRequireTarget, resolveModuleReference } from "../module-resolution";
import type { BindingCandidateHookSummary, ExternalCallbackFunctionSummary, FixPreview, FunctionInfo, RuleContext, RuleDefinition, StateBinding } from "../types";
import { sameNode } from "../ast/walk";
import { callNameNode, declarationNames, fieldName, fieldValue, isNameShadowedBetween } from "./helpers";

const HIGH_FREQUENCY = /(?:RenderStepped|Heartbeat|Stepped|PreRender|PreSimulation|PostSimulation)\s*:\s*Connect|BindToRenderStep|BindToSimulation/;
const EXTERNAL_CALLBACK = /(?:^|[.:])(?:Connect|Once|Subscribe|Observe|Listen|Watch)$/i;
const NON_BINDABLE_HOST_FIELDS = new Set(["ref", "key", "children"]);

function replaceWithinNode(container: SyntaxNode, target: SyntaxNode, replacement: string): string | null {
  const start = target.startIndex - container.startIndex;
  const end = target.endIndex - container.startIndex;
  if (start < 0 || end < start || end > container.text.length) return null;
  return `${container.text.slice(0, start)}${replacement}${container.text.slice(end)}`;
}

function bindingModeFixPreview(
  summary: BindingCandidateHookSummary,
  call: SyntaxNode,
  context: RuleContext,
): FixPreview | undefined {
  const parameterIndex = summary.bindingModeParameterIndex;
  if (parameterIndex === undefined || summary.bindingWhenTruthy === undefined) return undefined;
  const desired = summary.bindingWhenTruthy ? "true" : "false";
  const args = context.callArguments(call);

  if (parameterIndex < args.length) {
    const after = replaceWithinNode(call, args[parameterIndex], desired);
    if (!after || after === call.text) return undefined;
    return {
      kind: "exact",
      before: call.text,
      after,
      note: summary.bindingModeParameterName
        ? `Switch the ${summary.bindingModeParameterName} parameter to the hook's Binding mode.`
        : "Switch this call to the hook's Binding mode.",
    };
  }

  if (parameterIndex >= args.length) {
    const close = call.text.lastIndexOf(")");
    if (close < 0) return undefined;
    // Omitted Lua/Luau arguments are nil. Fill any skipped optional parameters
    // explicitly so the inferred Binding-mode argument lands in the right slot.
    const skipped = Array.from({ length: parameterIndex - args.length }, () => "nil");
    const appended = [...skipped, desired].join(", ");
    const insertion = `${args.length > 0 ? ", " : ""}${appended}`;
    return {
      kind: "exact",
      before: call.text,
      after: `${call.text.slice(0, close)}${insertion}${call.text.slice(close)}`,
      note: summary.bindingModeParameterName
        ? `Enable the hook's Binding mode through the ${summary.bindingModeParameterName} parameter without changing omitted optional arguments.`
        : "Enable the hook's Binding mode without changing omitted optional arguments.",
    };
  }

  return undefined;
}

function callMemberFixPreview(call: SyntaxNode, replacement: string): FixPreview | undefined {
  const name = callNameNode(call);
  const path = name.text;
  const separator = Math.max(path.lastIndexOf("."), path.lastIndexOf(":"));
  const member = separator >= 0 ? path.slice(separator + 1) : path;
  const replacementName = separator >= 0 ? `${path.slice(0, separator + 1)}${replacement}` : replacement;
  const after = replaceWithinNode(call, name, replacementName);
  if (!after || member === replacement) return undefined;
  return { kind: "exact", before: call.text, after };
}

function useBindingFixPreview(call: SyntaxNode): FixPreview | undefined {
  const name = callNameNode(call);
  const current = name.text;
  const afterName = current.replace(/(?:^|\.)useState$/, (match) => match.replace("useState", "useBinding"));
  if (afterName === current) return undefined;
  const after = replaceWithinNode(call, name, afterName);
  return after ? { kind: "exact", before: call.text, after } : undefined;
}

function importedBindingCandidateHooks(context: RuleContext): Map<string, BindingCandidateHookSummary> {
  const result = new Map<string, BindingCandidateHookSummary>();

  for (const node of context.walk(context.root)) {
    if (node.type !== "variable_declaration") continue;
    const match = node.text.match(/^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\s*\((.*?)\)\s*$/s);
    if (!match) continue;
    const summary = resolveModuleReference(
      normalizeRequireTarget(match[2]),
      context.project.bindingCandidateHooks,
    );
    if (summary) result.set(match[1], summary);
  }

  return result;
}

function importedExternalCallbackFunctions(context: RuleContext): Map<string, ExternalCallbackFunctionSummary> {
  const result = new Map<string, ExternalCallbackFunctionSummary>();

  for (const node of context.walk(context.root)) {
    if (node.type !== "variable_declaration") continue;
    const match = node.text.match(/^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\s*\((.*?)\)\s*$/s);
    if (!match) continue;
    const summary = resolveModuleReference(
      normalizeRequireTarget(match[2]),
      context.project.externalCallbackModules,
    );
    if (summary) result.set(match[1], summary);
  }

  return result;
}

function importedBindingCompatibleComponentProps(context: RuleContext): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();

  for (const node of context.walk(context.root)) {
    if (node.type !== "variable_declaration") continue;
    const match = node.text.match(/^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\s*\((.*?)\)\s*$/s);
    if (!match) continue;
    const summary = resolveModuleReference(
      normalizeRequireTarget(match[2]),
      context.project.bindingCompatibleComponentProps,
    );
    if (summary) result.set(match[1], summary);
  }

  return result;
}

function declarationForCall(call: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = call.parent;
  while (current) {
    if (current.type === "variable_declaration") return current;
    if (current.type === "function_definition" || current.type === "function_declaration") return null;
    current = current.parent;
  }
  return null;
}

const TRANSPARENT_PARENTS = new Set([
  "binary_expression",
  "unary_expression",
  "parenthesized_expression",
  "cast_expression",
  "type_cast_expression",
  "interpolated_string",
  "string_interpolation",
  "expression_list",
  "assignment_statement",
  "arguments",
  "function_call",
  "dot_index_expression",
  "method_index_expression",
  "table_constructor",
  "field",
]);

function isInside(node: SyntaxNode, ancestor: SyntaxNode): boolean {
  let current: SyntaxNode | null = node;
  while (current) {
    if (sameNode(current, ancestor)) return true;
    current = current.parent;
  }
  return false;
}

function isIdentifierPropertyName(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (parent?.type === "dot_index_expression") return sameNode(parent.childForFieldName("field"), node);
  if (parent?.type === "method_index_expression") return sameNode(parent.childForFieldName("method"), node) || sameNode(parent.namedChildren.at(-1), node);
  return false;
}

function isReadNode(node: SyntaxNode, valueName: string, owner: FunctionInfo, declaration: SyntaxNode): boolean {
  if (node.type !== "identifier" || node.text !== valueName) return false;
  if (isInside(node, declaration)) return false;
  if (isIdentifierPropertyName(node)) return false;
  if (isNameShadowedBetween(node, owner, valueName)) return false;
  const parent = node.parent;
  if (parent?.type === "variable_list" || parent?.type === "typed_identifier") return false;
  if (parent?.type === "field" && !sameNode(fieldValue(parent), node) && /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(parent.text.trim())) {
    return false;
  }
  return true;
}

function hasAnyRead(valueName: string, owner: FunctionInfo, declaration: SyntaxNode, context: RuleContext): boolean {
  if (!owner.body) return false;
  return [...context.walk(owner.body)].some((node) => isReadNode(node, valueName, owner, declaration));
}

function isCreateElementCall(call: SyntaxNode, context: RuleContext): boolean {
  return call.type === "function_call"
    && context.resolveCallPath(context.getCallPath(call) ?? "") === "React.createElement";
}

function isHostCreateElementCall(call: SyntaxNode, context: RuleContext): boolean {
  if (!isCreateElementCall(call, context)) return false;
  const args = context.callArguments(call);
  const host = args[0]?.text.trim() ?? "";
  return /^(?:"[^"]+"|'[^']+')$/.test(host);
}

function isTransparentUsage(
  node: SyntaxNode,
  context: RuleContext,
  compatibleComponentProps: Map<string, Set<string>>,
): boolean {
  let current: SyntaxNode | null = node;
  while (current) {
    const parent: SyntaxNode | null = current.parent;
    if (!parent) return false;

    if (parent.type === "field") {
      const value = fieldValue(parent);
      if (!value || !sameNode(value, current)) return false;
      const property = fieldName(parent);
      if (!property || NON_BINDABLE_HOST_FIELDS.has(property)) return false;
      const table = parent.parent;
      if (table?.type !== "table_constructor") return false;
      const args = table.parent;
      if (args?.type !== "arguments") return false;
      const call = args.parent;
      if (!call || !isCreateElementCall(call, context)) return false;
      if (!sameNode(context.callArguments(call)[1], table)) return false;
      if (isHostCreateElementCall(call, context)) return true;

      const component = context.callArguments(call)[0]?.text.trim() ?? "";
      return compatibleComponentProps.get(component)?.has(property) ?? false;
    }

    if (parent.type === "if_statement" || parent.type === "elseif_clause" || parent.type === "while_statement"
      || parent.type === "repeat_statement" || parent.type === "return_statement") {
      return false;
    }

    if (parent.type === "function_definition" || parent.type === "function_declaration") return false;
    if (!TRANSPARENT_PARENTS.has(parent.type)) return false;
    current = parent;
  }
  return false;
}

function derivedLocalDeclarationForRead(node: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = node;
  while (current) {
    const parent: SyntaxNode | null = current.parent;
    if (!parent) return null;
    if (parent.type === "variable_declaration") return parent;
    if (parent.type === "function_definition" || parent.type === "function_declaration") return null;
    if (!TRANSPARENT_PARENTS.has(parent.type)) return null;
    current = parent;
  }
  return null;
}

function stateReadsAreBindingCompatible(
  valueName: string,
  owner: FunctionInfo,
  declaration: SyntaxNode,
  context: RuleContext,
  compatibleComponentProps: Map<string, Set<string>>,
  visited = new Set<string>(),
): boolean {
  if (!owner.body) return false;
  const visitKey = `${declaration.startIndex}:${valueName}`;
  if (visited.has(visitKey)) return false;
  visited.add(visitKey);

  let reads = 0;
  for (const node of context.walk(owner.body)) {
    if (!isReadNode(node, valueName, owner, declaration)) continue;
    reads += 1;
    if (isTransparentUsage(node, context, compatibleComponentProps)) continue;

    const derivedDeclaration = derivedLocalDeclarationForRead(node);
    const derivedNames = derivedDeclaration ? declarationNames(derivedDeclaration) : [];
    if (derivedDeclaration && derivedNames.length === 1) {
      if (stateReadsAreBindingCompatible(
        derivedNames[0],
        owner,
        derivedDeclaration,
        context,
        compatibleComponentProps,
        new Set(visited),
      )) continue;
    }
    return false;
  }

  return reads > 0;
}

function callbackSource(path: string): { highFrequency: boolean; external: boolean } {
  const normalized = path.replace(/\s+/g, "");
  const highFrequency = HIGH_FREQUENCY.test(normalized);
  const final = normalized.split(/[.:]/).at(-1) ?? normalized;
  const external = highFrequency || EXTERNAL_CALLBACK.test(normalized) || EXTERNAL_CALLBACK.test(final);
  return { highFrequency, external };
}

function importedCallbackSource(
  call: SyntaxNode,
  callbackArgument: SyntaxNode,
  importedCallbacks: Map<string, ExternalCallbackFunctionSummary>,
  context: RuleContext,
): { highFrequency: boolean; external: boolean } | null {
  const path = context.getCallPath(call) ?? "";
  const summary = importedCallbacks.get(path);
  if (!summary) return null;
  const args = context.callArguments(call);
  const callbackIndex = args.findIndex((arg) => sameNode(arg, callbackArgument));
  if (callbackIndex < 0 || !summary.callbackParameterIndexes.includes(callbackIndex)) return null;
  return {
    highFrequency: summary.highFrequency || args.some((arg) => HIGH_FREQUENCY.test(arg.text)),
    external: true,
  };
}

function directCallbackSource(
  node: SyntaxNode,
  importedCallbacks: Map<string, ExternalCallbackFunctionSummary>,
  context: RuleContext,
): { highFrequency: boolean; external: boolean } | null {
  const parent = node.parent;
  if (parent?.type !== "arguments" || parent.parent?.type !== "function_call") return null;
  const call = parent.parent;
  const imported = importedCallbackSource(call, node, importedCallbacks, context);
  if (imported) return imported;
  const raw = call.childForFieldName("name")?.text ?? "";
  const source = callbackSource(raw);
  return source.external ? source : null;
}

function namedFunctionCallbackSource(
  fn: FunctionInfo,
  owner: FunctionInfo,
  importedCallbacks: Map<string, ExternalCallbackFunctionSummary>,
  context: RuleContext,
): { highFrequency: boolean; external: boolean } | null {
  if (!fn.name || !owner.body) return null;
  let foundExternal = false;
  let foundHighFrequency = false;

  for (const call of context.walk(owner.body)) {
    if (call.type !== "function_call") continue;
    const args = context.callArguments(call);
    const callbackArg = args.find((arg) => arg.type === "identifier" && arg.text === fn.name);
    if (!callbackArg) continue;
    const imported = importedCallbackSource(call, callbackArg, importedCallbacks, context);
    const source = imported ?? callbackSource(context.getCallPath(call) ?? "");
    if (!source.external) continue;
    foundExternal = true;
    foundHighFrequency ||= source.highFrequency;
  }

  return foundExternal ? { highFrequency: foundHighFrequency, external: true } : null;
}

function setterCallbackSource(
  call: SyntaxNode,
  binding: StateBinding,
  importedCallbacks: Map<string, ExternalCallbackFunctionSummary>,
  context: RuleContext,
): { highFrequency: boolean; external: boolean } | null {
  const owner = binding.owner;
  if (!owner) return null;
  const nearest = context.nearestFunction(call);
  if (!nearest || nearest === owner) return null;

  const direct = directCallbackSource(nearest.node, importedCallbacks, context);
  if (direct) return direct;

  return namedFunctionCallbackSource(nearest, owner, importedCallbacks, context);
}

function bindingHasExternalOrHighFrequencyUpdates(
  binding: StateBinding,
  importedCallbacks: Map<string, ExternalCallbackFunctionSummary>,
  context: RuleContext,
): { highFrequency: boolean; external: boolean } | null {
  const owner = binding.owner;
  if (!owner?.body) return null;
  let highFrequency = false;
  let external = false;

  for (const node of context.walk(owner.body)) {
    if (node.type !== "function_call") continue;
    const path = context.getCallPath(node);
    if (path !== binding.setterName) continue;
    const source = setterCallbackSource(node, binding, importedCallbacks, context);
    if (!source) continue;
    highFrequency ||= source.highFrequency;
    external ||= source.external;
  }

  return highFrequency || external ? { highFrequency, external } : null;
}

function returnedHookValues(binding: StateBinding, context: RuleContext): Array<{ exportName: string; node: SyntaxNode }> {
  const owner = binding.owner;
  if (!owner?.body || !owner.isHook) return [];
  const results: Array<{ exportName: string; node: SyntaxNode }> = [];

  for (const node of context.walk(owner.body)) {
    if (node.type !== "return_statement") continue;
    if (context.nearestFunction(node) !== owner) continue;

    for (const returned of node.namedChildren.flatMap((child) => child.type === "expression_list" ? child.namedChildren : [child])) {
      if (returned.type === "identifier" && returned.text === binding.valueName) {
        results.push({ exportName: binding.valueName, node: returned });
      } else if (returned.type === "table_constructor") {
        for (const field of returned.namedChildren.filter((child) => child.type === "field")) {
          const value = fieldValue(field);
          const name = fieldName(field);
          if (value?.type === "identifier" && value.text === binding.valueName && name) {
            results.push({ exportName: name, node: value });
          }
        }
      }
    }
  }

  return results;
}

function hookCallSitesAreBindingCompatible(
  binding: StateBinding,
  context: RuleContext,
  compatibleComponentProps: Map<string, Set<string>>,
): boolean {
  const owner = binding.owner;
  if (!owner?.isHook || !owner.name) return false;
  const returned = returnedHookValues(binding, context);
  if (returned.length === 0) return false;

  let callSites = 0;
  for (const call of context.findCalls()) {
    const path = context.getCallPath(call);
    if (path !== owner.name) continue;
    const declaration = declarationForCall(call);
    if (!declaration) continue;
    const localName = declarationNames(declaration)[0] ?? null;
    const caller = context.containingComponent(call) ?? context.nearestFunction(call);
    if (!localName || !caller) continue;

    if (returned.length === 1 && returned[0].exportName === binding.valueName) {
      if (!stateReadsAreBindingCompatible(localName, caller, declaration, context, compatibleComponentProps)) return false;
      callSites += 1;
      continue;
    }
  }

  return callSites > 0;
}

function selectorFieldName(call: SyntaxNode, context: RuleContext): string | null {
  const selector = context.callArguments(call)[0];
  if (!selector || selector.type !== "function_definition") return null;
  const text = selector.text;
  return text.match(/\breturn\s+[A-Za-z_][A-Za-z0-9_]*\.([A-Za-z_][A-Za-z0-9_]*)\b/)?.[1]
    ?? text.match(/\breturn\s+[A-Za-z_][A-Za-z0-9_]*\[\s*["']([^"']+)["']\s*\]/)?.[1]
    ?? null;
}

function callDefinitelyUsesBindingMode(
  summary: BindingCandidateHookSummary,
  call: SyntaxNode,
  context: RuleContext,
): boolean {
  const parameterIndex = summary.bindingModeParameterIndex;
  if (parameterIndex === undefined || summary.bindingWhenTruthy === undefined) return false;

  const argument = context.callArguments(call)[parameterIndex];
  const value = argument?.text.trim() ?? "nil";
  let truthy: boolean | null = null;
  if (value === "true") truthy = true;
  else if (value === "false" || value === "nil") truthy = false;
  if (truthy === null) return false;

  return truthy === summary.bindingWhenTruthy;
}

function shouldRecommendImportedHook(
  summary: BindingCandidateHookSummary,
  call: SyntaxNode,
  localName: string,
  owner: FunctionInfo,
  declaration: SyntaxNode,
  context: RuleContext,
  compatibleComponentProps: Map<string, Set<string>>,
): boolean {
  if (!summary.external || callDefinitelyUsesBindingMode(summary, call, context)) return false;
  if (!hasAnyRead(localName, owner, declaration, context)) return false;

  // A hook that mirrors an externally changing Instance property through React state is
  // already a strong producer-side Binding candidate. Consumers may need Binding:map or a
  // binding-aware effect rather than a direct value substitution, so requiring every read to
  // already terminate at a host property creates widespread false negatives.
  if (summary.sourceKind === "measurement") return true;

  return stateReadsAreBindingCompatible(localName, owner, declaration, context, compatibleComponentProps);
}


type BindingUsageKind = "compatible" | "custom-component" | "effect" | "structural" | "unknown";

interface BindingUsageSummary {
  reads: number;
  compatible: number;
  customComponent: number;
  visualCustomComponent: number;
  effect: number;
  structural: number;
  unknown: number;
}

const LIKELY_VISUAL_PROP = /(?:position|size|rotation|transparency|opacity|color|image|text|anchor|visible|enabled|layout|scale|offset|zindex|canvas|viewport|cframe|width|height|radius|stroke|padding|spacing|angle|alpha|progress)/i;

function createElementPropUsage(node: SyntaxNode, context: RuleContext): { component: string; property: string } | null {
  let current: SyntaxNode | null = node;
  while (current) {
    const parent: SyntaxNode | null = current.parent;
    if (!parent) return null;
    if (parent.type === "field") {
      const value = fieldValue(parent);
      if (!value || !sameNode(value, current)) return null;
      const property = fieldName(parent);
      const table = parent.parent;
      const args = table?.parent;
      const call = args?.parent;
      if (!property || table?.type !== "table_constructor" || args?.type !== "arguments" || !call || !isCreateElementCall(call, context)) {
        return null;
      }
      if (!sameNode(context.callArguments(call)[1], table)) return null;
      const component = context.callArguments(call)[0]?.text.trim() ?? "";
      if (!component || /^(?:"[^"]+"|'[^']+')$/.test(component)) return null;
      return { component, property };
    }
    if (parent.type === "function_definition" || parent.type === "function_declaration") return null;
    if (!TRANSPARENT_PARENTS.has(parent.type)) return null;
    current = parent;
  }
  return null;
}

function isEffectUsage(node: SyntaxNode, context: RuleContext): boolean {
  const nearest = context.nearestFunction(node);
  if (nearest) {
    const parent = nearest.node.parent;
    if (parent?.type === "arguments" && parent.parent?.type === "function_call") {
      const path = context.resolveCallPath(context.getCallPath(parent.parent) ?? "");
      if (/^React\.use(?:Effect|LayoutEffect)$/.test(path)) return true;
    }
  }

  let current: SyntaxNode | null = node;
  while (current) {
    const parent: SyntaxNode | null = current.parent;
    if (!parent) break;
    if (parent.type === "arguments" && parent.parent?.type === "function_call") {
      const path = context.resolveCallPath(context.getCallPath(parent.parent) ?? "");
      if (/^React\.use(?:Effect|LayoutEffect)$/.test(path)) return true;
    }
    if (parent.type === "function_definition" || parent.type === "function_declaration") break;
    current = parent;
  }
  return false;
}

function isStructuralUsage(node: SyntaxNode): boolean {
  let current: SyntaxNode | null = node;
  while (current) {
    const parent: SyntaxNode | null = current.parent;
    if (!parent) return false;
    if (parent.type === "if_statement" || parent.type === "elseif_clause" || parent.type === "while_statement"
      || parent.type === "repeat_statement" || parent.type === "return_statement") return true;
    if (parent.type === "function_definition" || parent.type === "function_declaration") return false;
    if (!TRANSPARENT_PARENTS.has(parent.type)) return false;
    current = parent;
  }
  return false;
}

function classifyBindingUsage(
  node: SyntaxNode,
  context: RuleContext,
  compatibleComponentProps: Map<string, Set<string>>,
): BindingUsageKind {
  if (isTransparentUsage(node, context, compatibleComponentProps)) return "compatible";
  if (createElementPropUsage(node, context)) return "custom-component";
  if (isEffectUsage(node, context)) return "effect";
  if (isStructuralUsage(node)) return "structural";
  return "unknown";
}

function bindingUsageSummary(
  valueName: string,
  owner: FunctionInfo,
  declaration: SyntaxNode,
  context: RuleContext,
  compatibleComponentProps: Map<string, Set<string>>,
): BindingUsageSummary {
  const summary: BindingUsageSummary = {
    reads: 0,
    compatible: 0,
    customComponent: 0,
    visualCustomComponent: 0,
    effect: 0,
    structural: 0,
    unknown: 0,
  };
  if (!owner.body) return summary;

  for (const node of context.walk(owner.body)) {
    if (!isReadNode(node, valueName, owner, declaration)) continue;
    summary.reads += 1;
    const customComponentUsage = createElementPropUsage(node, context);
    const kind = classifyBindingUsage(node, context, compatibleComponentProps);
    if (kind === "compatible") summary.compatible += 1;
    else if (kind === "custom-component") {
      summary.customComponent += 1;
      if (customComponentUsage && LIKELY_VISUAL_PROP.test(customComponentUsage.property)) {
        summary.visualCustomComponent += 1;
      }
    } else if (kind === "effect") summary.effect += 1;
    else if (kind === "structural") summary.structural += 1;
    else summary.unknown += 1;
  }
  return summary;
}

function hasCandidatePresentationEvidence(summary: BindingUsageSummary): boolean {
  return summary.compatible > 0 || summary.visualCustomComponent > 0;
}

export const preferBindingOverState: RuleDefinition = {
  id: "react-luau/prefer-binding-over-state",
  category: "Performance",
  severity: "warning",
  description: "Prefer React.useBinding when externally updated values do not need React reconciliation on every change.",
  run(context) {
    const diagnostics = [];
    const seen = new Set<string>();

    const importedHooks = importedBindingCandidateHooks(context);
    const importedCallbacks = importedExternalCallbackFunctions(context);
    const compatibleComponentProps = importedBindingCompatibleComponentProps(context);
    for (const call of context.findCalls()) {
      const path = context.getCallPath(call) ?? "";
      const summary = importedHooks.get(path);
      if (!summary) continue;
      const declaration = declarationForCall(call);
      const localName = declaration ? declarationNames(declaration)[0] ?? null : null;
      const owner = context.containingComponent(call) ?? context.nearestFunction(call);
      if (!declaration || !localName || !owner) continue;
      if (!shouldRecommendImportedHook(summary, call, localName, owner, declaration, context, compatibleComponentProps)) continue;

      const key = `imported:${call.startIndex}:${call.endIndex}:${localName}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const hasBindingMode = summary.bindingModeParameterIndex !== undefined && summary.bindingWhenTruthy !== undefined;
      const message = summary.sourceKind === "measurement"
        ? hasBindingMode
          ? `${path} is using its React state mode for an externally changing GUI measurement, so ${localName} rerenders this consumer when the measurement changes.`
          : `${path} returns React state for an externally changing GUI measurement, so ${localName} rerenders this consumer when the measurement changes.`
        : summary.sourceKind === "derived-external-state"
          ? `${path} derives React state from another externally updated reactive value, so ${localName} adds another rerendering state layer.`
          : `${path} returns state updated${summary.highFrequency ? " from a high-frequency source" : " from an external callback"}, and ${localName} only flows into bindable host properties.`;
      const bindingModeInstruction = hasBindingMode
        ? `Use the hook's Binding-returning mode${summary.bindingModeParameterName ? ` by passing ${summary.bindingWhenTruthy ? "true" : "false"} for ${summary.bindingModeParameterName}` : ""}. `
        : "Prefer a Binding-returning measurement hook. ";
      const help = summary.sourceKind === "measurement"
        ? `${bindingModeInstruction}Use Binding:map for derived visual values or a binding-aware effect for imperative reactions; keep React state only when the measurement truly needs to rebuild component structure.`
        : "Prefer a Binding-returning hook API so host properties can update without rerendering the consumer.";
      diagnostics.push({
        node: callNameNode(call),
        message,
        help,
        fixPreview: hasBindingMode ? bindingModeFixPreview(summary, call, context) : undefined,
      });
    }

    for (const call of context.findCalls()) {
      const path = context.getCallPath(call) ?? "";
      const member = path.split(/[.:]/).at(-1) ?? path;
      const bindingAlternative = context.project.bindingApiAlternatives.get(member);
      if (!bindingAlternative) continue;
      const declaration = declarationForCall(call);
      const localName = declaration ? declarationNames(declaration)[0] ?? null : null;
      const owner = context.containingComponent(call) ?? context.nearestFunction(call);
      if (!declaration || !localName || !owner || !hasAnyRead(localName, owner, declaration, context)) continue;
      if (!stateReadsAreBindingCompatible(localName, owner, declaration, context, compatibleComponentProps)) continue;
      const field = selectorFieldName(call, context);

      const key = `state-api:${call.startIndex}:${call.endIndex}:${localName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.push({
        node: callNameNode(call),
        message: `${path} subscribes ${localName} through React state${field ? ` for ${field}` : ""}, but ${bindingAlternative} is available and every use of the value only updates bindable host properties.`,
        help: `Use ${bindingAlternative} so the host property can update without rerendering the component.`,
        fixPreview: callMemberFixPreview(call, bindingAlternative),
      });
    }

    for (const binding of context.model.stateBindings) {
      const owner = binding.owner;
      if (!owner || (!owner.isComponent && !owner.isHook)) continue;
      const updateKind = bindingHasExternalOrHighFrequencyUpdates(binding, importedCallbacks, context);
      if (!updateKind) continue;

      const localCompatible = stateReadsAreBindingCompatible(
        binding.valueName,
        owner,
        binding.declaration,
        context,
        compatibleComponentProps,
      );
      const hookCompatible = owner.isHook ? hookCallSitesAreBindingCompatible(binding, context, compatibleComponentProps) : false;
      if (owner.isHook ? !hookCompatible : !localCompatible) continue;

      const key = `${binding.call.startIndex}:${binding.call.endIndex}:${binding.valueName}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (owner.isHook && hookCompatible) {
        diagnostics.push({
          node: callNameNode(binding.call),
          message: `Hook state ${binding.valueName} is updated${updateKind.highFrequency ? " from a high-frequency source" : " from an external callback"} and is only consumed by host properties at analyzed call sites.`,
          help: "Consider returning a Binding, or adding a Binding-returning variant of this hook, so consumers can update host properties without rerendering.",
        });
      } else {
        diagnostics.push({
          node: callNameNode(binding.call),
          message: `State ${binding.valueName} is updated${updateKind.highFrequency ? " from a high-frequency callback" : " from an external callback"} and is read by the component render path.`,
          help: "Prefer React.useBinding when the update is visual and does not need React to rebuild component structure.",
          fixPreview: useBindingFixPreview(binding.call),
        });
      }
    }

    return diagnostics;
  },
};


export const preferBindingOverStateCandidate: RuleDefinition = {
  id: "react-luau/prefer-binding-over-state-candidate",
  category: "Performance",
  severity: "suggestion",
  description: "Surface lower-confidence state-to-Binding opportunities that need developer review.",
  run(context) {
    const diagnostics = [];
    const seen = new Set<string>();
    const importedHooks = importedBindingCandidateHooks(context);
    const importedCallbacks = importedExternalCallbackFunctions(context);
    const compatibleComponentProps = importedBindingCompatibleComponentProps(context);

    for (const call of context.findCalls()) {
      const path = context.getCallPath(call) ?? "";
      const summary = importedHooks.get(path);
      if (!summary || !summary.external || callDefinitelyUsesBindingMode(summary, call, context)) continue;
      const declaration = declarationForCall(call);
      const localName = declaration ? declarationNames(declaration)[0] ?? null : null;
      const owner = context.containingComponent(call) ?? context.nearestFunction(call);
      if (!declaration || !localName || !owner || !hasAnyRead(localName, owner, declaration, context)) continue;
      if (shouldRecommendImportedHook(summary, call, localName, owner, declaration, context, compatibleComponentProps)) continue;

      const usage = bindingUsageSummary(localName, owner, declaration, context, compatibleComponentProps);
      const hasPresentationEvidence = hasCandidatePresentationEvidence(usage)
        || (summary.sourceKind === "derived-external-state" && usage.effect > 0);
      if (!summary.highFrequency && !hasPresentationEvidence) continue;

      const key = `imported:${call.startIndex}:${call.endIndex}:${localName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.push({
        node: callNameNode(call),
        message: `${path} updates ${localName} through React state when outside data changes. Some uses of ${localName} may need a rerender, so switching it entirely to a Binding could change behavior.`,
        help: "Inspect whether the value can become a Binding, use Binding:map for visual derivation, or split visual updates from the smaller part of the value that truly needs React state.",
      });
    }

    for (const call of context.findCalls()) {
      const path = context.getCallPath(call) ?? "";
      const member = path.split(/[.:]/).at(-1) ?? path;
      const bindingAlternative = context.project.bindingApiAlternatives.get(member);
      if (!bindingAlternative) continue;
      const declaration = declarationForCall(call);
      const localName = declaration ? declarationNames(declaration)[0] ?? null : null;
      const owner = context.containingComponent(call) ?? context.nearestFunction(call);
      if (!declaration || !localName || !owner || !hasAnyRead(localName, owner, declaration, context)) continue;
      if (stateReadsAreBindingCompatible(localName, owner, declaration, context, compatibleComponentProps)) continue;

      const key = `state-api:${call.startIndex}:${call.endIndex}:${localName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.push({
        node: callNameNode(call),
        message: `${path} uses React state even though ${bindingAlternative} is available. Some uses of ${localName} may need a rerender, so replacing it entirely with the Binding API could change behavior.`,
        help: `Inspect whether ${bindingAlternative}, Binding:map, or splitting visual and structural consumers would avoid unnecessary rerenders.`,
        fixPreview: callMemberFixPreview(call, bindingAlternative),
      });
    }

    for (const binding of context.model.stateBindings) {
      const owner = binding.owner;
      if (!owner || !owner.isComponent || !owner.body) continue;
      const updateKind = bindingHasExternalOrHighFrequencyUpdates(binding, importedCallbacks, context);
      if (!updateKind) continue;
      if (stateReadsAreBindingCompatible(binding.valueName, owner, binding.declaration, context, compatibleComponentProps)) continue;

      const usage = bindingUsageSummary(binding.valueName, owner, binding.declaration, context, compatibleComponentProps);
      if (!hasCandidatePresentationEvidence(usage)) continue;

      const key = `state:${binding.call.startIndex}:${binding.call.endIndex}:${binding.valueName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.push({
        node: callNameNode(binding.call),
        message: `State ${binding.valueName} is updated${updateKind.highFrequency ? " from a high-frequency source" : " from an external callback"} and appears at least partly presentation-oriented, but some consumers may still require React state.`,
        help: "Inspect whether visual consumers can move to React.useBinding while structural consumers keep a smaller state value. Splitting the responsibilities can remove rerenders without changing component behavior.",
      });
    }

    return diagnostics;
  },
};
