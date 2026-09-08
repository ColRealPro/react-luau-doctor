import type { SyntaxNode } from "../syntax";
import { normalizeRequireTarget, resolveModuleReference } from "../module-resolution";
import type { BindingCandidateHookSummary, ExternalCallbackFunctionSummary, FixPreview, FunctionInfo, RuleContext, RuleDefinition, StateBinding } from "../types";
import { sameNode } from "../ast/walk";
import { isHighFrequencyRobloxCall, isHighFrequencyRobloxExpression } from "../roblox-semantics";
import { callNameNode, declarationNames, fieldName, fieldValue, isBindingShadowedBetween } from "./helpers";

const EXTERNAL_CALLBACK = /(?:^|[.:])(?:Connect|Subscribe|Observe|Listen|Watch|onStep|onUpdate|onChange|onChanged)$/i;
const PERSISTENT_MIRROR_CALLBACK = /(?:^|[.:])(?:Connect|Subscribe|Observe|Listen|Watch|onStep|onUpdate|onChange|onChanged)$/i;
const LIKELY_CONTINUOUS_CALLBACK = /(?:^|[.:])onStep$/i;
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

interface ImportedBindingSummaries {
  hooks: Map<string, BindingCandidateHookSummary>;
  callbacks: Map<string, ExternalCallbackFunctionSummary>;
  compatibleProps: Map<string, Set<string>>;
}

const importedBindingSummariesCache = new WeakMap<RuleContext, ImportedBindingSummaries>();

function importedBindingSummaries(context: RuleContext): ImportedBindingSummaries {
  const cached = importedBindingSummariesCache.get(context);
  if (cached) return cached;

  const result: ImportedBindingSummaries = {
    hooks: new Map(),
    callbacks: new Map(),
    compatibleProps: new Map(),
  };

  for (const node of context.walk(context.root)) {
    if (node.type !== "variable_declaration") continue;
    const match = node.text.match(/^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\s*\((.*?)\)\s*$/s);
    if (!match) continue;
    const [, localName, target] = match;
    const normalizedTarget = normalizeRequireTarget(target);

    const hook = resolveModuleReference(normalizedTarget, context.project.bindingCandidateHooks);
    if (hook) result.hooks.set(localName, hook);

    const callback = resolveModuleReference(normalizedTarget, context.project.externalCallbackModules);
    if (callback) result.callbacks.set(localName, callback);

    const compatibleProps = resolveModuleReference(normalizedTarget, context.project.bindingCompatibleComponentProps);
    if (compatibleProps) result.compatibleProps.set(localName, compatibleProps);
  }

  importedBindingSummariesCache.set(context, result);
  return result;
}

function importedBindingCandidateHooks(context: RuleContext): Map<string, BindingCandidateHookSummary> {
  return importedBindingSummaries(context).hooks;
}

function importedExternalCallbackFunctions(context: RuleContext): Map<string, ExternalCallbackFunctionSummary> {
  return importedBindingSummaries(context).callbacks;
}

function importedBindingCompatibleComponentProps(context: RuleContext): Map<string, Set<string>> {
  return importedBindingSummaries(context).compatibleProps;
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
  "dot_index_expression",
  "method_index_expression",
  "table_constructor",
  "field",
]);

const PURE_BINDING_DERIVATION_CALL = /^(?:tostring|tonumber|type|typeof|math\.[A-Za-z_][A-Za-z0-9_]*|string\.[A-Za-z_][A-Za-z0-9_]*|utf8\.[A-Za-z_][A-Za-z0-9_]*|bit32\.[A-Za-z_][A-Za-z0-9_]*|(?:UDim|UDim2|Vector2|Vector3|Color3|CFrame|Rect|NumberRange|NumberSequence|ColorSequence|BrickColor|Font)\.[A-Za-z_][A-Za-z0-9_]*)$/;

const HOST_FEEDBACK_PROPERTIES = new Set([
  "AbsoluteSize",
  "AbsolutePosition",
  "AbsoluteRotation",
  "AbsoluteContentSize",
  "AbsoluteCanvasSize",
  "AbsoluteCellSize",
  "AbsoluteCellCount",
  "TextBounds",
  "CanvasPosition",
]);

const LIKELY_CONTINUOUS_PROPERTIES = new Set([
  "CFrame",
  "WorldCFrame",
  "Position",
  "WorldPosition",
  "Rotation",
  "Orientation",
  "CanvasPosition",
  "PlaybackLoudness",
  "TimePosition",
]);

