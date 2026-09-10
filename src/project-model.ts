import fs from "node:fs";
import path from "node:path";
import {
  buildUniqueFeatureAliases,
  moduleKeys,
  normalizeRequireTarget,
  resolveModuleReference,
  type ModuleIdentity,
} from "./module-resolution";
import { sourceHasHighFrequencyRobloxEvent } from "./roblox-semantics";
import type {
  BindingCandidateHookSummary,
  ConditionalHookModeSummary,
  ExternalCallbackFunctionSummary,
  ProjectModel,
  ScanFileInput,
} from "./types";

const EXTERNAL_UPDATE_SOURCE =
  /(?::|\.)(?:Connect|Once|Subscribe|Observe|Listen|Watch|onStep|onUpdate|onChange|onChanged)\s*\(|\b(?:subscribe|observe|listen|watch|onStep|onUpdate|onChange|onChanged)[A-Za-z0-9_]*\s*\(|GetPropertyChangedSignal\s*\(|GetAttributeChangedSignal\s*\(|\.Changed\b/i;
const SEMANTIC_SNAPSHOT_EXPRESSION =
  /\b(?:getState|getSnapshot|snapshot|selector|select|table\s*\.\s*(?:clone|freeze|move))\b|(?:\.|\[\s*["'])State(?:\b|["']\s*\])/i;
const PURE_MIRROR_EXPRESSION_ROOTS = new Set([
  "math", "string", "utf8", "bit32", "UDim", "UDim2", "Vector2", "Vector3",
  "Color3", "CFrame", "Rect", "NumberRange", "NumberSequence", "ColorSequence",
  "BrickColor", "Font", "Enum", "tostring", "tonumber", "type", "typeof",
  "true", "false", "nil",
]);
const CALLBACK_PARAMETER_NAME =
  /^(?:callback|handler|listener|subscriber|observer|effect|fn)$/i;

interface SourceRecord extends ModuleIdentity {
  source: string;
}

export interface ProjectModelModuleAnalysis {
  record: SourceRecord;
  memoized?: "shallow" | "custom";
  bindingHook?: BindingCandidateHookSummary;
  callbackFunction?: ExternalCallbackFunctionSummary;
  bindingCompatibleProps?: Set<string>;
  staticIterationTables?: Set<string>;
  conditionalHookMode?: ConditionalHookModeSummary;
  declaredMethods: Map<string, Set<string>>;
}

export interface ProjectModelModuleCacheEntry {
  hash: string;
  analysis: ProjectModelModuleAnalysis;
}

export interface ProjectModelBuildOptions {
  fileHashes?: Readonly<Record<string, string>>;
  moduleCache?: Map<string, ProjectModelModuleCacheEntry>;
}

function exportedFunctionName(source: string): string | null {
  return source.match(/\breturn\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/)?.[1] ?? null;
}

function findFunctionParameters(
  source: string,
  functionName: string,
): string | null {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `\\b(?:local\\s+)?function\\s+${escaped}(?:<[^>]*>)?\\s*\\(`,
      "s",
    ),
    new RegExp(`\\b${escaped}\\s*=\\s*function(?:<[^>]*>)?\\s*\\(`, "s"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (!match) continue;
    const open = match.index + match[0].lastIndexOf("(");
    return extractCallArguments(source, open);
  }
  return null;
}

function splitTopLevelParameters(parameters: string): string[] {
  const result: string[] = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  let angle = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < parameters.length; index += 1) {
    const char = parameters[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") round += 1;
    else if (char === ")") round = Math.max(0, round - 1);
    else if (char === "[") square += 1;
    else if (char === "]") square = Math.max(0, square - 1);
    else if (char === "{") curly += 1;
    else if (char === "}") curly = Math.max(0, curly - 1);
    else if (char === "<") angle += 1;
    else if (char === ">") angle = Math.max(0, angle - 1);
    else if (
      char === "," &&
      round === 0 &&
      square === 0 &&
      curly === 0 &&
      angle === 0
    ) {
      result.push(parameters.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(parameters.slice(start).trim());
  return result.filter(Boolean);
}

interface DualModeBindingStatePair {
  valueName: string;
  setterName: string;
  bindingModeParameterIndex: number;
  bindingModeParameterName: string;
  bindingWhenTruthy: boolean;
}

function findDualModeBindingStatePair(
  source: string,
  functionName: string,
): DualModeBindingStatePair | null {
  const parametersText = findFunctionParameters(source, functionName);
  if (parametersText === null) return null;
  const parameterNames = splitTopLevelParameters(parametersText).map(
    (parameter) => parameter.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? null,
  );

  const declarations = [
    ...source.matchAll(
      /^[ \t]*local[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*,[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?:--[^\n]*)?$/gm,
    ),
  ];
  for (const declaration of declarations) {
    const valueName = declaration[1];
    const setterName = declaration[2];
    const escapedValue = valueName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedSetter = setterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bindingAssignment = `${escapedValue}\\s*,\\s*${escapedSetter}\\s*=\\s*(?:React\\.)?useBinding\\s*\\(`;
    const stateAssignment = `${escapedValue}\\s*,\\s*${escapedSetter}\\s*=\\s*(?:React\\.)?useState\\s*\\(`;

    for (const [parameterIndex, parameterName] of parameterNames.entries()) {
      if (!parameterName) continue;
      const escapedParameter = parameterName.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      const patterns = [
        {
          regex: new RegExp(
            `\\bif\\s+${escapedParameter}\\s+then[\\s\\S]*?${bindingAssignment}[\\s\\S]*?\\belse\\b[\\s\\S]*?${stateAssignment}`,
          ),
          bindingWhenTruthy: true,
        },
        {
          regex: new RegExp(
            `\\bif\\s+${escapedParameter}\\s+then[\\s\\S]*?${stateAssignment}[\\s\\S]*?\\belse\\b[\\s\\S]*?${bindingAssignment}`,
          ),
          bindingWhenTruthy: false,
        },
        {
          regex: new RegExp(
            `\\bif\\s+not\\s+${escapedParameter}\\s+then[\\s\\S]*?${stateAssignment}[\\s\\S]*?\\belse\\b[\\s\\S]*?${bindingAssignment}`,
          ),
          bindingWhenTruthy: true,
        },
        {
          regex: new RegExp(
            `\\bif\\s+not\\s+${escapedParameter}\\s+then[\\s\\S]*?${bindingAssignment}[\\s\\S]*?\\belse\\b[\\s\\S]*?${stateAssignment}`,
          ),
          bindingWhenTruthy: false,
        },
      ];
      const match = patterns.find((pattern) => pattern.regex.test(source));
      if (!match) continue;
      return {
        valueName,
        setterName,
        bindingModeParameterIndex: parameterIndex,
        bindingModeParameterName: parameterName,
        bindingWhenTruthy: match.bindingWhenTruthy,
      };
    }
  }

  return null;
}

function exportedFunctionParameters(
  source: string,
): { name?: string; parameters: string[] } | null {
  const name = exportedFunctionName(source);
  if (name) {
    const parameters = findFunctionParameters(source, name);
    if (parameters === null) return null;
    return { name, parameters: splitTopLevelParameters(parameters) };
  }

  const match = /^\s*return\s+function(?:<[^>]*>)?\s*\(/m.exec(source);
  if (!match || match.index === undefined) return null;
  const open = match.index + match[0].lastIndexOf("(");
  const parameters = extractCallArguments(source, open);
  if (parameters === null) return null;
  return { parameters: splitTopLevelParameters(parameters) };
}

function parameterName(parameter: string): string | null {
  return parameter.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? null;
}

function branchContainsHookCall(text: string): boolean {
  return /\b(?:[A-Za-z_][A-Za-z0-9_]*[.:])?use[A-Z0-9_][A-Za-z0-9_]*\s*\(/.test(
    text,
  );
}

const BUILT_IN_REACT_HOOK_NAMES = new Set([
  "useState",
  "useEffect",
  "useLayoutEffect",
  "useMemo",
  "useCallback",
  "useContext",
  "useReducer",
  "useRef",
  "useImperativeHandle",
  "useBinding",
]);

function simpleBranchHookPaths(text: string): string[] | null {
  // Do not use this textual shortcut when nested control flow could make the
  // first `end` belong to an inner block. The AST rule still handles those
  // implementations conservatively.
  if (/\b(?:if|for|while|repeat|function)\b/.test(text)) return null;
  return [...text.matchAll(/\b(React\.(use[A-Z0-9_][A-Za-z0-9_]*))\s*\(/g)]
    .map((match) => match[2]);
}

function simpleIfHasEquivalentBuiltInTopology(
  source: string,
  ifStart: number | undefined,
): boolean {
  if (ifStart === undefined) return false;
  const statement = source.slice(ifStart).match(
    /^if\b[\s\S]*?\bthen\b([\s\S]*?)\belse\b([\s\S]*?)\bend\b/,
  );
  if (!statement) return false;
  const left = simpleBranchHookPaths(statement[1] ?? "");
  const right = simpleBranchHookPaths(statement[2] ?? "");
  if (!left || !right || left.length === 0 || left.length !== right.length)
    return false;
  return left.every(
    (name, index) => name === right[index] && BUILT_IN_REACT_HOOK_NAMES.has(name),
  );
}

function conditionAliasesForParameter(
  source: string,
  parameter: string,
): Map<string, string> {
  const aliases = new Map<string, string>([[parameter, ""]]);
  const escaped = parameter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // A mode is often carried in an options table in React-Luau hooks, e.g.
  // `if options.binding then`. Track the property path so callers can be
  // checked against the value of that field rather than the whole table.
  for (const match of source.matchAll(
    new RegExp(`\\b${escaped}((?:\\.[A-Za-z_][A-Za-z0-9_]*)+)`, "g"),
  )) {
    aliases.set(`${parameter}${match[1]}`, match[1].slice(1));
  }

  const directPatterns = [
    new RegExp(
      `^\\s*local\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(${escaped}(?:\\.[A-Za-z_][A-Za-z0-9_]*)*)\\s*$`,
      "gm",
    ),
    new RegExp(
      `^\\s*local\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*not\\s+(${escaped}(?:\\.[A-Za-z_][A-Za-z0-9_]*)*)\\s*$`,
      "gm",
    ),
    new RegExp(
      `^\\s*local\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(${escaped}(?:\\.[A-Za-z_][A-Za-z0-9_]*)*)\\s*(?:==|~=)\\s*(?:true|false|nil)\\s*$`,
      "gm",
    ),
    new RegExp(
      `^\\s*local\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(?:true|false|nil)\\s*(?:==|~=)\\s*(${escaped}(?:\\.[A-Za-z_][A-Za-z0-9_]*)*)\\s*$`,
      "gm",
    ),
  ];

  for (const pattern of directPatterns) {
    for (const match of source.matchAll(pattern)) {
      const sourcePath = match[2];
      const accessPath = sourcePath === parameter
        ? ""
        : sourcePath.slice(parameter.length + 1);
      aliases.set(match[1], accessPath);
    }
  }

  // Preserve the normalized boolean aliases that the old detector understood.
  for (const match of source.matchAll(
    new RegExp(
      `^\\s*local\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*if\\s+(${escaped}(?:\\.[A-Za-z_][A-Za-z0-9_]*)*)\\s*(?:==|~=)\\s*nil\\s+then\\s+(?:true|false)\\s+else\\s+\\2\\s*$`,
      "gm",
    ),
  )) {
    const sourcePath = match[2];
    aliases.set(
      match[1],
      sourcePath === parameter ? "" : sourcePath.slice(parameter.length + 1),
    );
  }
  for (const match of source.matchAll(
    new RegExp(
      `^\\s*local\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*if\\s+(${escaped}(?:\\.[A-Za-z_][A-Za-z0-9_]*)*)\\s+then\\s+(?:true|false)\\s+else\\s+(?:true|false)\\s*$`,
      "gm",
    ),
  )) {
    const sourcePath = match[2];
    aliases.set(
      match[1],
      sourcePath === parameter ? "" : sourcePath.slice(parameter.length + 1),
    );
  }

  return aliases;
}

function findConditionalHookMode(
  source: string,
): ConditionalHookModeSummary | null {
  const exported = exportedFunctionParameters(source);
  if (!exported) return null;
  if (exported.name && !/^use[A-Z0-9_]/.test(exported.name)) return null;

  const parameterNames = exported.parameters.map(parameterName);
  const controlledIndexes: number[] = [];
  const controlledNames: string[] = [];
  const conditionVariables: Record<string, number> = {};
  const conditionAccessPaths: Record<string, string> = {};

  for (const [index, name] of parameterNames.entries()) {
    if (!name) continue;
    const aliases = conditionAliasesForParameter(source, name);
    let controlsHook = false;

    for (const [alias, accessPath] of aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const patterns = [
        new RegExp(
          `\\bif\\s+${escaped}\\s+then([\\s\\S]*?)(?=\\belse\\b|\\bend\\b)`,
          "g",
        ),
        new RegExp(
          `\\bif\\s+not\\s+${escaped}\\s+then([\\s\\S]*?)(?=\\belse\\b|\\bend\\b)`,
          "g",
        ),
        new RegExp(
          `\\bif\\s+${escaped}\\s*(?:==|~=)\\s*(?:true|false|nil)\\s+then([\\s\\S]*?)(?=\\belse\\b|\\bend\\b)`,
          "g",
        ),
        new RegExp(
          `\\bif\\s+(?:true|false|nil)\\s*(?:==|~=)\\s*${escaped}\\s+then([\\s\\S]*?)(?=\\belse\\b|\\bend\\b)`,
          "g",
        ),
      ];

      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
          if (!branchContainsHookCall(match[1] ?? "")) continue;
          if (simpleIfHasEquivalentBuiltInTopology(source, match.index)) continue;
          controlsHook = true;
          conditionVariables[alias] = index;
          conditionAccessPaths[alias] = accessPath;
          break;
        }
        if (controlsHook) break;
      }
    }

    if (!controlsHook) continue;
    controlledIndexes.push(index);
    controlledNames.push(name);
  }

  if (controlledIndexes.length === 0) return null;
  return {
    name: exported.name,
    parameterIndexes: controlledIndexes,
    parameterNames: controlledNames,
    conditionVariables,
    conditionAccessPaths,
    knownCallSites: 0,
    dynamicCallSites: 0,
  };
}

function maskLuauNonCode(source: string): string {
  let result = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1] ?? "";

    if (char === "-" && next === "-") {
      if (source[index + 2] === "[" && source[index + 3] === "[") {
        const end = source.indexOf("]]", index + 4);
        const stop = end >= 0 ? end + 2 : source.length;
        const chunk = source.slice(index, stop);
        result += chunk.replace(/[^\n]/g, " ");
        index = stop;
        continue;
      }
      const end = source.indexOf("\n", index + 2);
      const stop = end >= 0 ? end : source.length;
      result += " ".repeat(stop - index);
      index = stop;
      continue;
    }

    if (char === '"' || char === "'") {
      const quote = char;
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        if (source[end] === quote) {
          end += 1;
          break;
        }
        end += 1;
      }
      result += source.slice(index, end).replace(/[^\n]/g, " ");
      index = end;
      continue;
    }

    if (char === "[" && next === "[") {
      const end = source.indexOf("]]", index + 2);
      const stop = end >= 0 ? end + 2 : source.length;
      result += source.slice(index, stop).replace(/[^\n]/g, " ");
      index = stop;
      continue;
    }

    result += char;
    index += 1;
  }
  return result;
}

function stableLiteralConstants(source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of source.matchAll(
    /^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(true|false|nil)\s*$/gm,
  )) {
    const name = match[1];
    const assignments = [
      ...source.matchAll(
        new RegExp(
          `\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*=`,
          "g",
        ),
      ),
    ];
    if (assignments.length === 1) result.set(name, match[2]);
  }
  return result;
}

function isStableHookModeArgument(
  text: string | undefined,
  constants: Map<string, string>,
): boolean {
  if (text === undefined) return true;
  let value = text.trim();
  while (value.startsWith("(") && value.endsWith(")"))
    value = value.slice(1, -1).trim();
  if (/^(?:true|false|nil)$/.test(value)) return true;
  return constants.has(value);
}

function collectConditionalHookModeCallSites(
  records: SourceRecord[],
  aliases: Map<string, ConditionalHookModeSummary>,
): void {
  for (const record of records) {
    const imports = new Map<string, ConditionalHookModeSummary>();
    for (const match of record.source.matchAll(
      /\blocal\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\s*\((.*?)\)/gs,
    )) {
      const summary = resolveModuleReference(
        normalizeRequireTarget(match[2]),
        aliases,
      );
      if (summary) imports.set(match[1], summary);
    }
    if (imports.size === 0) continue;

    const masked = maskLuauNonCode(record.source);
    const constants = stableLiteralConstants(masked);
    for (const [localName, summary] of imports) {
      const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const callPattern = new RegExp(`\\b${escaped}\\s*\\(`, "g");
      for (const match of masked.matchAll(callPattern)) {
        if (match.index === undefined) continue;
        const open = masked.indexOf("(", match.index);
        const argumentsText = extractCallArguments(record.source, open);
        if (argumentsText === null) continue;
        const args = splitTopLevelParameters(argumentsText);
        summary.knownCallSites += 1;
        if (
          summary.parameterIndexes.some(
            (index) => !isStableHookModeArgument(args[index], constants),
          )
        ) {
          summary.dynamicCallSites += 1;
        }
      }
    }
  }
}

function findExternalCallbackFunction(
  source: string,
): ExternalCallbackFunctionSummary | null {
  const name = exportedFunctionName(source);
  if (!name || !EXTERNAL_UPDATE_SOURCE.test(source)) return null;
  const parameters = findFunctionParameters(source, name);
  if (parameters === null) return null;

  const callbackParameterIndexes: number[] = [];
  for (const [index, parameter] of splitTopLevelParameters(
    parameters,
  ).entries()) {
    const parameterName = parameter.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
    if (!parameterName) continue;
    const functionTyped = /->/.test(parameter);
    const semanticallyNamed = CALLBACK_PARAMETER_NAME.test(parameterName);
    const used = new RegExp(
      `\\b${parameterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    ).test(source);
    if (used && (functionTyped || semanticallyNamed))
      callbackParameterIndexes.push(index);
  }

  if (callbackParameterIndexes.length === 0) return null;
  return {
    name,
    callbackParameterIndexes,
    highFrequency: sourceHasHighFrequencyRobloxEvent(source) || sourceHasLikelyContinuousSubscription(source),
  };
}

function sourceHasLikelyContinuousSubscription(source: string): boolean {
  return /(?::|\.)onStep\s*\(/i.test(source);
}

function expressionReferencesName(expression: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(expression);
}

function isLiteralStateTransitionExpression(expression: string): boolean {
  const text = expression.trim();
  return /^(?:true|false|nil|[-+]?\d+(?:\.\d+)?|["'][^"']*["'])$/.test(text);
}

function expressionHasLikelyExternalInput(expression: string): boolean {
  const withoutMembers = expression.replace(/\.\s*[A-Za-z_][A-Za-z0-9_]*/g, "");
  for (const match of withoutMembers.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    if (!PURE_MIRROR_EXPRESSION_ROOTS.has(match[0])) return true;
  }
  return false;
}

function subscriptionMirrorConfidence(
  source: string,
  setterName: string,
): "strong" | "possible" | "none" {
  const escapedSetter = setterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Passing the React setter directly to a persistent subscription is the
  // clearest possible "external value -> React state" mirror shape.
  const directSetter = new RegExp(
    `(?::|\\.)(Connect|Subscribe|Observe|Listen|Watch|onStep|onUpdate|onChange|onChanged)\\s*\\(\\s*${escapedSetter}\\b`,
    "i",
  );
  if (directSetter.test(source)) return "strong";

  const callbackPattern = new RegExp(
    `(?::|\\.)(Connect|Subscribe|Observe|Listen|Watch|onStep|onUpdate|onChange|onChanged)\\s*\\(\\s*function\\s*\\(([^)]*)\\)[\\s\\S]{0,2400}?\\b${escapedSetter}\\s*\\(`,
    "gi",
  );

  let possible = false;
  for (const match of source.matchAll(callbackPattern)) {
    if (match.index === undefined) continue;
    const callbackParameters = splitTopLevelParameters(match[2] ?? "")
      .map(parameterName)
      .filter((name): name is string => Boolean(name));
    const setterOffset = match[0].lastIndexOf(setterName);
    if (setterOffset < 0) continue;
    const setterStart = match.index + setterOffset;
    const open = source.indexOf("(", setterStart + setterName.length);
    const argumentsText = extractCallArguments(source, open);
    if (argumentsText === null) continue;
    const setterArgs = splitTopLevelParameters(argumentsText);
    const expression = setterArgs[0]?.trim() ?? "";
    if (!expression || /^function\b/.test(expression) || isLiteralStateTransitionExpression(expression)) continue;
    if (SEMANTIC_SNAPSHOT_EXPRESSION.test(expression)) continue;

    if (callbackParameters.some((name) => expressionReferencesName(expression, name))) {
      return "strong";
    }
    if (!expressionHasLikelyExternalInput(expression)) continue;
    possible = true;
  }

  return possible ? "possible" : "none";
}

function findBindingCandidateHook(
  source: string,
): BindingCandidateHookSummary | null {
  const exported = source.match(
    /\breturn\s+(use[A-Z0-9_][A-Za-z0-9_]*)\s*$/,
  )?.[1];
  if (!exported) return null;

  const stateMatches = [
    ...source.matchAll(
      /\blocal\s+([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:React\.)?useState\s*\(/g,
    ),
  ];
  const directState =
    stateMatches.length === 1
      ? { valueName: stateMatches[0][1], setterName: stateMatches[0][2] }
      : null;
  const dualMode = directState
    ? null
    : findDualModeBindingStatePair(source, exported);
  if (!directState && !dualMode) return null;

  const valueName = directState?.valueName ?? dualMode!.valueName;
  const setterName = directState?.setterName ?? dualMode!.setterName;
  const escapedValue = valueName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedSetter = setterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  if (!new RegExp(`\\breturn\\s+${escapedValue}\\b`).test(source)) return null;
  const setterCalled = new RegExp(`\\b${escapedSetter}\\s*\\(`).test(source);
  const setterPassedToSubscription = new RegExp(
    `(?::|\\.)(?:Connect|Once|Subscribe|Observe|Listen|Watch)\\s*\\(\\s*${escapedSetter}\\b`,
    "i",
  ).test(source);
  if (!setterCalled && !setterPassedToSubscription) return null;

  const highFrequency = sourceHasHighFrequencyRobloxEvent(source) || sourceHasLikelyContinuousSubscription(source);
  const external = highFrequency || EXTERNAL_UPDATE_SOURCE.test(source);
  if (!external) return null;

  const literalPropertySignal = source.match(
    /GetPropertyChangedSignal\s*\(\s*["']([^"']+)["']\s*\)/,
  );
  const dynamicPropertySignal = literalPropertySignal
    ? null
    : source.match(
        /GetPropertyChangedSignal\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/,
      );
  const literalPropertyName = literalPropertySignal?.[1] ?? null;
  const dynamicPropertyName = dynamicPropertySignal?.[1] ?? null;
  const readsObservedProperty = literalPropertyName
    ? new RegExp(
        `(?:\\.\\s*${literalPropertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b|\\[\\s*["']${literalPropertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']\\s*\\])`,
      ).test(source)
    : Boolean(
        dynamicPropertyName &&
          new RegExp(
            `\\[\\s*${dynamicPropertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\]`,
          ).test(source),
      );
  const instanceProperty = Boolean((literalPropertyName || dynamicPropertyName) && readsObservedProperty);
  const mirrorConfidence = instanceProperty
    ? "strong"
    : subscriptionMirrorConfidence(source, setterName);

  let observedPropertyParameterIndex: number | undefined;
  if (instanceProperty && dynamicPropertyName) {
    const parameters = findFunctionParameters(source, exported);
    if (parameters !== null) {
      const parameterNames = splitTopLevelParameters(parameters).map(
        (parameter) => parameter.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? "",
      );
      const index = parameterNames.indexOf(dynamicPropertyName);
      if (index >= 0) observedPropertyParameterIndex = index;
    }
  }

  return {
    name: exported,
    highFrequency,
    external,
    sourceKind: instanceProperty ? "instance-property" : "external-state",
    mirrorConfidence,
    ...(instanceProperty && literalPropertyName
      ? { observedPropertyName: literalPropertyName }
      : {}),
    ...(observedPropertyParameterIndex !== undefined
      ? { observedPropertyParameterIndex }
      : {}),
    ...(dualMode
      ? {
          bindingModeParameterIndex: dualMode.bindingModeParameterIndex,
          bindingModeParameterName: dualMode.bindingModeParameterName,
          bindingWhenTruthy: dualMode.bindingWhenTruthy,
        }
      : {}),
  };
}

function findDerivedBindingCandidateHook(
  source: string,
  bindingCandidateHooks: Map<string, BindingCandidateHookSummary>,
): BindingCandidateHookSummary | null {
  const exported = source.match(
    /\breturn\s+(use[A-Z0-9_][A-Za-z0-9_]*)\s*$/,
  )?.[1];
  if (!exported) return null;

  const stateMatches = [
    ...source.matchAll(
      /\blocal\s+([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:React\.)?useState\s*\(/g,
    ),
  ];
  if (stateMatches.length !== 1) return null;
  const valueName = stateMatches[0][1];
  const setterName = stateMatches[0][2];
  const escapedValue = valueName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedSetter = setterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`\\breturn\\s+${escapedValue}\\b`).test(source)) return null;
  if (!new RegExp(`\\b${escapedSetter}\\s*\\(`).test(source)) return null;

  const requirePattern =
    /\blocal\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\s*\((.*?)\)/gs;
  for (const match of source.matchAll(requirePattern)) {
    const localName = match[1];
    const summary = resolveModuleReference(
      normalizeRequireTarget(match[2]),
      bindingCandidateHooks,
    );
    if (!summary) continue;
    const escapedLocal = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`\\b${escapedLocal}\\s*\\(`).test(source)) continue;
    return {
      name: exported,
      highFrequency: summary.highFrequency,
      external: true,
      sourceKind: "derived-external-state",
      mirrorConfidence: summary.mirrorConfidence,
    };
  }

  return null;
}

function extractCallArguments(source: string, open: number): string | null {
  if (open < 0 || source[open] !== "(") return null;

  let depth = 0;
  let quote: string | null = null;
  let longStringDepth = 0;
  let escaped = false;

  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1] ?? "";

    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    if (longStringDepth > 0) {
      if (char === "]" && next === "]") {
        longStringDepth -= 1;
        index += 1;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "[" && next === "[") {
      longStringDepth += 1;
      index += 1;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }

  return null;
}

function findMemoCall(source: string): string | null {
  const direct = /\breturn\s+(?:React\.)?memo\s*\(/g.exec(source);
  if (direct)
    return extractCallArguments(source, source.indexOf("(", direct.index));

  const assigned =
    /\blocal\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:React\.)?memo\s*\(/g;
  for (
    let match = assigned.exec(source);
    match;
    match = assigned.exec(source)
  ) {
    const name = match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`\\breturn\\s+${name}\\b`).test(source.slice(match.index)))
      continue;
    return extractCallArguments(source, source.indexOf("(", match.index));
  }

  return null;
}

function hasTopLevelComma(argumentsText: string): boolean {
  let round = 0;
  let square = 0;
  let curly = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < argumentsText.length; index += 1) {
    const char = argumentsText[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") round += 1;
    else if (char === ")") round -= 1;
    else if (char === "[") square += 1;
    else if (char === "]") square -= 1;
    else if (char === "{") curly += 1;
    else if (char === "}") curly -= 1;
    else if (char === "," && round === 0 && square === 0 && curly === 0)
      return true;
  }
  return false;
}

function bindingNameAlternative(name: string): string | null {
  if (!/state/i.test(name)) return null;
  return name.replace(/state/gi, (match) => {
    if (match === match.toUpperCase()) return "BINDING";
    if (match[0] === match[0].toUpperCase()) return "Binding";
    return "binding";
  });
}

function findDeclaredMethods(source: string): Map<string, Set<string>> {
  const methods = new Map<string, Set<string>>();
  const patterns = [
    /\bfunction\s+([A-Za-z_][A-Za-z0-9_.]*)\s*[:.]\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/g,
    /\b([A-Za-z_][A-Za-z0-9_.]*)\s*[:.]\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*function\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const owner = match[1].toLowerCase();
      const names = methods.get(owner) ?? new Set<string>();
      names.add(match[2]);
      methods.set(owner, names);
    }
  }
  return methods;
}

function findBindingApiAlternativesFromMethodMaps(
  methodMaps: Iterable<Map<string, Set<string>>>,
): Map<string, string> {
  const pairedAlternatives = new Map<string, Set<string>>();
  const unpairedStateNames = new Set<string>();

  for (const methods of methodMaps) {
    for (const names of methods.values()) {
      const byLower = new Map(
        [...names].map((name) => [name.toLowerCase(), name]),
      );
      for (const stateName of names) {
        const expected = bindingNameAlternative(stateName);
        if (!expected) continue;
        const bindingName = byLower.get(expected.toLowerCase());
        if (!bindingName) {
          unpairedStateNames.add(stateName.toLowerCase());
          continue;
        }
        const alternatives =
          pairedAlternatives.get(stateName) ?? new Set<string>();
        alternatives.add(bindingName);
        pairedAlternatives.set(stateName, alternatives);
      }
    }
  }

  const result = new Map<string, string>();
  for (const [stateName, alternatives] of pairedAlternatives) {
    if (
      alternatives.size === 1 &&
      !unpairedStateNames.has(stateName.toLowerCase())
    ) {
      result.set(stateName, [...alternatives][0]);
    }
  }
  return result;
}

const NON_BINDABLE_HOST_FIELDS = new Set(["ref", "key", "children"]);

interface SourceRange {
  start: number;
  end: number;
}

function matchingDelimiter(
  source: string,
  open: number,
  openChar: string,
  closeChar: string,
): number | null {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let longString = false;

  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1] ?? "";

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (longString) {
      if (char === "]" && next === "]") {
        longString = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === "-" && next === "-") {
      if (source[index + 2] === "[" && source[index + 3] === "[") {
        longString = true;
        index += 3;
      } else {
        lineComment = true;
        index += 1;
      }
      continue;
    }
    if (char === "[" && next === "[") {
      longString = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return null;
}

function topLevelFieldRanges(
  source: string,
  open: number,
  close: number,
): Array<{ name: string; value: SourceRange }> {
  const fields: Array<{ name: string; value: SourceRange }> = [];
  let start = open + 1;
  let round = 0;
  let square = 0;
  let curly = 0;
  let quote: string | null = null;
  let escaped = false;

  const addField = (segmentStart: number, segmentEnd: number) => {
    const segment = source.slice(segmentStart, segmentEnd);
    let equals = -1;
    let r = 0;
    let sq = 0;
    let cu = 0;
    let q: string | null = null;
    let esc = false;
    for (let i = 0; i < segment.length; i += 1) {
      const char = segment[i];
      if (q) {
        if (esc) esc = false;
        else if (char === "\\") esc = true;
        else if (char === q) q = null;
        continue;
      }
      if (char === '"' || char === "'") {
        q = char;
        continue;
      }
      if (char === "(") r += 1;
      else if (char === ")") r = Math.max(0, r - 1);
      else if (char === "[") sq += 1;
      else if (char === "]") sq = Math.max(0, sq - 1);
      else if (char === "{") cu += 1;
      else if (char === "}") cu = Math.max(0, cu - 1);
      else if (char === "=" && r === 0 && sq === 0 && cu === 0) {
        equals = i;
        break;
      }
    }
    if (equals < 0) return;
    const key = segment.slice(0, equals).trim();
    const name =
      key.match(/^([A-Za-z_][A-Za-z0-9_]*)$/)?.[1] ??
      key.match(/^\[\s*["']([^"']+)["']\s*\]$/)?.[1] ??
      null;
    if (!name || NON_BINDABLE_HOST_FIELDS.has(name)) return;
    let valueStart = segmentStart + equals + 1;
    while (valueStart < segmentEnd && /\s/.test(source[valueStart]))
      valueStart += 1;
    fields.push({ name, value: { start: valueStart, end: segmentEnd } });
  };

  for (let index = open + 1; index < close; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") round += 1;
    else if (char === ")") round = Math.max(0, round - 1);
    else if (char === "[") square += 1;
    else if (char === "]") square = Math.max(0, square - 1);
    else if (char === "{") curly += 1;
    else if (char === "}") curly = Math.max(0, curly - 1);
    else if (char === "," && round === 0 && square === 0 && curly === 0) {
      addField(start, index);
      start = index + 1;
    }
  }
  addField(start, close);
  return fields;
}

function hostPropValueRanges(source: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  const hostCall =
    /\b(?:React\.)?createElement\s*\(\s*(?:"[^"]+"|'[^']+')\s*,\s*\{/g;
  for (const match of source.matchAll(hostCall)) {
    const open = match.index + match[0].lastIndexOf("{");
    const close = matchingDelimiter(source, open, "{", "}");
    if (close === null) continue;
    for (const field of topLevelFieldRanges(source, open, close))
      ranges.push(field.value);
  }
  return ranges;
}

function exportedComponentImplementationName(source: string): string | null {
  const directMemo = source.match(
    /\breturn\s+(?:React\.)?memo\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*$/,
  )?.[1];
  if (directMemo) return directMemo;

  const exported = exportedFunctionName(source);
  if (!exported) return null;
  if (findFunctionParameters(source, exported) !== null) return exported;

  const escaped = exported.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    source.match(
      new RegExp(
        `\\blocal\\s+${escaped}\\s*=\\s*(?:React\\.)?memo\\s*\\(\\s*([A-Za-z_][A-Za-z0-9_]*)`,
      ),
    )?.[1] ?? null
  );
}

function findBindingCompatibleComponentProps(
  source: string,
): Set<string> | null {
  const exported = exportedComponentImplementationName(source);
  if (!exported) return null;
  const parametersText = findFunctionParameters(source, exported);
  if (parametersText === null) return null;
  const firstParameter = splitTopLevelParameters(parametersText)[0] ?? "";
  const propsName = firstParameter.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
  if (!propsName) return null;

  const ranges = hostPropValueRanges(source);
  if (ranges.length === 0) return null;
  const escapedProps = propsName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const readPattern = new RegExp(
    `\\b${escapedProps}\\.([A-Za-z_][A-Za-z0-9_]*)\\b|\\b${escapedProps}\\[\\s*["']([^"']+)["']\\s*\\]`,
    "g",
  );
  const reads = new Map<string, number[]>();
  for (const match of source.matchAll(readPattern)) {
    const property = match[1] ?? match[2];
    if (!property || match.index === undefined) continue;
    const offsets = reads.get(property) ?? [];
    offsets.push(match.index);
    reads.set(property, offsets);
  }

  const compatible = new Set<string>();
  for (const [property, offsets] of reads) {
    if (
      offsets.length > 0 &&
      offsets.every((offset) =>
        ranges.some((range) => {
          if (offset < range.start || offset >= range.end) return false;
          // A prop read captured inside a callback nested in a host-property
          // expression is not directly Binding-compatible. Turning the prop
          // itself into a Binding would require restructuring that callback
          // (usually with map/joinBindings), so keep the cross-component proof
          // conservative instead of treating textual containment as enough.
          return !/\bfunction\b/.test(source.slice(range.start, offset));
        }),
      )
    ) {
      compatible.add(property);
    }
  }
  return compatible.size > 0 ? compatible : null;
}

function findStaticIterationTables(source: string): Set<string> | null {
  const match = /^return\s*\{/m.exec(source);
  if (!match || match.index === undefined) return null;
  const open = match.index + match[0].lastIndexOf("{");
  const close = matchingDelimiter(source, open, "{", "}");
  if (close === null) return null;

  const result = new Set<string>([""]);
  for (const field of topLevelFieldRanges(source, open, close)) {
    const valueText = source
      .slice(field.value.start, field.value.end)
      .trimStart();
    if (!valueText.startsWith("{")) continue;
    result.add(field.name);
  }
  return result;
}

export function buildProjectModel(
  root: string,
  candidates: ScanFileInput[],
  options: ProjectModelBuildOptions = {},
): ProjectModel {
  const analyses: ProjectModelModuleAnalysis[] = [];

  for (const candidate of candidates) {
    if (
      candidate.source === undefined &&
      !fs.existsSync(candidate.absolutePath)
    ) continue;

    const relativePath = (candidate.relativePath ?? path.relative(root, candidate.absolutePath))
      .split(path.sep)
      .join("/");
    const hash = options.fileHashes?.[relativePath] ?? "";
    const cached = options.moduleCache?.get(relativePath);
    if (cached && hash && cached.hash === hash) {
      analyses.push(cached.analysis);
      continue;
    }

    const source = candidate.source ?? fs.readFileSync(candidate.absolutePath, "utf8");
    const id = relativePath.toLowerCase();
    const record: SourceRecord = { id, source, keys: moduleKeys(relativePath) };
    const memoArguments = findMemoCall(source);
    const analysis: ProjectModelModuleAnalysis = {
      record,
      memoized: memoArguments === null
        ? undefined
        : hasTopLevelComma(memoArguments) ? "custom" : "shallow",
      bindingHook: findBindingCandidateHook(source) ?? undefined,
      callbackFunction: findExternalCallbackFunction(source) ?? undefined,
      bindingCompatibleProps: findBindingCompatibleComponentProps(source) ?? undefined,
      staticIterationTables: findStaticIterationTables(source) ?? undefined,
      conditionalHookMode: findConditionalHookMode(source) ?? undefined,
      declaredMethods: findDeclaredMethods(source),
    };
    analyses.push(analysis);
    if (options.moduleCache && hash) options.moduleCache.set(relativePath, { hash, analysis });
  }

  const records = analyses.map((analysis) => analysis.record);
  const memoizedByModule = new Map<string, "shallow" | "custom">();
  const bindingHooksByModule = new Map<string, BindingCandidateHookSummary>();
  const callbackFunctionsByModule = new Map<string, ExternalCallbackFunctionSummary>();
  const bindingCompatibleComponentPropsByModule = new Map<string, Set<string>>();
  const staticIterationTablesByModule = new Map<string, Set<string>>();
  const conditionalHookModesByModule = new Map<string, ConditionalHookModeSummary>();

  for (const analysis of analyses) {
    const id = analysis.record.id;
    if (analysis.memoized) memoizedByModule.set(id, analysis.memoized);
    if (analysis.bindingHook) bindingHooksByModule.set(id, { ...analysis.bindingHook });
    if (analysis.callbackFunction) callbackFunctionsByModule.set(id, {
      ...analysis.callbackFunction,
      callbackParameterIndexes: [...analysis.callbackFunction.callbackParameterIndexes],
    });
    if (analysis.bindingCompatibleProps) bindingCompatibleComponentPropsByModule.set(id, new Set(analysis.bindingCompatibleProps));
    if (analysis.staticIterationTables) staticIterationTablesByModule.set(id, new Set(analysis.staticIterationTables));
    if (analysis.conditionalHookMode) conditionalHookModesByModule.set(id, {
      ...analysis.conditionalHookMode,
      parameterIndexes: [...analysis.conditionalHookMode.parameterIndexes],
      parameterNames: [...analysis.conditionalHookMode.parameterNames],
      conditionVariables: { ...analysis.conditionalHookMode.conditionVariables },
      conditionAccessPaths: { ...analysis.conditionalHookMode.conditionAccessPaths },
      knownCallSites: 0,
      dynamicCallSites: 0,
    });
  }

  const conditionalHookModes = buildUniqueFeatureAliases(
    records,
    conditionalHookModesByModule,
  );
  collectConditionalHookModeCallSites(records, conditionalHookModes);

  let changed = true;
  while (changed) {
    changed = false;
    const aliases = buildUniqueFeatureAliases(records, bindingHooksByModule);
    for (const record of records) {
      if (bindingHooksByModule.has(record.id)) continue;
      const derived = findDerivedBindingCandidateHook(record.source, aliases);
      if (!derived) continue;
      bindingHooksByModule.set(record.id, derived);
      changed = true;
    }
  }

  return {
    memoizedModules: buildUniqueFeatureAliases(records, memoizedByModule),
    bindingCandidateHooks: buildUniqueFeatureAliases(records, bindingHooksByModule),
    externalCallbackModules: buildUniqueFeatureAliases(records, callbackFunctionsByModule),
    bindingApiAlternatives: findBindingApiAlternativesFromMethodMaps(
      analyses.map((analysis) => analysis.declaredMethods),
    ),
    bindingCompatibleComponentProps: buildUniqueFeatureAliases(
      records,
      bindingCompatibleComponentPropsByModule,
    ),
    staticIterationTables: buildUniqueFeatureAliases(
      records,
      staticIterationTablesByModule,
    ),
    conditionalHookModes,
    sourceEffects: new Map(),
  };
}
