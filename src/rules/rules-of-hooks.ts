import {
  moduleKeys,
  normalizeRequireTarget,
  resolveModuleReference,
} from "../module-resolution";
import type { Node as SyntaxNode } from "web-tree-sitter";
import type {
  ConditionalHookModeSummary,
  DiagnosticInput,
  FixPreview,
  FunctionInfo,
  RuleContext,
  RuleDefinition,
} from "../types";
import { nodeKey } from "../ast/walk";
import {
  callNameNode,
  CONDITIONAL_TYPES,
  declarationNames,
  findAncestorBetween,
  isHookPath,
  isNestedInsideFunction,
} from "./helpers";

function staticIterationImports(
  context: RuleContext,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const node of context.walk(context.root)) {
    if (node.type !== "variable_declaration") continue;
    const match = node.text.match(
      /^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\s*\((.*?)\)\s*$/s,
    );
    if (!match) continue;
    const summary = resolveModuleReference(
      normalizeRequireTarget(match[2]),
      context.project.staticIterationTables,
    );
    if (summary) result.set(match[1], summary);
  }
  return result;
}

function conditionalHookModeImports(
  context: RuleContext,
): Map<string, ConditionalHookModeSummary> {
  const result = new Map<string, ConditionalHookModeSummary>();
  for (const node of context.walk(context.root)) {
    if (node.type !== "variable_declaration") continue;
    const match = node.text.match(
      /^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\s*\((.*?)\)\s*$/s,
    );
    if (!match) continue;
    const summary = resolveModuleReference(
      normalizeRequireTarget(match[2]),
      context.project.conditionalHookModes,
    );
    if (summary) result.set(match[1], summary);
  }
  return result;
}

function currentConditionalHookMode(
  context: RuleContext,
): ConditionalHookModeSummary | null {
  for (const key of moduleKeys(context.relativePath)) {
    const summary = context.project.conditionalHookModes.get(key);
    if (summary) return summary;
  }
  return null;
}

