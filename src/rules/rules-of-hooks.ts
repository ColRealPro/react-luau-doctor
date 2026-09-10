import {
  moduleKeys,
  normalizeRequireTarget,
  resolveModuleReference,
} from "../module-resolution";
import type { SyntaxNode } from "../syntax";
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

type HookModeStability = "stable" | "unknown" | "unstable";

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


function nonReactHookImports(context: RuleContext): Set<string> {
  const result = new Set<string>();
  for (const node of context.walk(context.root)) {
    if (node.type !== "variable_declaration") continue;
    const match = node.text.match(
      /^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\s*\((.*?)\)\s*$/s,
    );
    if (!match || !/^use[A-Z0-9_]/.test(match[1])) continue;
    const kind = resolveModuleReference(
      normalizeRequireTarget(match[2]),
      context.project.reactHookModules,
    );
    if (kind === false) result.add(match[1]);
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

function dynamicHookModeFixPreview(
  hookName: string,
  argumentText: string,
): FixPreview {
  return {
    kind: "pattern",
    before: `local value = ${hookName}(${argumentText})`,
    after: `local value = ${hookName}(${argumentText}) -- keep the hook-topology mode stable for this instance`,
    note: "A custom hook may choose different internal hooks only when the value controlling that choice stays stable for the lifetime of the component instance.",
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

function tableConstructorHasStableArity(node: SyntaxNode): boolean {
  if (node.type !== "table_constructor") return false;
  const fields = node.namedChildren.filter((child) => child.type === "field");
  if (fields.length === 0) return true;

  // Luau varargs, and a function call in the final list field, can contribute a
  // render-varying number of array entries. `{...}` is the real-world Jecs case
  // that motivated this distinction.
  if (
    fields.some((field) =>
      [...field.namedChildren].some((child) => child.type === "vararg_expression"),
    )
  )
    return false;
  const last = fields.at(-1);
  return !last?.namedChildren.some((child) => child.type === "function_call");
}

function stableShapeVariablesByFunction(
  context: RuleContext,
): Map<number, Set<string>> {
  const stable = new Map<number, Set<string>>();
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
      if (
        expression.type === "table_constructor" &&
        tableConstructorHasStableArity(expression)
      ) {
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
    if (expression.type === "table_constructor") return tableConstructorHasStableArity(expression);
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

function moduleInvariantVariables(context: RuleContext): Set<string> {
  const declarations = new Map<string, SyntaxNode>();
  const reassigned = new Set<string>();

  for (const node of context.walk(context.root)) {
    if (node.type === "variable_declaration" && !context.nearestFunction(node)) {
      for (const name of declarationNames(node)) declarations.set(name, node);
      continue;
    }
    if (
      node.type !== "assignment_statement" ||
      node.parent?.type === "variable_declaration"
    )
      continue;
    const variableList = node.namedChildren.find(
      (child) => child.type === "variable_list",
    );
    for (const target of variableList?.namedChildren ?? []) {
      if (target.type === "identifier") reassigned.add(target.text);
    }
  }

  return new Set(
    [...declarations.keys()].filter((name) => !reassigned.has(name)),
  );
}

function simpleConditionRoot(controlFlow: SyntaxNode): string | null {
  if (controlFlow.type !== "if_statement" && controlFlow.type !== "if_expression")
    return null;
  const condition = controlFlow.namedChildren[0];
  if (!condition) return null;
  const text = condition.text.trim();
  const match = text.match(
    /^(?:not\s+)?([A-Za-z_][A-Za-z0-9_]*)(?:\s*(?:==|~=)\s*(?:true|false|nil))?$/,
  );
  return match?.[1] ?? null;
}

function conditionIsProvablyInvariant(
  controlFlow: SyntaxNode,
  fn: FunctionInfo,
  context: RuleContext,
  moduleInvariants: Set<string>,
): boolean {
  const condition = controlFlow.namedChildren[0];
  if (!condition) return false;
  if (["true", "false", "nil", "number", "string"].includes(condition.type))
    return true;

  const root = simpleConditionRoot(controlFlow);
  if (!root) return false;
  if (moduleInvariants.has(root)) return true;
  return Boolean(
    context.model.stableVariablesByFunction.get(nodeKey(fn.node))?.has(root),
  );
}

function branchHookSequence(
  branch: SyntaxNode,
  fn: FunctionInfo,
  context: RuleContext,
): string[] | null {
  const hooks: string[] = [];
  for (const node of context.walk(branch)) {
    if (node.type !== "function_call") continue;
    if (context.nearestFunction(node) !== fn) continue;
    const rawPath = context.getCallPath(node);
    if (!rawPath) continue;
    const path = context.resolveCallPath(rawPath);
    if (!isHookPath(path)) continue;

    // Nested control flow inside a branch needs its own stability proof, so do
    // not call the outer branches equivalent merely because their flattened
    // hook names happen to match.
    const nestedControl = findAncestorBetween(node, branch, (ancestor) =>
      CONDITIONAL_TYPES.has(ancestor.type),
    );
    if (nestedControl) return null;
    hooks.push(path);
  }
  return hooks;
}

function ifBranchesHaveEquivalentBuiltInTopology(
  controlFlow: SyntaxNode,
  fn: FunctionInfo,
  context: RuleContext,
): boolean {
  if (controlFlow.type !== "if_statement") return false;
  const thenBlock = controlFlow.namedChildren.find(
    (child) => child.type === "block",
  );
  const elseStatement = controlFlow.namedChildren.find(
    (child) => child.type === "else_statement",
  );
  const elseBlock = elseStatement?.namedChildren.find(
    (child) => child.type === "block",
  );
  if (!thenBlock || !elseBlock) return false;

  const thenHooks = branchHookSequence(thenBlock, fn, context);
  const elseHooks = branchHookSequence(elseBlock, fn, context);
  if (!thenHooks || !elseHooks || thenHooks.length !== elseHooks.length)
    return false;
  if (!thenHooks.every((path, index) => path === elseHooks[index])) return false;

  // Built-in React hooks have topology that is independent of their arguments.
  // For custom hooks, identical call names can still select different internal
  // hooks based on different arguments, so keep those conservative.
  return thenHooks.every((path) => path.startsWith("React."));
}

function stateModeStability(
  name: string,
  owner: FunctionInfo,
  context: RuleContext,
): HookModeStability | null {
  const binding = context.model.stateBindings.find(
    (candidate) => candidate.owner === owner && candidate.valueName === name,
  );
  if (!binding || !owner.body) return null;

  const initializerText = binding.initializer?.text.trim() ?? "nil";
  const stableLiteral = /^(?:true|false|nil|-?\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/;
  let sawIndirectSetterReference = false;
  for (const node of context.walk(owner.body)) {
    if (node.type === "function_call" && context.getCallPath(node) === binding.setterName) {
      const argument = context.callArguments(node)[0];
      if (
        !argument ||
        !stableLiteral.test(initializerText) ||
        argument.text.trim() !== initializerText
      )
        return "unstable";
      continue;
    }
    if (node.type !== "identifier" || node.text !== binding.setterName) continue;
    if (node.startIndex >= binding.declaration.startIndex && node.endIndex <= binding.declaration.endIndex)
      continue;
    if (node.parent?.type === "function_call") continue;
    sawIndirectSetterReference = true;
  }

  if (sawIndirectSetterReference) return "unknown";
  return "stable";
}

function localAliasExpression(
  name: string,
  owner: FunctionInfo,
  context: RuleContext,
): SyntaxNode | null {
  if (!owner.body) return null;
  let result: SyntaxNode | null = null;
  for (const node of context.walk(owner.body)) {
    if (node.type !== "variable_declaration" || context.nearestFunction(node) !== owner)
      continue;
    const names = declarationNames(node);
    const index = names.indexOf(name);
    if (index < 0) continue;
    const expressions = declarationExpressions(node);
    const expression = expressions[index] ?? expressions[0] ?? null;
    if (result) return null;
    result = expression;
  }
  return result;
}

function modeValueStability(
  node: SyntaxNode | undefined,
  owner: FunctionInfo,
  context: RuleContext,
  moduleInvariants: Set<string>,
  depth = 0,
): HookModeStability {
  if (!node) return "stable";
  if (depth > 4) return "unknown";
  const text = node.text.trim();
  if (["true", "false", "nil"].includes(text)) return "stable";
  if (["number", "string", "string_content", "function_definition"].includes(node.type))
    return "stable";

  const root = text.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
  if (!root) return "unknown";
  const stateStability = stateModeStability(root, owner, context);
  if (stateStability) return stateStability;
  if (moduleInvariants.has(root)) return "stable";
  if (
    context.model.stableVariablesByFunction.get(nodeKey(owner.node))?.has(root)
  )
    return "stable";

  if (text === root) {
    const alias = localAliasExpression(root, owner, context);
    if (alias && alias.text.trim() !== root)
      return modeValueStability(alias, owner, context, moduleInvariants, depth + 1);
  }
  return "unknown";
}

function tableFieldValue(
  table: SyntaxNode | undefined,
  accessPath: string,
): SyntaxNode | undefined {
  if (!table || accessPath === "") return table;
  if (table.type !== "table_constructor") return undefined;
  let current: SyntaxNode | undefined = table;
  for (const part of accessPath.split(".")) {
    if (!current || current.type !== "table_constructor") return undefined;
    const field: SyntaxNode | undefined = current.namedChildren.find((child) => {
      if (child.type !== "field") return false;
      return child.namedChildren[0]?.type === "identifier" &&
        child.namedChildren[0]?.text === part;
    });
    if (!field) return undefined;
    current = field.namedChildren[1];
  }
  return current;
}

function controlledAccessPaths(
  summary: ConditionalHookModeSummary,
  parameterIndex: number,
): string[] {
  const paths = new Set<string>();
  for (const [conditionName, index] of Object.entries(summary.conditionVariables)) {
    if (index !== parameterIndex) continue;
    paths.add(summary.conditionAccessPaths?.[conditionName] ?? "");
  }
  if (paths.size === 0) paths.add("");
  return [...paths];
}

function loopIterationIsProvablyStable(
  loop: SyntaxNode,
  imports: Map<string, Set<string>>,
  owner: FunctionInfo,
  stableShapes: Map<number, Set<string>>,
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

function reachableReturnsBefore(
  call: SyntaxNode,
  fn: FunctionInfo,
  context: RuleContext,
  cache: Map<number, SyntaxNode[]>,
): SyntaxNode[] {
  if (!fn.body) return [];
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
  return returns.filter((node) => node.endIndex <= call.startIndex);
}

function returnIsControlledByStableTopologyMode(
  node: SyntaxNode,
  fn: FunctionInfo,
  summary: ConditionalHookModeSummary | null,
  context: RuleContext,
  moduleInvariants: Set<string>,
): boolean {
  let current = node.parent;
  while (current && current !== fn.node) {
    if (current.type === "if_statement" || current.type === "if_expression") {
      if (
        summary &&
        controlledParameterIndex(current, fn, summary) !== null
      )
        return true;
      if (conditionIsProvablyInvariant(current, fn, context, moduleInvariants))
        return true;
      return false;
    }
    current = current.parent;
  }
  return false;
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
    if (!context.model.isReactFile) return diagnostics;
    const staticImports = staticIterationImports(context);
    const stableShapes = stableShapeVariablesByFunction(context);
    const moduleInvariants = moduleInvariantVariables(context);
    const modeImports = conditionalHookModeImports(context);
    const ignoredHookImports = nonReactHookImports(context);
    const currentModeSummary = currentConditionalHookMode(context);
    const reachableReturns = new Map<number, SyntaxNode[]>();

    for (const call of context.findCalls()) {
      const rawPath = context.getCallPath(call);
      if (!rawPath) continue;
      if (ignoredHookImports.has(rawPath)) continue;
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
        const unstableControls = importedMode.parameterIndexes.flatMap((index) =>
          controlledAccessPaths(importedMode, index)
            .map((accessPath) => {
              const argument = args[index];
              const value = tableFieldValue(argument, accessPath);
              const stability = accessPath !== ""
                ? argument?.type === "table_constructor"
                  ? value
                    ? modeValueStability(value, fn, context, moduleInvariants)
                    : "stable"
                  : "unknown"
                : modeValueStability(
                    argument,
                    fn,
                    context,
                    moduleInvariants,
                  );
              return { index, accessPath, argument, value, stability };
            })
            .filter((control) => control.stability === "unstable"),
        );
        if (unstableControls.length > 0) {
          const first = unstableControls[0];
          const firstIndex = first.index;
          const argument = first.argument;
          const parameterOffset =
            importedMode.parameterIndexes.indexOf(firstIndex);
          const baseParameterName =
            importedMode.parameterNames[parameterOffset] ??
            `argument ${firstIndex + 1}`;
          const parameterName = first.accessPath
            ? `${baseParameterName}.${first.accessPath}`
            : baseParameterName;
          const argumentText = first.value?.text.trim() || argument?.text.trim() || "<omitted>";
          diagnostics.push({
            node: first.value ?? argument ?? callNameNode(call),
            highlights: unstableControls
              .map((control) => control.value ?? control.argument)
              .filter((node): node is SyntaxNode => Boolean(node)),
            message: `Hook ${rawPath} receives hook-topology mode ${parameterName} from ${argumentText}, which is updated between renders and can make the custom hook execute a different hook sequence.`,
            help: `Keep ${parameterName} stable for this hook instance, or refactor ${rawPath} so it always calls the same hooks regardless of that mode.`,
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
          controlledParameterIndex(controlFlow, fn, currentModeSummary) !== null
        )
          continue;
        if (conditionIsProvablyInvariant(controlFlow, fn, context, moduleInvariants))
          continue;
        if (ifBranchesHaveEquivalentBuiltInTopology(controlFlow, fn, context))
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

      const earlierReturns = reachableReturnsBefore(
        call,
        fn,
        context,
        reachableReturns,
      );
      if (
        earlierReturns.length > 0 &&
        !earlierReturns.every((node) =>
          returnIsControlledByStableTopologyMode(
            node,
            fn,
            currentModeSummary,
            context,
            moduleInvariants,
          ),
        )
      ) {
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
