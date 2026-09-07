import type { SyntaxNode } from "../syntax";
import type { FixPreview, FunctionInfo, RuleContext, RuleDefinition, Severity } from "../types";
import { sameNode } from "../ast/walk";
import { functionYieldPoint } from "../roblox-semantics";
import { callNameNode, declarationNames, firstFunctionArgument, functionInfoForNode } from "./helpers";

interface Resource {
  call: SyntaxNode;
  label: string;
  variable: string | null;
  detail?: string;
  severity?: Severity;
  cleanupMatches(cleanupText: string, variable: string | null, call: SyntaxNode): boolean;
}

const ALWAYS_MANAGED_METHOD = /:GiveTask$/;
const GENERIC_MANAGER_METHOD = /:(?:Add|AddTask|AddObject|Track)$/;
const MANAGER_ROOT = /(?:maid|trove|janitor|cleaner|cleanup|scope|bin|disposer)(?:$|[._])/i;
const CONNECTION_RETURNING_METHODS = new Set(["BindToSimulation", "SubscribeAsync", "OnUpdate"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function connectionOwnerExpression(rawPath: string): string | null {
  const connected = rawPath.match(/^(.*):Connect$/s)?.[1];
  if (!connected) return null;

  const signalMethod = connected.match(/^(.*):(?:GetPropertyChangedSignal|GetAttributeChangedSignal)\s*\(.*\)$/s);
  if (signalMethod) return signalMethod[1]?.trim() || null;

  const eventProperty = connected.match(/^(.*)\.[A-Za-z_][A-Za-z0-9_]*$/s);
  return eventProperty?.[1]?.trim() || null;
}

function declarationExpressions(node: SyntaxNode): SyntaxNode[] {
  if (node.type !== "variable_declaration") return [];
  const assignment = node.namedChildren.find((child) => child.type === "assignment_statement");
  const expressionList = assignment?.namedChildren.find((child) => child.type === "expression_list");
  return expressionList?.namedChildren ?? [];
}

function initializerCreatesInstance(initializer: SyntaxNode | undefined, context: RuleContext): boolean {
  if (!initializer) return false;
  for (const candidate of context.walk(initializer)) {
    if (candidate.type !== "function_call") continue;
    if (context.resolveCallPath(context.getCallPath(candidate) ?? "") === "Instance.new") return true;
  }
  return false;
}

function bodyDeclaresInstanceBefore(
  body: SyntaxNode | null,
  beforeIndex: number,
  expression: string,
  context: RuleContext,
): boolean {
  if (!body) return false;
  for (const child of body.namedChildren) {
    if (child.startIndex >= beforeIndex) break;
    if (child.type !== "variable_declaration") continue;
    const names = declarationNames(child);
    const index = names.indexOf(expression);
    if (index === -1) continue;
    if (initializerCreatesInstance(declarationExpressions(child)[index], context)) return true;
  }
  return false;
}

function isProvenInstanceExpression(
  expression: string | null,
  call: SyntaxNode,
  context: RuleContext,
  callback: FunctionInfo,
): boolean {
  if (!expression || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(expression)) return false;
  const callbackInstances = context.model.instanceVariablesByFunction.get(callback.node.id);
  if (callbackInstances?.has(expression)) return true;
  if (bodyDeclaresInstanceBefore(callback.body, call.startIndex, expression, context)) return true;

  const effectOwner = context.nearestFunction(callback.node);
  if (effectOwner) {
    const ownerInstances = context.model.instanceVariablesByFunction.get(effectOwner.node.id);
    if (ownerInstances?.has(expression)) return true;
  }
  return Boolean(effectOwner && bodyDeclaresInstanceBefore(effectOwner.body, callback.node.startIndex, expression, context));
}

function cleanupDestroysExpression(cleanupText: string, expression: string): boolean {
  return new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegExp(expression)}\\s*:\\s*Destroy\\s*\\(`, "s").test(cleanupText);
}

function assignedVariableName(call: SyntaxNode, callback: FunctionInfo): string | null {
  let current = call.parent;
  while (current && !sameNode(current, callback.node)) {
    if (current.type === "variable_declaration") {
      const names = declarationNames(current);
      const expressions = declarationExpressions(current);
      const index = expressions.findIndex((expression) => expression.startIndex <= call.startIndex && expression.endIndex >= call.endIndex);
      if (index >= 0) return names[index] ?? names[0] ?? null;
      return names[0] ?? null;
    }
    if (current.type === "assignment_statement") {
      const beforeCall = current.text.slice(0, Math.max(0, call.startIndex - current.startIndex));
      const match = beforeCall.match(/^\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*\[[^\]]+\]|\s*\.[A-Za-z_][A-Za-z0-9_]*)*)\s*=\s*$/s);
      const target = match?.[1]?.replace(/\s+/g, "") ?? "";
      const root = target.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
      if (root) return root;
      // A call can be nested inside a conditional/table initializer. In that case
      // keep walking so the surrounding variable declaration can own the resource.
    }
    if (current.type === "function_definition" || current.type === "function_declaration") return null;
    current = current.parent;
  }
  return null;
}

function cleanupIteratesAndDisconnects(cleanupText: string, collection: string): boolean {
  const escaped = escapeRegExp(collection);
  const loops = new RegExp(
    `for\\s+[^\\n]*?([A-Za-z_][A-Za-z0-9_]*)\\s+in\\s+${escaped}\\s+do([\\s\\S]*?)end`,
    "g",
  );
  for (const match of cleanupText.matchAll(loops)) {
    const item = match[1];
    const body = match[2] ?? "";
    if (new RegExp(`\\b${escapeRegExp(item)}\\s*:\\s*Disconnect\\s*\\(`).test(body)) return true;
  }
  return false;
}

function cleanupCallsDisposer(cleanupText: string, variable: string): boolean {
  return new RegExp(`(?:^|[^A-Za-z0-9_.:])${escapeRegExp(variable)}\\s*\\(`, "s").test(cleanupText);
}

function isManagedByCleanupContainer(call: SyntaxNode, context: RuleContext, callback: FunctionInfo): boolean {
  let current = call.parent;
  while (current && !sameNode(current, callback.node)) {
    if (current.type === "function_call") {
      const path = context.getCallPath(current) ?? "";
      if (ALWAYS_MANAGED_METHOD.test(path)) return true;
      if (GENERIC_MANAGER_METHOD.test(path)) {
        const receiver = path.split(":", 1)[0] ?? "";
        if (MANAGER_ROOT.test(receiver)) return true;
      }
    }
    if (current.type === "function_definition" || current.type === "function_declaration") return false;
    current = current.parent;
  }
  return false;
}

function localFunctionByName(callback: FunctionInfo, name: string, context: RuleContext): SyntaxNode | null {
  if (!callback.body) return null;
  for (const child of callback.body.namedChildren) {
    if (child.type === "function_declaration" && child.childForFieldName("name")?.text === name) return child;
    if (child.type !== "variable_declaration") continue;
    const match = child.text.match(new RegExp(`^\\s*local\\s+${escapeRegExp(name)}\\s*=\\s*function\\b`, "s"));
    if (!match) continue;
    return [...context.walk(child)].find((node) => node.type === "function_definition") ?? null;
  }
  return null;
}

function cleanupTexts(callback: FunctionInfo, context: RuleContext): string[] {
  if (!callback.body) return [];
  const texts: string[] = [];

  for (const node of context.walk(callback.body)) {
    if (node.type !== "return_statement") continue;
    if (context.nearestFunction(node) !== callback) continue;
    const expressionList = node.namedChildren.find((child) => child.type === "expression_list");
    const returned = expressionList?.namedChildren[0];
    if (!returned) continue;
    if (returned.type === "function_definition") {
      texts.push(returned.text);
      continue;
    }
    if (returned.type === "identifier") {
      const localFunction = localFunctionByName(callback, returned.text, context);
      if (localFunction) texts.push(localFunction.text);
    }
  }

  return texts;
}

function taskCallbackNode(call: SyntaxNode, context: RuleContext, callback: FunctionInfo): SyntaxNode | null {
  const args = context.callArguments(call);
  const candidate = args.find((arg) => arg.type === "function_definition");
  if (candidate) return candidate;
  const named = args[0];
  if (named?.type === "identifier") return localFunctionByName(callback, named.text, context);
  return null;
}

function cancellationFlagMatches(taskCallback: SyntaxNode | null, cleanupText: string, callback: FunctionInfo): boolean {
  if (!taskCallback || !callback.body) return false;
  const beforeTask = callback.body.text.slice(0, Math.max(0, taskCallback.startIndex - callback.body.startIndex));
  const declarations = [...beforeTask.matchAll(/\blocal\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*false\b/g)].map((match) => match[1]);

  for (const name of declarations) {
    const escaped = escapeRegExp(name);
    if (!new RegExp(`\\b${escaped}\\s*=\\s*true\\b`).test(cleanupText)) continue;
    const taskText = taskCallback.text;
    const observesCancellation = new RegExp(`(?:if\\s+${escaped}\\s+then[\\s\\S]{0,120}?return|if\\s+not\\s+${escaped}\\s+then|while\\s+not\\s+${escaped}\\b|until\\s+${escaped}\\b)`, "s").test(taskText);
    if (observesCancellation) return true;
  }

  return false;
}

function connectionResource(call: SyntaxNode, variable: string | null, label = "RBXScriptConnection"): Resource {
  return {
    call,
    label,
    variable,
    cleanupMatches(text, name) {
      return Boolean(
        name
          && (new RegExp(`\\b${escapeRegExp(name)}\\s*:\\s*Disconnect\\s*\\(`).test(text)
            || cleanupIteratesAndDisconnects(text, name)),
      );
    },
  };
}

function numericTaskDelay(call: SyntaxNode, context: RuleContext): number | null {
  const first = context.callArguments(call)[0]?.text.trim();
  if (!first || !/^-?\d+(?:\.\d+)?$/.test(first)) return null;
  const value = Number(first);
  return Number.isFinite(value) ? value : null;
}

function isCleanupOnlyTask(callbackNode: SyntaxNode | null, context: RuleContext): boolean {
  if (!callbackNode) return false;
  const info = functionInfoForNode(context, callbackNode);
  if (!info?.body) return false;
  const calls = [...context.walk(info.body)].filter((node) => node.type === "function_call" && context.nearestFunction(node) === info);
  if (calls.length === 0) return false;
  return calls.every((call) => /:(?:Destroy|Disconnect)$/.test(context.getCallPath(call) ?? ""));
}

function taskSeverity(path: string, call: SyntaxNode, taskCallback: SyntaxNode | null, yieldPoint: unknown, context: RuleContext): Severity {
  if (path === "task.defer" && !yieldPoint) return "suggestion";
  if (path === "task.delay" && !yieldPoint) {
    if (isCleanupOnlyTask(taskCallback, context)) return "suggestion";
    const delay = numericTaskDelay(call, context);
    if (delay !== null && delay <= 0.25) return "suggestion";
  }
  return "warning";
}

function cleanupHelp(resources: Resource[], details: string[]): string {
  const labels = new Set(resources.map((resource) => resource.label));
  let action: string;

  if (resources.every((resource) => resource.label.includes("task"))) {
    action = "Cancel the task in returned cleanup if it must stop with the effect.";
  } else if (labels.size === 1 && labels.has("connection/subscription")) {
    action = "Disconnect the connection in returned cleanup, or hand it to a cleanup manager.";
  } else if (labels.size === 1 && [...labels][0]?.endsWith(" connection")) {
    action = "Disconnect the returned connection in cleanup.";
  } else if (labels.size === 1 && labels.has("RenderStep binding")) {
    action = "Call UnbindFromRenderStep with the same binding name in cleanup.";
  } else if (labels.size === 1 && labels.has("ContextAction binding")) {
    action = "Call UnbindAction with the same action name in cleanup.";
  } else if (labels.size === 1 && labels.has("ContextAction activation binding")) {
    action = "Call UnbindActivate with the same input type in cleanup.";
  } else if (labels.size === 1 && labels.has("React root")) {
    action = "Unmount the root in cleanup.";
  } else {
    action = "Release the owned resources in returned cleanup.";
  }

  return `${details.length > 0 ? `${details.join(" ")} ` : ""}${action}`;
}

function cleanupFixPreview(resources: Resource[], context: RuleContext): FixPreview | undefined {
  const labels = new Set(resources.map((resource) => resource.label));
  const first = resources[0];
  if (!first) return undefined;

  if (labels.size === 1 && labels.has("RenderStep binding")) {
    const bindingName = context.callArguments(first.call)[0]?.text.trim() ?? '"RenderStepName"';
    return {
      kind: "pattern",
      before: `RunService:BindToRenderStep(${bindingName}, priority, onStep)`,
      after: `RunService:BindToRenderStep(${bindingName}, priority, onStep)

return function()
	RunService:UnbindFromRenderStep(${bindingName})
end`,
      note: "Unbind the same RenderStep name when the effect reruns or unmounts.",
    };
  }

  if ([...labels].every((label) => label.includes("task"))) {
    const path = context.resolveCallPath(context.getCallPath(first.call) ?? "task.delay");
    const taskCall = path === "task.defer"
      ? `task.defer(function()
	doWork()
end)`
      : path === "task.spawn"
        ? `task.spawn(function()
	doWork()
end)`
        : `task.delay(delaySeconds, function()
	doWork()
end)`;
    return {
      kind: "pattern",
      before: taskCall,
      after: `local thread = ${taskCall}

return function()
	task.cancel(thread)
end`,
      note: "Cancel scheduled work only when it must not outlive this effect. Short fire-and-forget work may intentionally remain uncancelled.",
    };
  }

  if (labels.size === 1 && labels.has("ContextAction binding")) {
    return {
      kind: "pattern",
      before: `ContextActionService:BindAction(actionName, onAction, false, inputType)`,
      after: `ContextActionService:BindAction(actionName, onAction, false, inputType)

return function()
	ContextActionService:UnbindAction(actionName)
end`,
      note: "Unbind the same action name in the effect cleanup.",
    };
  }

  if (labels.size === 1 && labels.has("React root")) {
    return {
      kind: "pattern",
      before: `local root = ReactRoblox.createRoot(container)`,
      after: `local root = ReactRoblox.createRoot(container)

return function()
	root:unmount()
end`,
      note: "Unmount roots created by the effect when ownership ends.",
    };
  }

  return {
    kind: "pattern",
    before: `local connection = signal:Connect(onChanged)`,
    after: `local connection = signal:Connect(onChanged)

return function()
	connection:Disconnect()
end`,
    note: "Return cleanup from the same effect that acquires the resource.",
  };
}

function classifyResource(call: SyntaxNode, context: RuleContext, callback: FunctionInfo): Resource | null {
  const rawPath = context.getCallPath(call) ?? "";
  const path = context.resolveCallPath(rawPath);
  const variable = assignedVariableName(call, callback);
  const finalMember = path.split(/[.:]/).at(-1) ?? path;

  if (/:Connect$/.test(rawPath)) {
    const ownerExpression = connectionOwnerExpression(rawPath);
    const ownerIsInstance = isProvenInstanceExpression(ownerExpression, call, context, callback);
    return {
      call,
      label: "connection/subscription",
      variable,
      cleanupMatches(text, name) {
        if (name && new RegExp(`\\b${escapeRegExp(name)}\\s*:\\s*Disconnect\\s*\\(`).test(text)) return true;
        if (name && cleanupIteratesAndDisconnects(text, name)) return true;
        // Custom Signal/Iris-style Connect APIs may return a disposer function instead of RBXScriptConnection.
        if (name && cleanupCallsDisposer(text, name)) return true;
        return Boolean(ownerIsInstance && ownerExpression && cleanupDestroysExpression(text, ownerExpression));
      },
    };
  }

  if (CONNECTION_RETURNING_METHODS.has(finalMember)) {
    return connectionResource(call, variable, `${finalMember} connection`);
  }

  if (/BindToRenderStep$/.test(rawPath)) {
    const bindingName = context.callArguments(call)[0]?.text.trim();
    return {
      call,
      label: "RenderStep binding",
      variable,
      cleanupMatches(text) {
        if (!/UnbindFromRenderStep\s*\(/.test(text)) return false;
        if (!bindingName) return true;
        return new RegExp(`UnbindFromRenderStep\\s*\\(\\s*${escapeRegExp(bindingName)}\\s*\\)`).test(text);
      },
    };
  }

  if (/:BindAction(?:AtPriority)?$/.test(rawPath)) {
    const actionName = context.callArguments(call)[0]?.text.trim();
    return {
      call,
      label: "ContextAction binding",
      variable,
      cleanupMatches(text) {
        if (/:UnbindAllActions\s*\(/.test(text)) return true;
        if (!/:UnbindAction\s*\(/.test(text)) return false;
        if (!actionName) return true;
        return new RegExp(`:UnbindAction\\s*\\(\\s*${escapeRegExp(actionName)}\\s*\\)`).test(text);
      },
    };
  }

  if (/:BindActivate$/.test(rawPath)) {
    const inputType = context.callArguments(call)[0]?.text.trim();
    return {
      call,
      label: "ContextAction activation binding",
      variable,
      cleanupMatches(text) {
        if (!/:UnbindActivate\s*\(/.test(text)) return false;
        if (!inputType) return true;
        return new RegExp(`:UnbindActivate\\s*\\(\\s*${escapeRegExp(inputType)}(?:\\s*,|\\s*\\))`).test(text);
      },
    };
  }

  if (path === "ReactRoblox.createRoot") {
    return {
      call,
      label: "React root",
      variable,
      cleanupMatches(text, name) {
        return Boolean(name && new RegExp(`\\b${escapeRegExp(name)}\\s*:\\s*unmount\\s*\\(`, "i").test(text));
      },
    };
  }

  if (path === "task.delay" || path === "task.defer" || path === "task.spawn") {
    const taskCallback = taskCallbackNode(call, context, callback);
    const yieldPoint = taskCallback ? functionYieldPoint(taskCallback, context) : null;
    const outlivesEffect = path !== "task.spawn" || Boolean(yieldPoint);
    if (!outlivesEffect) return null;

    return {
      call,
      label: path === "task.spawn" ? "yielding spawned task" : path === "task.defer" ? "deferred task" : "delayed task",
      detail: yieldPoint ? `The task can outlive the effect because it yields at ${yieldPoint.reason}.` : "The task is scheduled to run after the effect callback can finish.",
      severity: taskSeverity(path, call, taskCallback, yieldPoint, context),
      variable,
      cleanupMatches(text, name) {
        if (name) {
          const escaped = escapeRegExp(name);
          if (new RegExp(`task\\.cancel\\s*\\(\\s*${escaped}\\s*\\)`).test(text)) return true;
          if (new RegExp(`p?call\\s*\\(\\s*task\\.cancel\\s*,\\s*${escaped}\\s*\\)`).test(text)) return true;
        }
        return cancellationFlagMatches(taskCallback, text, callback);
      },
    };
  }

  return null;
}

export const effectNeedsCleanup: RuleDefinition = {
  id: "react-luau/effect-needs-cleanup",
  category: "Effects",
  severity: "warning",
  description: "Effects that create owned resources or outliving tasks should return matching cleanup.",
  run(context) {
    const diagnostics = [];

    for (const call of context.findCalls()) {
      const rawPath = context.getCallPath(call);
      if (!rawPath) continue;
      const path = context.resolveCallPath(rawPath);
      if (path !== "React.useEffect" && path !== "React.useLayoutEffect") continue;

      const callbackNode = firstFunctionArgument(context, call);
      const callback = functionInfoForNode(context, callbackNode);
      if (!callbackNode || !callback) continue;
      const cleanup = cleanupTexts(callback, context);
      const missing: Resource[] = [];

      for (const candidate of context.walk(callbackNode)) {
        if (candidate.type !== "function_call") continue;
        if (context.nearestFunction(candidate) !== callback) continue;
        if (isManagedByCleanupContainer(candidate, context, callback)) continue;
        const resource = classifyResource(candidate, context, callback);
        if (!resource) continue;
        if (cleanup.some((text) => resource.cleanupMatches(text, resource.variable, resource.call))) continue;
        missing.push(resource);
      }

      if (missing.length === 0) continue;
      const labels = [...new Set(missing.map((resource) => resource.label))];
      const details = [...new Set(missing.map((resource) => resource.detail).filter((detail): detail is string => Boolean(detail)))];
      const severityRank: Record<Severity, number> = { suggestion: 0, warning: 1, error: 2 };
      const severity = missing.reduce<Severity>(
        (highest, resource) => severityRank[resource.severity ?? "warning"] > severityRank[highest] ? resource.severity ?? "warning" : highest,
        "suggestion",
      );
      const highlights = missing.map((resource) => callNameNode(resource.call));
      diagnostics.push({
        node: highlights[0],
        highlights,
        severity,
        message: `Effect creates ${labels.join(", ")} without matching returned cleanup.`,
        help: cleanupHelp(missing, details),
        fixPreview: cleanupFixPreview(missing, context),
      });
    }

    return diagnostics;
  },
};