const SEMANTIC_SNAPSHOT_EXPRESSION =
  /\b(?:getState|getSnapshot|snapshot|selector|select|table\s*\.\s*(?:clone|freeze|move))\b|(?:\.|\[\s*["'])State(?:\b|["']\s*\])/i;

function isBindingMapSafeCall(call: SyntaxNode, context: RuleContext): boolean {
  if (call.type !== "function_call") return false;
  const path = context.resolveCallPath(context.getCallPath(call) ?? "").replace(/\s+/g, "");
  return PURE_BINDING_DERIVATION_CALL.test(path);
}

function isTransparentParent(parent: SyntaxNode, context: RuleContext): boolean {
  if (parent.type === "function_call") return isBindingMapSafeCall(parent, context);
  if (parent.type === "arguments") {
    return parent.parent?.type === "function_call" && isBindingMapSafeCall(parent.parent, context);
  }
  return TRANSPARENT_PARENTS.has(parent.type);
}

function stringLiteralValue(node: SyntaxNode | undefined): string | null {
  if (!node) return null;
  return node.text.trim().match(/^["']([^"']+)["']$/)?.[1] ?? null;
}

function observedPropertyForCall(
  summary: BindingCandidateHookSummary,
  call: SyntaxNode,
  context: RuleContext,
): string | null {
  if (summary.observedPropertyName) return summary.observedPropertyName;
  if (summary.observedPropertyParameterIndex === undefined) return null;
  return stringLiteralValue(context.callArguments(call)[summary.observedPropertyParameterIndex]);
}

function isStrongHostFeedbackProperty(property: string | null | undefined): boolean {
  return Boolean(property && HOST_FEEDBACK_PROPERTIES.has(property));
}

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
  if (isBindingShadowedBetween(node, owner, valueName, declaration)) return false;
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
    if (!isTransparentParent(parent, context)) return false;
    current = parent;
  }
  return false;
}

function isDirectBindingValueUsage(
  node: SyntaxNode,
  context: RuleContext,
  compatibleComponentProps: Map<string, Set<string>>,
): boolean {
  let current: SyntaxNode | null = node;
  while (current) {
    const parent: SyntaxNode | null = current.parent;
    if (!parent) return false;
    if (parent.type === "parenthesized_expression" || parent.type === "cast_expression" || parent.type === "type_cast_expression") {
      current = parent;
      continue;
    }
    if (parent.type !== "field") return false;
    const value = fieldValue(parent);
    if (!value || !sameNode(value, current)) return false;
    const property = fieldName(parent);
    if (!property || NON_BINDABLE_HOST_FIELDS.has(property)) return false;
    const table = parent.parent;
    const args = table?.parent;
    const call = args?.parent;
    if (table?.type !== "table_constructor" || args?.type !== "arguments" || !call || !isCreateElementCall(call, context)) {
      return false;
    }
    if (!sameNode(context.callArguments(call)[1], table)) return false;
    if (isHostCreateElementCall(call, context)) return true;
    const component = context.callArguments(call)[0]?.text.trim() ?? "";
    return compatibleComponentProps.get(component)?.has(property) ?? false;
  }
  return false;
}

function allReadsDirectlyBindingSubstitutable(
  valueName: string,
  owner: FunctionInfo,
  declaration: SyntaxNode,
  context: RuleContext,
  compatibleComponentProps: Map<string, Set<string>>,
): boolean {
  if (!owner.body) return false;
  let reads = 0;
  for (const node of context.walk(owner.body)) {
    if (!isReadNode(node, valueName, owner, declaration)) continue;
    reads += 1;
    if (!isDirectBindingValueUsage(node, context, compatibleComponentProps)) return false;
  }
  return reads > 0;
}

function derivedLocalDeclarationForRead(node: SyntaxNode, context: RuleContext): SyntaxNode | null {
  let current: SyntaxNode | null = node;
  while (current) {
    const parent: SyntaxNode | null = current.parent;
    if (!parent) return null;
    if (parent.type === "variable_declaration") return parent;
    if (parent.type === "function_definition" || parent.type === "function_declaration") return null;
    if (!isTransparentParent(parent, context)) return null;
    current = parent;
  }
  return null;
}

function opaqueDerivedLocalDeclarationForRead(node: SyntaxNode, context: RuleContext): SyntaxNode | null {
  let current: SyntaxNode | null = node;
  while (current) {
    const parent: SyntaxNode | null = current.parent;
    if (!parent) return null;
    if (parent.type === "variable_declaration") return parent;
    if (parent.type === "function_definition" || parent.type === "function_declaration") return null;
    if (parent.type === "if_statement" || parent.type === "elseif_clause" || parent.type === "while_statement"
      || parent.type === "repeat_statement" || parent.type === "for_statement" || parent.type === "for_in_statement"
      || parent.type === "return_statement") return null;
    if (parent.type === "function_call") {
      const path = context.resolveCallPath(context.getCallPath(parent) ?? "");
      // Values captured by React memo/effect hooks still rely on reconciliation
      // to recompute or re-run that hook. Do not treat the hook's result as an
      // opaque Binding derivation just because its dependency table mentions
      // the value.
      if (/^React\.use(?:Memo|Callback|Effect|LayoutEffect)$/.test(path)) return null;
    }
    if (!TRANSPARENT_PARENTS.has(parent.type) && parent.type !== "arguments" && parent.type !== "function_call") return null;
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

    const derivedDeclaration = derivedLocalDeclarationForRead(node, context);
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

interface CallbackSourceEvidence {
  highFrequency: boolean;
  external: boolean;
  hostFeedbackProperties: Set<string>;
  genericExternal: boolean;
}

type MirrorConfidence = "strong" | "possible" | "none";

interface BindingUpdateEvidence extends CallbackSourceEvidence {
  mirrorConfidence: MirrorConfidence;
}

function propertyChangedSignalProperty(text: string): string | null {
  return text.match(/GetPropertyChangedSignal\s*\(\s*["']([^"']+)["']\s*\)/)?.[1] ?? null;
}

function reactChangePropertyForCallback(node: SyntaxNode): string | null {
  let current: SyntaxNode | null = node.parent;
  while (current && current.type !== "function_definition" && current.type !== "function_declaration") {
    if (current.type === "field") {
      return current.text.match(/React\s*\.\s*Change\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? null;
    }
    current = current.parent;
  }
  return null;
}

function evidenceForExternalSource(
  highFrequency: boolean,
  hostFeedbackProperty?: string | null,
): CallbackSourceEvidence {
  const hostFeedbackProperties = new Set<string>();
  if (hostFeedbackProperty) hostFeedbackProperties.add(hostFeedbackProperty);
  return {
    highFrequency,
    external: true,
    hostFeedbackProperties,
    genericExternal: !highFrequency && !hostFeedbackProperty,
  };
}

function mergeSourceEvidence(
  target: CallbackSourceEvidence,
  source: CallbackSourceEvidence,
): void {
  target.highFrequency ||= source.highFrequency;
  target.external ||= source.external;
  target.genericExternal ||= source.genericExternal;
  for (const property of source.hostFeedbackProperties) target.hostFeedbackProperties.add(property);
}

function callbackSource(call: SyntaxNode, context: RuleContext): CallbackSourceEvidence | null {
  const normalized = (context.getCallPath(call) ?? "").replace(/\s+/g, "");
  const highFrequency = isHighFrequencyRobloxCall(call, context) || LIKELY_CONTINUOUS_CALLBACK.test(normalized);
  const hostFeedbackProperty = propertyChangedSignalProperty(call.text);
  const final = normalized.split(/[.:]/).at(-1) ?? normalized;
  const external = highFrequency || Boolean(hostFeedbackProperty) || EXTERNAL_CALLBACK.test(normalized) || EXTERNAL_CALLBACK.test(final);
  if (!external) return null;
  return evidenceForExternalSource(highFrequency, hostFeedbackProperty);
}

function importedCallbackSource(
  call: SyntaxNode,
  callbackArgument: SyntaxNode,
  importedCallbacks: Map<string, ExternalCallbackFunctionSummary>,
  context: RuleContext,
): CallbackSourceEvidence | null {
  const path = context.getCallPath(call) ?? "";
  const summary = importedCallbacks.get(path);
  if (!summary) return null;
  const args = context.callArguments(call);
  const callbackIndex = args.findIndex((arg) => sameNode(arg, callbackArgument));
  if (callbackIndex < 0 || !summary.callbackParameterIndexes.includes(callbackIndex)) return null;
  const highFrequency = summary.highFrequency || args.some((arg) => isHighFrequencyRobloxExpression(arg, context));
  const hostFeedbackProperty = args
    .map((arg) => propertyChangedSignalProperty(arg.text))
    .find((property): property is string => Boolean(property));
  return evidenceForExternalSource(highFrequency, hostFeedbackProperty);
}

function directCallbackSource(
  node: SyntaxNode,
  importedCallbacks: Map<string, ExternalCallbackFunctionSummary>,
  context: RuleContext,
): CallbackSourceEvidence | null {
  const reactChangeProperty = reactChangePropertyForCallback(node);
  if (reactChangeProperty) return evidenceForExternalSource(false, reactChangeProperty);

  const parent = node.parent;
  if (parent?.type !== "arguments" || parent.parent?.type !== "function_call") return null;
  const call = parent.parent;
  const imported = importedCallbackSource(call, node, importedCallbacks, context);
  if (imported) return imported;
  return callbackSource(call, context);
}

function namedFunctionCallbackSource(
  fn: FunctionInfo,
  owner: FunctionInfo,
  importedCallbacks: Map<string, ExternalCallbackFunctionSummary>,
  context: RuleContext,
): CallbackSourceEvidence | null {
  if (!fn.name || !owner.body) return null;
  const result: CallbackSourceEvidence = {
    highFrequency: false,
    external: false,
    hostFeedbackProperties: new Set(),
    genericExternal: false,
  };

  for (const call of context.walk(owner.body)) {
    if (call.type !== "function_call") continue;
    const args = context.callArguments(call);
    const callbackArg = args.find((arg) => arg.type === "identifier" && arg.text === fn.name);
    if (!callbackArg) continue;
    const source = importedCallbackSource(call, callbackArg, importedCallbacks, context)
      ?? callbackSource(call, context);
    if (!source) continue;
    mergeSourceEvidence(result, source);
  }

  return result.external ? result : null;
}

function setterCallbackSource(
  call: SyntaxNode,
  binding: StateBinding,
  importedCallbacks: Map<string, ExternalCallbackFunctionSummary>,
  context: RuleContext,
): CallbackSourceEvidence | null {
  const owner = binding.owner;
  if (!owner) return null;
  const nearest = context.nearestFunction(call);
  if (!nearest || nearest === owner) return null;

  const direct = directCallbackSource(nearest.node, importedCallbacks, context);
  if (direct) return direct;

  return namedFunctionCallbackSource(nearest, owner, importedCallbacks, context);
}

function mirrorConfidenceRank(confidence: MirrorConfidence): number {
  if (confidence === "strong") return 2;
  if (confidence === "possible") return 1;
  return 0;
}

function mergeMirrorConfidence(a: MirrorConfidence, b: MirrorConfidence): MirrorConfidence {
  return mirrorConfidenceRank(b) > mirrorConfidenceRank(a) ? b : a;
}

function isLiteralStateTransition(node: SyntaxNode | undefined): boolean {
  if (!node) return true;
  const text = node.text.trim();
  return /^(?:true|false|nil|[-+]?\d+(?:\.\d+)?|["'][^"']*["'])$/.test(text);
}

function isSemanticSnapshotExpression(node: SyntaxNode | undefined): boolean {
  return Boolean(node && SEMANTIC_SNAPSHOT_EXPRESSION.test(node.text));
}

function expressionReferencesCallbackParameter(
  expression: SyntaxNode,
  callback: FunctionInfo,
  context: RuleContext,
): boolean {
  if (callback.parameters.length === 0) return false;
  const parameters = new Set(callback.parameters);
  return [...context.walk(expression)].some(
    (node) => node.type === "identifier" && parameters.has(node.text),
  );
}

const PURE_EXPRESSION_ROOTS = new Set([
  "math",
  "string",
  "utf8",
  "bit32",
  "UDim",
  "UDim2",
  "Vector2",
  "Vector3",
  "Color3",
  "CFrame",
  "Rect",
  "NumberRange",
  "NumberSequence",
  "ColorSequence",
  "BrickColor",
  "Font",
  "Enum",
  "tostring",
  "tonumber",
  "type",
  "typeof",
]);

function callbackLocalNamesBefore(
  callback: FunctionInfo,
  before: SyntaxNode,
  context: RuleContext,
): Set<string> {
  const names = new Set<string>();
  if (!callback.body) return names;
  for (const node of context.walk(callback.body)) {
    if (node.startIndex >= before.startIndex) continue;
    if (context.nearestFunction(node) !== callback || node.type !== "variable_declaration") continue;
    for (const name of declarationNames(node)) names.add(name);
  }
  return names;
}

function expressionHasExternalInput(
  expression: SyntaxNode,
  callback: FunctionInfo,
  setterCall: SyntaxNode,
  context: RuleContext,
): boolean {
  const callbackLocals = callbackLocalNamesBefore(callback, setterCall, context);
  const callbackParameters = new Set(callback.parameters);
  for (const node of context.walk(expression)) {
    if (node.type !== "identifier" || isIdentifierPropertyName(node)) continue;
    const name = node.text;
    if (callbackParameters.has(name)) return true;
    if (callbackLocals.has(name)) continue;
    if (context.model.stateValues.has(name)) continue;
    if (PURE_EXPRESSION_ROOTS.has(name)) continue;
    return true;
  }
  return false;
}

function setterHasDistinctValuesInCallback(
  call: SyntaxNode,
  callback: FunctionInfo,
  context: RuleContext,
): boolean {
  if (!callback.body) return false;
  const setterPath = context.getCallPath(call);
  const distinctValues = new Set<string>();
  for (const sibling of context.walk(callback.body)) {
    if (sibling.type !== "function_call" || context.nearestFunction(sibling) !== callback) continue;
    if (context.getCallPath(sibling) !== setterPath) continue;
    const argument = context.callArguments(sibling)[0];
    if (argument) distinctValues.add(argument.text.trim());
  }
  return distinctValues.size > 1;
}

function setterCallMirrorConfidence(
  call: SyntaxNode,
  callback: FunctionInfo,
  source: CallbackSourceEvidence,
  context: RuleContext,
): MirrorConfidence {
  const value = context.callArguments(call)[0];
  if (!value || value.type === "function_definition") return "none";
  if (isLiteralStateTransition(value)) {
    return source.highFrequency && setterHasDistinctValuesInCallback(call, callback, context)
      ? "strong"
      : "none";
  }
  if (isSemanticSnapshotExpression(value)) return "none";

  if (expressionReferencesCallbackParameter(value, callback, context)) return "strong";

  if (source.hostFeedbackProperties.size > 0) {
    const text = value.text;
    if ([...source.hostFeedbackProperties].some((property) => new RegExp(`(?:\\.|["'])${property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text))) {
      return "strong";
    }
  }

  if (!expressionHasExternalInput(value, callback, call, context)) {
    return source.highFrequency && setterHasDistinctValuesInCallback(call, callback, context)
      ? "strong"
      : "none";
  }

  // Some subscriptions do not provide the changing value as a callback
  // parameter (mouse.Move and many custom signals are common examples). A
  // non-semantic expression read inside a proven hot callback is still strong
  // mirror evidence; for an unknown-rate callback keep it as a candidate only.
  if (source.highFrequency) return "strong";
  return source.genericExternal ? "possible" : "strong";
}

function mergeBindingUpdateEvidence(
  target: BindingUpdateEvidence,
  source: CallbackSourceEvidence,
  mirrorConfidence: MirrorConfidence,
): void {
  if (mirrorConfidence === "none") return;
  mergeSourceEvidence(target, source);
  target.mirrorConfidence = mergeMirrorConfidence(target.mirrorConfidence, mirrorConfidence);
}

function bindingUpdateEvidence(
  binding: StateBinding,
  importedCallbacks: Map<string, ExternalCallbackFunctionSummary>,
  context: RuleContext,
): BindingUpdateEvidence | null {
  const owner = binding.owner;
  if (!owner?.body) return null;
  const result: BindingUpdateEvidence = {
    highFrequency: false,
    external: false,
    hostFeedbackProperties: new Set(),
    genericExternal: false,
    mirrorConfidence: "none",
  };

  for (const node of context.walk(owner.body)) {
    if (node.type !== "function_call") continue;
    const path = context.getCallPath(node);
    if (path === binding.setterName) {
      const source = setterCallbackSource(node, binding, importedCallbacks, context);
      const callback = context.nearestFunction(node);
      if (!source || !callback || callback === owner) continue;
      mergeBindingUpdateEvidence(
        result,
        source,
        setterCallMirrorConfidence(node, callback, source, context),
      );
      continue;
    }

    // Also catch the very common `signal:Connect(setValue)` shape, where the
    // setter itself is the subscription callback and therefore never appears
    // as a function_call node.
    const args = context.callArguments(node);
    const setterArg = args.find((arg) => arg.type === "identifier" && arg.text === binding.setterName);
    if (!setterArg) continue;
    const normalized = (context.getCallPath(node) ?? "").replace(/\s+/g, "");
    const imported = importedCallbackSource(node, setterArg, importedCallbacks, context);
    const source = imported ?? (PERSISTENT_MIRROR_CALLBACK.test(normalized) ? callbackSource(node, context) : null);
    if (!source) continue;
    mergeBindingUpdateEvidence(result, source, "strong");
  }

  return result.external && result.mirrorConfidence !== "none" ? result : null;
}

function hasStrongHostFeedbackEvidence(source: CallbackSourceEvidence): boolean {
  if (source.genericExternal || source.hostFeedbackProperties.size === 0) return false;
  return [...source.hostFeedbackProperties].every((property) => isStrongHostFeedbackProperty(property));
}

function hasLikelyContinuousPropertyEvidence(source: CallbackSourceEvidence): boolean {
  if (source.hostFeedbackProperties.size === 0) return false;
  return [...source.hostFeedbackProperties].every((property) => LIKELY_CONTINUOUS_PROPERTIES.has(property));
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

type BindingRecommendation = "warning" | "candidate" | null;

function hasExplicitBindingMode(summary: BindingCandidateHookSummary): boolean {
  return summary.bindingModeParameterIndex !== undefined && summary.bindingWhenTruthy !== undefined;
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
    if (!isTransparentParent(parent, context)) return null;
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

function isStructuralUsage(node: SyntaxNode, context: RuleContext): boolean {
  let current: SyntaxNode | null = node;
  while (current) {
    const parent: SyntaxNode | null = current.parent;
    if (!parent) return false;
    if (parent.type === "if_statement" || parent.type === "elseif_clause" || parent.type === "while_statement"
      || parent.type === "repeat_statement" || parent.type === "for_statement" || parent.type === "for_in_statement"
      || parent.type === "return_statement") return true;
    if (parent.type === "function_definition" || parent.type === "function_declaration") return false;
    if (!isTransparentParent(parent, context)) return false;
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
  if (isStructuralUsage(node, context)) return "structural";
  return "unknown";
}

function bindingUsageSummary(
  valueName: string,
  owner: FunctionInfo,
  declaration: SyntaxNode,
  context: RuleContext,
  compatibleComponentProps: Map<string, Set<string>>,
  visited = new Set<string>(),
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
  const visitKey = `${declaration.startIndex}:${valueName}`;
  if (visited.has(visitKey)) return summary;
  visited.add(visitKey);

  for (const node of context.walk(owner.body)) {
    if (!isReadNode(node, valueName, owner, declaration)) continue;
    if (!isTransparentUsage(node, context, compatibleComponentProps)) {
      const derivedDeclaration = derivedLocalDeclarationForRead(node, context);
      const derivedNames = derivedDeclaration ? declarationNames(derivedDeclaration) : [];
      if (derivedDeclaration && derivedNames.length === 1) {
        const derived = bindingUsageSummary(
          derivedNames[0],
          owner,
          derivedDeclaration,
          context,
          compatibleComponentProps,
          new Set(visited),
        );
        if (derived.reads > 0) {
          summary.reads += derived.reads;
          summary.compatible += derived.compatible;
          summary.customComponent += derived.customComponent;
          summary.visualCustomComponent += derived.visualCustomComponent;
          summary.effect += derived.effect;
          summary.structural += derived.structural;
          summary.unknown += derived.unknown;
          continue;
        }
      }

      const opaqueDeclaration = opaqueDerivedLocalDeclarationForRead(node, context);
      const opaqueNames = opaqueDeclaration ? declarationNames(opaqueDeclaration) : [];
      if (opaqueDeclaration && opaqueNames.length === 1) {
        const derived = bindingUsageSummary(
          opaqueNames[0],
          owner,
          opaqueDeclaration,
          context,
          compatibleComponentProps,
          new Set(visited),
        );
        if (derived.reads > 0) {
          summary.reads += derived.reads + 1;
          summary.compatible += derived.compatible;
          summary.customComponent += derived.customComponent;
          summary.visualCustomComponent += derived.visualCustomComponent;
          summary.effect += derived.effect;
          summary.structural += derived.structural;
          summary.unknown += derived.unknown + 1;
          continue;
        }
      }
    }

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

function isPresentationOnly(summary: BindingUsageSummary): boolean {
  return summary.reads > 0 && summary.compatible === summary.reads;
}

function stateBindingForSetter(setterName: string, context: RuleContext): StateBinding | null {
  const valueName = context.model.stateSetters.get(setterName);
  if (!valueName) return null;
  return context.model.stateBindings.find(
    (binding) => binding.setterName === setterName && binding.valueName === valueName,
  ) ?? null;
}

function effectOnlyDerivesPresentation(
  valueName: string,
  owner: FunctionInfo,
  declaration: SyntaxNode,
  context: RuleContext,
  compatibleComponentProps: Map<string, Set<string>>,
): boolean {
  if (!owner.body) return false;
  let foundRelevantEffect = false;

  for (const call of context.walk(owner.body)) {
    if (call.type !== "function_call" || context.nearestFunction(call) !== owner) continue;
    const path = context.resolveCallPath(context.getCallPath(call) ?? "");
    if (path !== "React.useEffect" && path !== "React.useLayoutEffect") continue;

    const callbackNode = context.callArguments(call)[0];
    if (callbackNode?.type !== "function_definition") continue;
    const callback = context.model.functionByNode.get(callbackNode.id);
    if (!callback?.body) continue;

    const usesValue = [...context.walk(callback.body)].some(
      (node) => context.nearestFunction(node) === callback
        && isReadNode(node, valueName, owner, declaration),
    );
    if (!usesValue) continue;
    foundRelevantEffect = true;

    let presentationSetter = false;
    for (const nested of context.walk(callback.body)) {
      if (nested.type !== "function_call" || context.nearestFunction(nested) !== callback) continue;
      if (isBindingMapSafeCall(nested, context)) continue;

      const nestedPath = context.resolveCallPath(context.getCallPath(nested) ?? "");
      if (nestedPath === "debug.profilebegin" || nestedPath === "debug.profileend") continue;
      if (context.model.bindingSetters.has(nestedPath)) {
        presentationSetter = true;
        continue;
      }

      const target = stateBindingForSetter(nestedPath, context);
      if (target?.owner && stateReadsAreBindingCompatible(
        target.valueName,
        target.owner,
        target.declaration,
        context,
        compatibleComponentProps,
      )) {
        presentationSetter = true;
        continue;
      }

      // An effect that performs any other call is doing behavior Doctor cannot
      // safely reproduce with Binding:map/joinBindings. Keep normal React state.
      return false;
    }

    if (!presentationSetter) return false;
  }

  return foundRelevantEffect;
}

function importedHookRecommendation(
  summary: BindingCandidateHookSummary,
  call: SyntaxNode,
  localName: string,
  owner: FunctionInfo,
  declaration: SyntaxNode,
  context: RuleContext,
  compatibleComponentProps: Map<string, Set<string>>,
): BindingRecommendation {
  if (!summary.external || callDefinitelyUsesBindingMode(summary, call, context)) return null;
  const usage = bindingUsageSummary(localName, owner, declaration, context, compatibleComponentProps);
  if (usage.reads === 0) return null;

  const presentationOnly = isPresentationOnly(usage);
  const explicitBindingMode = hasExplicitBindingMode(summary);
  const observedProperty = observedPropertyForCall(summary, call, context);
  const strongHostFeedback = summary.sourceKind === "instance-property"
    && isStrongHostFeedbackProperty(observedProperty);
  const likelyContinuousProperty = summary.sourceKind === "instance-property"
    && Boolean(observedProperty && LIKELY_CONTINUOUS_PROPERTIES.has(observedProperty));
  const mirrorsExternalValue = summary.mirrorConfidence !== "none";

  if (presentationOnly && (summary.highFrequency || likelyContinuousProperty)) return "warning";
  if (presentationOnly && strongHostFeedback && explicitBindingMode) return "warning";

  if (presentationOnly && (explicitBindingMode || strongHostFeedback || mirrorsExternalValue)) return "candidate";
  if (
    strongHostFeedback
    && usage.effect > 0
    && effectOnlyDerivesPresentation(
      localName,
      owner,
      declaration,
      context,
      compatibleComponentProps,
    )
  ) {
    return "candidate";
  }
  if (!hasCandidatePresentationEvidence(usage)) return null;

  if (summary.highFrequency || likelyContinuousProperty) return "candidate";
  if (strongHostFeedback && explicitBindingMode && usage.effect === 0) return "candidate";
  return null;
}

export const preferBindingOverState: RuleDefinition = {
  id: "react-luau/prefer-binding-over-state",
  category: "Performance",
  severity: "warning",
  description: "Prefer React.useBinding when proven external presentation streams do not need React reconciliation.",
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
      if (importedHookRecommendation(summary, call, localName, owner, declaration, context, compatibleComponentProps) !== "warning") continue;

      const key = `imported:${call.startIndex}:${call.endIndex}:${localName}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const hasBindingMode = hasExplicitBindingMode(summary);
      const observedProperty = observedPropertyForCall(summary, call, context);
      const hostFeedback = summary.sourceKind === "instance-property" && isStrongHostFeedbackProperty(observedProperty);
      const likelyContinuousProperty = summary.sourceKind === "instance-property"
        && Boolean(observedProperty && LIKELY_CONTINUOUS_PROPERTIES.has(observedProperty));
      const message = hostFeedback
        ? `${path} mirrors ${observedProperty} through React state even though every analyzed use is presentation-only, so the measurement rerenders this consumer without needing reconciliation.`
        : likelyContinuousProperty
          ? `${path} mirrors continuously mutable ${observedProperty} through React state, and ${localName} only feeds presentation updates that do not need reconciliation.`
        : `${path} returns state updated from a high-frequency source, and ${localName} only feeds presentation updates that do not need React reconciliation.`;
      const help = hasBindingMode
        ? `Use the hook's Binding-returning mode${summary.bindingModeParameterName ? ` by passing ${summary.bindingWhenTruthy ? "true" : "false"} for ${summary.bindingModeParameterName}` : ""}. Binding:map can keep pure visual derivations outside the render cycle.`
        : "Prefer a Binding-returning hook API so continuous presentation updates can reach host properties without rerendering the consumer.";
      diagnostics.push({
        node: callNameNode(call),
        message,
        help,
        fixPreview: hasBindingMode && allReadsDirectlyBindingSubstitutable(localName, owner, declaration, context, compatibleComponentProps)
          ? bindingModeFixPreview(summary, call, context)
          : undefined,
      });
    }

    for (const binding of context.model.stateBindings) {
      const owner = binding.owner;
      if (!owner || (!owner.isComponent && !owner.isHook)) continue;
      const update = bindingUpdateEvidence(binding, importedCallbacks, context);
      if (!update) continue;

      const localCompatible = stateReadsAreBindingCompatible(
        binding.valueName,
        owner,
        binding.declaration,
        context,
        compatibleComponentProps,
      );
      const hookCompatible = owner.isHook
        ? hookCallSitesAreBindingCompatible(binding, context, compatibleComponentProps)
        : false;
      const strongHostFeedback = hasStrongHostFeedbackEvidence(update);
      const likelyContinuousProperty = hasLikelyContinuousPropertyEvidence(update);
      const shouldWarn = owner.isHook
        ? hookCompatible && (update.highFrequency || likelyContinuousProperty)
        : localCompatible && (update.highFrequency || strongHostFeedback || likelyContinuousProperty);
      if (!shouldWarn) continue;

      const key = `${binding.call.startIndex}:${binding.call.endIndex}:${binding.valueName}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (owner.isHook && hookCompatible) {
        const properties = likelyContinuousProperty ? [...update.hostFeedbackProperties].sort().join(", ") : "";
        diagnostics.push({
          node: callNameNode(binding.call),
          message: likelyContinuousProperty && !update.highFrequency
            ? `Hook state ${binding.valueName} mirrors continuously mutable ${properties} and is only consumed by presentation properties at analyzed call sites.`
            : `Hook state ${binding.valueName} is updated from a high-frequency source and is only consumed by presentation properties at analyzed call sites.`,
          help: "Consider returning a Binding, or adding a Binding-returning variant of this hook, so continuous presentation updates do not rerender every consumer.",
        });
      } else if (strongHostFeedback && !update.highFrequency) {
        const properties = [...update.hostFeedbackProperties].sort().join(", ");
        diagnostics.push({
          node: callNameNode(binding.call),
          message: `State ${binding.valueName} mirrors ${properties} and only feeds presentation updates, so React reconciliation is acting as an unnecessary host-property feedback step.`,
          help: "Prefer React.useBinding for this host feedback path. Use Binding:map for pure visual derivations and keep React state only when a change needs to affect component structure or React effects.",
          fixPreview: allReadsDirectlyBindingSubstitutable(binding.valueName, owner, binding.declaration, context, compatibleComponentProps)
            ? useBindingFixPreview(binding.call)
            : undefined,
        });
      } else if (likelyContinuousProperty && !update.highFrequency) {
        const properties = [...update.hostFeedbackProperties].sort().join(", ");
        diagnostics.push({
          node: callNameNode(binding.call),
          message: `State ${binding.valueName} mirrors continuously mutable ${properties} and only feeds presentation updates that do not need React reconciliation.`,
          help: "Prefer React.useBinding so external visual property changes can reach presentation without routing every update through component state.",
          fixPreview: allReadsDirectlyBindingSubstitutable(binding.valueName, owner, binding.declaration, context, compatibleComponentProps)
            ? useBindingFixPreview(binding.call)
            : undefined,
        });
      } else {
        diagnostics.push({
          node: callNameNode(binding.call),
          message: `State ${binding.valueName} is updated from a high-frequency callback and only feeds presentation updates that do not need React reconciliation.`,
          help: "Prefer React.useBinding so continuous visual updates can reach host properties without rerendering the component.",
          fixPreview: allReadsDirectlyBindingSubstitutable(binding.valueName, owner, binding.declaration, context, compatibleComponentProps)
            ? useBindingFixPreview(binding.call)
            : undefined,
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
      if (!summary) continue;
      const declaration = declarationForCall(call);
      const localName = declaration ? declarationNames(declaration)[0] ?? null : null;
      const owner = context.containingComponent(call) ?? context.nearestFunction(call);
      if (!declaration || !localName || !owner) continue;
      if (importedHookRecommendation(summary, call, localName, owner, declaration, context, compatibleComponentProps) !== "candidate") continue;

      const usage = bindingUsageSummary(localName, owner, declaration, context, compatibleComponentProps);
      const presentationOnly = isPresentationOnly(usage);
      const observedProperty = observedPropertyForCall(summary, call, context);
      const strongHostFeedback = summary.sourceKind === "instance-property"
        && isStrongHostFeedbackProperty(observedProperty);
      const hasBindingMode = hasExplicitBindingMode(summary);
      const mirrorsExternalValue = summary.mirrorConfidence !== "none";
      const visualEffectBridge = strongHostFeedback && usage.effect > 0 && effectOnlyDerivesPresentation(
        localName,
        owner,
        declaration,
        context,
        compatibleComponentProps,
      );
      const key = `imported:${call.startIndex}:${call.endIndex}:${localName}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let message: string;
      let help: string;
      if (presentationOnly && hasBindingMode) {
        message = `${path} has a Binding-returning mode and ${localName} is only used for presentation, but Doctor cannot prove the updates are frequent enough to make the Binding version clearly preferable.`;
        help = "Consider the Binding mode when this value changes often enough that avoiding reconciliation matters; ordinary React state may be clearer for infrequent semantic updates.";
      } else if (presentationOnly && strongHostFeedback) {
        message = `${path} mirrors ${observedProperty} through React state only for presentation, but the hook does not expose a proven low-friction Binding mode.`;
        help = "Consider a Binding-returning variant if this host feedback path is performance-sensitive. Keep state when the simpler API is more valuable than avoiding occasional rerenders.";
      } else if (presentationOnly && mirrorsExternalValue) {
        message = `${path} mirrors an external reactive value through React state, and ${localName} is only used for presentation.`;
        help = "Consider a Binding-returning hook API if this source changes often enough that rerendering is unnecessary. Doctor cannot prove the source's update pressure, so ordinary state may still be the clearer choice.";
      } else if (visualEffectBridge) {
        message = `${path} mirrors ${observedProperty} through React state, and the dependent React effect only derives presentation state or Bindings from ${localName}.`;
        help = hasBindingMode
          ? "Consider the hook's Binding mode and move the visual derivation into Binding:map/joinBindings so the measurement does not need an intermediate React rerender."
          : "Consider a Binding-returning hook variant if this visual feedback path is performance-sensitive; the current effect appears to use React state only as an intermediate presentation step.";
      } else {
        message = `${path} updates ${localName} through React state and some consumers are presentation-only, but other consumers may still require React reconciliation.`;
        help = "Inspect whether the presentation branch can move to a Binding while structural or effect-driven consumers keep React state. Avoid replacing the value wholesale when React still needs to react to it.";
      }
      diagnostics.push({
        node: callNameNode(call),
        message,
        help,
        fixPreview: presentationOnly && hasBindingMode
          && allReadsDirectlyBindingSubstitutable(localName, owner, declaration, context, compatibleComponentProps)
          ? bindingModeFixPreview(summary, call, context)
          : undefined,
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

      const usage = bindingUsageSummary(localName, owner, declaration, context, compatibleComponentProps);
      const presentationOnly = isPresentationOnly(usage);
      // A sibling Binding API is not enough to justify suggesting a split for
      // ordinary semantic/store state. Without independent high-frequency
      // evidence, only surface this when every analyzed consumer can stay on
      // the presentation path.
      if (!presentationOnly) continue;
      const field = selectorFieldName(call, context);
      const key = `state-api:${call.startIndex}:${call.endIndex}:${localName}`;
      if (seen.has(key)) continue;
      seen.add(key);

      diagnostics.push({
        node: callNameNode(call),
        message: `${path} subscribes ${localName} through React state${field ? ` for ${field}` : ""}, while ${bindingAlternative} is also available and every analyzed consumer is presentation-only.`,
        help: `Consider ${bindingAlternative} when this value updates frequently enough that avoiding reconciliation matters; state remains reasonable for ordinary semantic store updates.`,
        fixPreview: allReadsDirectlyBindingSubstitutable(localName, owner, declaration, context, compatibleComponentProps)
          ? callMemberFixPreview(call, bindingAlternative)
          : undefined,
      });
    }

    for (const binding of context.model.stateBindings) {
      const owner = binding.owner;
      if (!owner || (!owner.isComponent && !owner.isHook) || !owner.body) continue;
      const update = bindingUpdateEvidence(binding, importedCallbacks, context);
      if (!update) continue;

      const localCompatible = stateReadsAreBindingCompatible(
        binding.valueName,
        owner,
        binding.declaration,
        context,
        compatibleComponentProps,
      );
      const hookCompatible = owner.isHook
        ? hookCallSitesAreBindingCompatible(binding, context, compatibleComponentProps)
        : false;
      const strongHostFeedback = hasStrongHostFeedbackEvidence(update);
      const likelyContinuousProperty = hasLikelyContinuousPropertyEvidence(update);
      const mirrorsExternalValue = update.mirrorConfidence !== "none";

      if (owner.isHook) {
        if (hookCompatible && (update.highFrequency || likelyContinuousProperty)) continue;
        if (!(hookCompatible && (strongHostFeedback || mirrorsExternalValue))) continue;

        const key = `hook-state:${binding.call.startIndex}:${binding.call.endIndex}:${binding.valueName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const measurement = strongHostFeedback
          ? "a presentation measurement"
          : "an external reactive value";
        diagnostics.push({
          node: callNameNode(binding.call),
          message: `Hook state ${binding.valueName} mirrors ${measurement} and is only consumed by presentation properties at analyzed call sites, but converting it requires changing the hook API.`,
          help: "Consider adding a Binding-returning variant when this reactive path updates often enough that avoiding reconciliation matters; keeping the state API is reasonable when ordinary React state is simpler.",
        });
        continue;
      }

      const usage = bindingUsageSummary(binding.valueName, owner, binding.declaration, context, compatibleComponentProps);
      if (!hasCandidatePresentationEvidence(usage)) continue;
      if (localCompatible && (update.highFrequency || strongHostFeedback || likelyContinuousProperty)) continue;

      if (localCompatible && mirrorsExternalValue) {
        const key = `state:${binding.call.startIndex}:${binding.call.endIndex}:${binding.valueName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        diagnostics.push({
          node: callNameNode(binding.call),
          message: `State ${binding.valueName} mirrors an external reactive value and only feeds presentation updates, but Doctor cannot prove the source changes frequently enough for Binding to be clearly preferable.`,
          help: "Consider React.useBinding when this source is a stream of presentation values rather than semantic React state. Keep useState when the external event represents an infrequent UI state transition.",
        });
        continue;
      }

      const mixedHighFrequency = update.highFrequency || likelyContinuousProperty;
      const mixedHostFeedback = strongHostFeedback && usage.structural > 0 && usage.effect === 0;
      if (!mixedHighFrequency && !mixedHostFeedback) continue;

      const key = `state:${binding.call.startIndex}:${binding.call.endIndex}:${binding.valueName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.push({
        node: callNameNode(binding.call),
        message: `State ${binding.valueName} has presentation-oriented consumers, but other uses still appear to need React reconciliation.`,
        help: "Inspect whether the presentation branch can move to React.useBinding while structural consumers keep a smaller semantic state value. Splitting the responsibilities can remove hot-path rerenders without forcing Binding semantics onto the whole value.",
      });
    }

    return diagnostics;
  },
};