function controlledParameterIndex(
  controlFlow: SyntaxNode,
  fn: FunctionInfo,
  summary: ConditionalHookModeSummary,
): number | null {
  if (controlFlow.type !== "if_statement") return null;
  const header = (controlFlow.text.split(/\bthen\b/s, 1)[0] ?? "").trim();

  for (const [conditionName, index] of Object.entries(
    summary.conditionVariables,
  )) {
    const escaped = conditionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`^if\\s+${escaped}\\s*$`),
      new RegExp(`^if\\s+not\\s+${escaped}\\s*$`),
      new RegExp(`^if\\s+${escaped}\\s*(?:==|~=)\\s*(?:true|false|nil)\\s*$`),
      new RegExp(`^if\\s+(?:true|false|nil)\\s*(?:==|~=)\\s*${escaped}\\s*$`),
    ];
    if (patterns.some((pattern) => pattern.test(header))) return index;
  }

  // Keep a direct parameter fallback for older or externally constructed summaries.
  for (const index of summary.parameterIndexes) {
    const name = fn.parameters[index];
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^if\\s+(?:not\\s+)?${escaped}\\s*$`).test(header))
      return index;
  }
  return null;
}

function isStableModeArgument(
  node: SyntaxNode | undefined,
  context: RuleContext,
): boolean {
  if (!node) return true;
  const text = node.text.trim();
  if (["true", "false", "nil"].includes(text)) return true;
  if (
    [
      "number",
      "string",
      "string_content",
      "table_constructor",
      "function_definition",
    ].includes(node.type)
  )
    return true;
  if (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(text) &&
    context.model.stableVariables.has(text)
  )
    return true;
  return false;
}

function dynamicHookModeFixPreview(
  hookName: string,
  argumentText: string,
): FixPreview {
  return {
    kind: "pattern",
    before: `local value = ${hookName}(${argumentText})`,
    after: `local value = ${hookName}(true) -- or false; keep this mode fixed for this call site`,
    note: "A custom hook may choose different internal hooks only when this mode is stable for the lifetime of the component instance.",
  };
}

function unwrapIteratorExpression(text: string): string {
  let current = text.trim();
  const wrapper = current.match(/^(?:pairs|ipairs)\s*\((.*)\)$/s);
  if (wrapper) current = wrapper[1].trim();
  return current;
}


function declarationExpressions(node: SyntaxNode): SyntaxNode[] {
  if (node.type !== "variable_declaration") return [];
  const assignment = node.namedChildren.find(
    (child) => child.type === "assignment_statement",
  );
  const expressionList = assignment?.namedChildren.find(
    (child) => child.type === "expression_list",
  );
  return expressionList?.namedChildren ?? [];
}

function isEmptyTable(node: SyntaxNode | undefined): boolean {
  return Boolean(
    node?.type === "table_constructor" &&
      node.namedChildren.every((child) => child.type !== "field"),
  );
}

function stableShapeVariablesByFunction(
  context: RuleContext,
): Map<string, Set<string>> {
  const stable = new Map<string, Set<string>>();
  const functionsByName = new Map<string, FunctionInfo>();

  for (const fn of context.model.functions) {
    stable.set(nodeKey(fn.node), new Set<string>());
    if (fn.name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(fn.name))
      functionsByName.set(fn.name, fn);
  }

  const namesFor = (fn: FunctionInfo): Set<string> => {
    const key = nodeKey(fn.node);
    const names = stable.get(key) ?? new Set<string>();
    stable.set(key, names);
    return names;
  };

  // A table constructed in the function has a fixed literal shape. More importantly for
  // React code, an empty-dependency useMemo explicitly captures one value for the entire
  // component lifetime. If that captured value is later iterated to create hooks, the
  // iteration source itself does not change between renders unless user code mutates it.
  for (const declaration of context.walk(context.root)) {
    if (declaration.type !== "variable_declaration") continue;
    const owner = context.nearestFunction(declaration);
    if (!owner) continue;
    const names = declarationNames(declaration);
    const expressions = declarationExpressions(declaration);
    for (let index = 0; index < names.length; index += 1) {
      const expression = expressions[index] ?? expressions[0];
      if (!expression) continue;
      if (expression.type === "table_constructor") {
        namesFor(owner).add(names[index]);
        continue;
      }
      if (expression.type !== "function_call") continue;
      const rawPath = context.getCallPath(expression);
      if (!rawPath || context.resolveCallPath(rawPath) !== "React.useMemo")
        continue;
      const args = context.callArguments(expression);
      if (isEmptyTable(args[1])) namesFor(owner).add(names[index]);
    }
  }

  const callsByLocalFunction = new Map<string, SyntaxNode[]>();
  for (const call of context.findCalls()) {
    const rawPath = context.getCallPath(call);
    if (!rawPath || !functionsByName.has(rawPath)) continue;
    const calls = callsByLocalFunction.get(rawPath) ?? [];
    calls.push(call);
    callsByLocalFunction.set(rawPath, calls);
  }

  const expressionIsStableShape = (
    expression: SyntaxNode | undefined,
    owner: FunctionInfo | null,
  ): boolean => {
    if (!expression) return false;
    if (expression.type === "table_constructor") return true;
    const text = expression.text.trim();
    if (!owner || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) return false;
    return namesFor(owner).has(text);
  };

  let changed = true;
  while (changed) {
    changed = false;

    // Preserve stable-shape aliases such as `local copy = capturedDefaults`.
    for (const declaration of context.walk(context.root)) {
      if (declaration.type !== "variable_declaration") continue;
      const owner = context.nearestFunction(declaration);
      if (!owner) continue;
      const names = declarationNames(declaration);
      const expressions = declarationExpressions(declaration);
      for (let index = 0; index < names.length; index += 1) {
        const expression = expressions[index] ?? expressions[0];
        if (!expressionIsStableShape(expression, owner)) continue;
        const target = names[index];
        const ownerNames = namesFor(owner);
        if (!ownerNames.has(target)) {
          ownerNames.add(target);
          changed = true;
        }
      }
    }

    // Propagate the guarantee through local helpers only when every known call to that
    // helper supplies a stable-shape argument for the parameter. This is what makes a
    // pattern such as `getStateContainer(capturedDefaults)` safe without exempting all
    // parameter-driven loops.
    for (const [name, fn] of functionsByName) {
      const calls = callsByLocalFunction.get(name) ?? [];
      if (calls.length === 0) continue;
      for (let index = 0; index < fn.parameters.length; index += 1) {
        const allStable = calls.every((call) => {
          const caller = context.nearestFunction(call);
          return expressionIsStableShape(context.callArguments(call)[index], caller);
        });
        if (!allStable) continue;
        const parameter = fn.parameters[index];
        if (!parameter) continue;
        const fnNames = namesFor(fn);
        if (!fnNames.has(parameter)) {
          fnNames.add(parameter);
          changed = true;
        }
      }
    }
  }

  return stable;
}

function loopIterationIsProvablyStable(
  loop: SyntaxNode,
  imports: Map<string, Set<string>>,
  owner: FunctionInfo,
  stableShapes: Map<string, Set<string>>,
): boolean {
  const numeric = loop.namedChildren.find(
    (child) => child.type === "for_numeric_clause",
  );
  if (numeric) {
    const text = numeric.text;
    const bounds = text.match(
      /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*([^,]+)\s*,\s*([^,]+)(?:\s*,\s*([^,]+))?\s*$/s,
    );
    if (
      bounds &&
      bounds
        .slice(1)
        .filter(Boolean)
        .every((value) => /^-?\d+(?:\.\d+)?$/.test(value!.trim()))
    )
      return true;
  }

  const clause = loop.namedChildren.find(
    (child) => child.type === "for_generic_clause",
  );
  const match = clause?.text.match(/\bin\s+(.+)$/s);
  if (!match) return false;
  const expression = unwrapIteratorExpression(match[1]);
  const path = expression.match(
    /^([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_.]*))?$/,
  );
  if (!path) return false;
  if (
    !path[2] &&
    stableShapes.get(nodeKey(owner.node))?.has(path[1])
  )
    return true;
  const fields = imports.get(path[1]);
  if (!fields) return false;
  const propertyPath = path[2] ?? "";
  return fields.has(propertyPath);
}

function functionParameterTypes(fn: FunctionInfo): Map<string, string> {
  if (!fn.body) return new Map();
  const headerLength = Math.max(0, fn.body.startIndex - fn.node.startIndex);
  const header = fn.node.text.slice(0, headerLength);
  const result = new Map<string, string>();
  for (const match of header.matchAll(
    /\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^,\n)]+)/g,
  )) {
    result.set(match[1], match[2].trim());
  }
  return result;
}

function isNonOptionalParameterType(typeText: string | undefined): boolean {
  if (!typeText) return false;
  return !typeText.includes("?") && !/(?:^|[| ])nil(?:$|[| ])/i.test(typeText);
}

function impossibleNilGuardReturn(
  node: SyntaxNode,
  fn: FunctionInfo,
  parameterTypes: Map<string, string>,
): boolean {
  let current = node.parent;
  while (current && current !== fn.node) {
    if (current.type === "if_statement") {
      const header = (current.text.split(/\bthen\b/s, 1)[0] ?? "").trim();
      const patterns = [
        /\bif\s+not\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/,
        /\bif\s+([A-Za-z_][A-Za-z0-9_]*)\s*==\s*nil\s*$/,
        /\bif\s+nil\s*==\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/,
      ];
      for (const pattern of patterns) {
        const match = header.match(pattern);
        if (match && isNonOptionalParameterType(parameterTypes.get(match[1])))
          return true;
      }
      return false;
    }
    current = current.parent;
  }
  return false;
}

function hasReachableReturnBefore(
  call: SyntaxNode,
  fn: FunctionInfo,
  context: RuleContext,
  cache: Map<string, SyntaxNode[]>,
): boolean {
  if (!fn.body) return false;
  const key = nodeKey(fn.node);
  let returns = cache.get(key);
  if (!returns) {
    const parameterTypes = functionParameterTypes(fn);
    returns = [...context.walk(fn.body)].filter(
      (node) =>
        node.type === "return_statement" &&
        !isNestedInsideFunction(node, fn.node) &&
        !impossibleNilGuardReturn(node, fn, parameterTypes),
    );
    cache.set(key, returns);
  }
  return returns.some((node) => node.endIndex <= call.startIndex);
}

function conditionalFixPreview(kind: string, hookName: string): FixPreview {
  if (kind === "for statement") {
    return {
      kind: "pattern",
      before: `for _, item in items do\n\tlocal value = ${hookName}(item)\nend`,
      after: `local function Item(props)\n\tlocal value = ${hookName}(props.item)\n\treturn renderItem(value)\nend\n\nfor _, item in items do\n\tchildren[item.id] = React.createElement(Item, {\n\t\titem = item,\n\t})\nend`,
      note: "When collection size can change, move the hook into a child component so each component instance owns a fixed hook sequence.",
    };
  }
  if (kind === "while statement" || kind === "repeat statement") {
    return {
      kind: "pattern",
      before: `while condition do\n\tlocal value = ${hookName}()\nend`,
      after: `local value = ${hookName}()\n\nwhile condition do\n\t-- use value without creating another hook call\nend`,
      note: "Hook count must not depend on how many times a runtime loop executes.",
    };
  }
  return {
    kind: "pattern",
    before: `if enabled then\n\tlocal value = ${hookName}()\nend`,
    after: `local value = ${hookName}()\n\nif enabled then\n\t-- use value here\nend`,
    note: "Keep the hook call unconditional, then branch on its result.",
  };
}

function earlyReturnFixPreview(hookName: string): FixPreview {
  return {
    kind: "pattern",
    before: `if not ready then\n\treturn nil\nend\n\nlocal value = ${hookName}()`,
    after: `local value = ${hookName}()\n\nif not ready then\n\treturn nil\nend`,
    note: "Call hooks before any reachable early return so every render executes the same hook sequence.",
  };
}

export const rulesOfHooks: RuleDefinition = {
  id: "react-luau/rules-of-hooks",
  category: "Hooks",
  severity: "error",
  description:
    "Hooks must run in the same order on every render of a React component or custom hook.",
  run(context) {
    const diagnostics: DiagnosticInput[] = [];
    const staticImports = staticIterationImports(context);
    const stableShapes = stableShapeVariablesByFunction(context);
    const modeImports = conditionalHookModeImports(context);
    const currentModeSummary = currentConditionalHookMode(context);
    const reachableReturns = new Map<string, SyntaxNode[]>();

    for (const call of context.findCalls()) {
      const rawPath = context.getCallPath(call);
      if (!rawPath) continue;
      const path = context.resolveCallPath(rawPath);
      if (!isHookPath(path)) continue;

      const fn = context.nearestFunction(call);
      if (!fn || (!fn.isComponent && !fn.isHook)) {
        diagnostics.push({
          node: callNameNode(call),
          message: `Hook ${path} is called outside a React component or custom hook.`,
          help: "Move the hook into a component or a custom hook whose name starts with use.",
          fixPreview: {
            kind: "pattern",
            before: `local value = ${path}()\n\nlocal function helper()\n\treturn value\nend`,
            after: `local function useHelper()\n\tlocal value = ${path}()\n\treturn value\nend`,
            note: "Hooks need a React-owned component or custom-hook call stack.",
          },
        });
        continue;
      }

      const importedMode = modeImports.get(rawPath);
      if (importedMode) {
        const args = context.callArguments(call);
        const dynamicIndexes = importedMode.parameterIndexes.filter(
          (index) => !isStableModeArgument(args[index], context),
        );
        if (dynamicIndexes.length > 0) {
          const firstIndex = dynamicIndexes[0];
          const argument = args[firstIndex];
          const parameterOffset =
            importedMode.parameterIndexes.indexOf(firstIndex);
          const parameterName =
            importedMode.parameterNames[parameterOffset] ??
            `argument ${firstIndex + 1}`;
          const argumentText = argument?.text.trim() || "<omitted>";
          diagnostics.push({
            node: argument ?? callNameNode(call),
            highlights: dynamicIndexes
              .map((index) => args[index])
              .filter((node): node is SyntaxNode => Boolean(node)),
            message: `Hook ${rawPath} receives render-varying hook mode ${parameterName} from ${argumentText}; if it changes between renders, the custom hook can execute a different hook sequence.`,
            help: `Pass a stable mode at this call site, or refactor ${rawPath} so it always calls the same hooks regardless of ${parameterName}.`,
            fixPreview: dynamicHookModeFixPreview(rawPath, argumentText),
          });
        }
      }

      const controlFlow = findAncestorBetween(call, fn.node, (node) =>
        CONDITIONAL_TYPES.has(node.type),
      );
      if (controlFlow) {
        if (
          currentModeSummary &&
          currentModeSummary.knownCallSites > 0 &&
          controlledParameterIndex(controlFlow, fn, currentModeSummary) !== null
        )
          continue;
        if (
          controlFlow.type === "for_statement" &&
          loopIterationIsProvablyStable(
            controlFlow,
            staticImports,
            fn,
            stableShapes,
          )
        )
          continue;
        const kind = controlFlow.type.replaceAll("_", " ");
        const loopLike =
          controlFlow.type === "for_statement" ||
          controlFlow.type === "while_statement" ||
          controlFlow.type === "repeat_statement";
        diagnostics.push({
          node: callNameNode(call),
          message: loopLike
            ? `Hook ${path} is called inside ${kind} whose size or iteration order may change between renders. If that happens, React will see a different hook sequence.`
            : `Hook ${path} is called inside ${kind}, so the hook may be skipped on some renders.`,
          help: loopLike
            ? "Keep hook count independent of runtime collection size or loop iterations. A common fix is to render a child component per item and call the hook inside that child."
            : "Call the hook unconditionally at the top level, then branch on the returned value.",
          fixPreview: conditionalFixPreview(kind, path),
        });
        continue;
      }

      if (hasReachableReturnBefore(call, fn, context, reachableReturns)) {
        diagnostics.push({
          node: callNameNode(call),
          message: `Hook ${path} may run after an earlier reachable return, so some renders can execute fewer hooks.`,
          help: "Move the hook before reachable early returns so hook order cannot change between renders.",
          fixPreview: earlyReturnFixPreview(path),
        });
      }
    }

    return diagnostics;
  },
};
