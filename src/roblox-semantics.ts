import type { Node as SyntaxNode } from "web-tree-sitter";
import type { RuleContext } from "./types";

/**
 * Engine members that are documented/known to yield. The analyzer intentionally
 * matches exact member names instead of every `*Async` function so custom
 * promise-style APIs do not become false positives merely because of naming.
 */
const YIELDING_ENGINE_MEMBERS = new Set([
  "WaitForChild",
  "Wait",
  "GetAsync",
  "SetAsync",
  "UpdateAsync",
  "RemoveAsync",
  "IncrementAsync",
  "GetSortedAsync",
  "ListKeysAsync",
  "ListVersionsAsync",
  "GetVersionAsync",
  "PublishAsync",
  "SubscribeAsync",
  "RequestAsync",
  "PostAsync",
  "PreloadAsync",
  "ComputeAsync",
  "FilterStringAsync",
  "FilterStringForBroadcast",
  "FilterStringForPlayerAsync",
  "GetNonChatStringForBroadcastAsync",
  "GetNonChatStringForUserAsync",
  "GetChatForUserAsync",
  "AwardBadgeAsync",
  "UserHasBadgeAsync",
  "GetBadgeInfoAsync",
  "GetPolicyInfoForPlayerAsync",
  "GetTranslatorForPlayerAsync",
  "GetUserIdFromNameAsync",
  "GetNameFromUserIdAsync",
  "GetHumanoidDescriptionFromUserId",
  "GetHumanoidDescriptionFromOutfitId",
  "GetFriendsAsync",
  "GetUserThumbnailAsync",
  "GetUserInfosByUserIdsAsync",
  "GetGroupInfoAsync",
  "GetAlliesAsync",
  "GetEnemiesAsync",
  "GetGroupsAsync",
  "TeleportAsync",
  "ReserveServerAsync",
  "CreatePlaceAsync",
  "SavePlaceAsync",
  "LoadAsset",
  "LoadAssetVersion",
  "GetProductInfo",
  "CreateEditableImageAsync",
  "CreateEditableMeshAsync",
  "GetBundleDetailsAsync",
  "GetGamePlacesAsync",
  "GetDeveloperProductsAsync",
  "GetInventoryAsync",
  "GetItemDetailsAsync",
  "GetBatchItemDetailsAsync",
  "PromptCreateAssetAsync",
  "PromptImportAnimationClipFromVideoAsync",
  "GetAnimationClipAsync",
]);

const ROBLOX_MUTABLE_LEAFS = new Set([
  "AbsolutePosition",
  "AbsoluteRotation",
  "AbsoluteSize",
  "AssemblyAngularVelocity",
  "AssemblyLinearVelocity",
  "CFrame",
  "Changed",
  "ContentSize",
  "CurrentCamera",
  "Enabled",
  "FocusLost",
  "Focused",
  "Heartbeat",
  "InputBegan",
  "InputChanged",
  "InputEnded",
  "Parent",
  "Position",
  "PreRender",
  "PreSimulation",
  "RenderStepped",
  "Rotation",
  "Size",
  "Stepped",
  "TextBounds",
  "Value",
  "ViewportSize",
  "WorldCFrame",
  "WorldPosition",
  "X",
  "Y",
]);

const INSTANCE_FACTORY_MEMBERS = new Set([
  "Clone",
  "FindFirstAncestor",
  "FindFirstAncestorOfClass",
  "FindFirstAncestorWhichIsA",
  "FindFirstChild",
  "FindFirstChildOfClass",
  "FindFirstChildWhichIsA",
  "GetButton",
  "GetMouse",
  "GetService",
  "WaitForChild",
]);

export function finalCallMember(path: string): string {
  return path.split(/[.:]/).at(-1) ?? path;
}

function declarationInitializer(node: SyntaxNode, name: string): SyntaxNode | null | undefined {
  if (node.type !== "variable_declaration") return undefined;
  const assignment = node.namedChildren.find((child) => child.type === "assignment_statement");
  const variables = assignment?.namedChildren.find((child) => child.type === "variable_list")
    ?? node.namedChildren.find((child) => child.type === "variable_list");
  const expressions = assignment?.namedChildren.find((child) => child.type === "expression_list");
  const names = variables?.namedChildren.filter((child) => child.type === "identifier") ?? [];
  const index = names.findIndex((candidate) => candidate.text === name);
  if (index < 0) return undefined;
  return expressions?.namedChildren[index] ?? expressions?.namedChildren[0] ?? null;
}

function functionBindsName(node: SyntaxNode, name: string): boolean {
  if (node.type !== "function_definition" && node.type !== "function_declaration") return false;
  const parameters = node.childForFieldName("parameters");
  if (!parameters) return false;
  return parameters.namedChildren.some((parameter) =>
    parameter.namedChildren.some((child) => child.type === "identifier" && child.text === name)
      || (parameter.type === "identifier" && parameter.text === name)
  );
}

function loopBindsName(node: SyntaxNode, name: string): boolean {
  if (node.type !== "for_statement") return false;
  const header = node.text.split(/\bdo\b/s, 1)[0] ?? "";
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*for\\s+(?:${escaped}\\s*=|[^\\n]*\\b${escaped}\\b[^\\n]*\\bin\\b)`, "s").test(header);
}

function visibleInitializer(name: string, from: SyntaxNode, context: RuleContext): SyntaxNode | null | undefined {
  let current: SyntaxNode | null = from.parent;
  while (current) {
    if (current.type === "block" || current.id === context.root.id) {
      const children = current.namedChildren;
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child.startIndex >= from.startIndex) continue;
        const initializer = declarationInitializer(child, name);
        if (initializer !== undefined) return initializer;
        if (child.type === "function_declaration") {
          const declared = child.childForFieldName("name")?.text.replace(/\s+/g, "") ?? "";
          if (declared === name) return null;
        }
      }
    }
    if (functionBindsName(current, name) || loopBindsName(current, name)) return null;
    current = current.parent;
  }
  return undefined;
}

function expressionHasRobloxOrigin(
  expression: SyntaxNode | null | undefined,
  from: SyntaxNode,
  context: RuleContext,
  seen: Set<string>,
): boolean {
  if (!expression) return false;
  const normalized = expression.text.replace(/\s+/g, "");
  if (/^(?:game|workspace|script)(?:[.:]|$)/.test(normalized) || /^Instance\.new\(/.test(normalized)) return true;

  const root = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
  if (!root || root === "require" || seen.has(root)) return false;
  if (expression.type !== "identifier" && expression.type !== "function_call") return false;

  seen.add(root);
  return expressionHasRobloxOrigin(visibleInitializer(root, from, context), from, context, seen);
}

function hasRobloxReceiver(path: string, call: SyntaxNode, context: RuleContext): boolean {
  const normalized = path.replace(/\s+/g, "");
  if (/^(?:game|workspace|script)(?:[.:]|$)/.test(normalized)) return true;
  const root = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
  if (!root) return false;
  return expressionHasRobloxOrigin(visibleInitializer(root, call, context), call, context, new Set([root]));
}

const runServiceCallCache = new WeakMap<RuleContext, Map<number, boolean>>();
const runServiceExpressionCache = new WeakMap<RuleContext, Map<number, boolean>>();

function cachedNodeBoolean(
  cache: WeakMap<RuleContext, Map<number, boolean>>,
  context: RuleContext,
  node: SyntaxNode,
  compute: () => boolean,
): boolean {
  let entries = cache.get(context);
  if (!entries) {
    entries = new Map<number, boolean>();
    cache.set(context, entries);
  }
  const cached = entries.get(node.id);
  if (cached !== undefined) return cached;
  const value = compute();
  entries.set(node.id, value);
  return value;
}

const RUN_SERVICE_EVENTS = new Set([
  "RenderStepped",
  "Heartbeat",
  "Stepped",
  "PreRender",
  "PreSimulation",
  "PostSimulation",
]);

function expressionIsRunService(
  expression: SyntaxNode | null | undefined,
  from: SyntaxNode,
  context: RuleContext,
  seen: Set<string>,
): boolean {
  if (!expression) return false;
  const normalized = expression.text.replace(/\s+/g, "");
  if (/^game:GetService\(["']RunService["']\)$/.test(normalized)) return true;
  if (expression.type !== "identifier") return false;
  const name = expression.text;
  if (seen.has(name)) return false;
  seen.add(name);
  return expressionIsRunService(visibleInitializer(name, from, context), from, context, seen);
}

function rootIsRunService(root: string, from: SyntaxNode, context: RuleContext): boolean {
  if (root === "game") return false;
  return expressionIsRunService(visibleInitializer(root, from, context), from, context, new Set([root]));
}

export function isHighFrequencyRunServiceExpression(node: SyntaxNode, context: RuleContext): boolean {
  return cachedNodeBoolean(runServiceExpressionCache, context, node, () => {
    const normalized = node.text.replace(/\s+/g, "");
    if (/^game:GetService\(["']RunService["']\)\.(?:RenderStepped|Heartbeat|Stepped|PreRender|PreSimulation|PostSimulation)$/.test(normalized)) {
      return true;
    }
    const match = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)\.(RenderStepped|Heartbeat|Stepped|PreRender|PreSimulation|PostSimulation)$/);
    return Boolean(match && RUN_SERVICE_EVENTS.has(match[2]) && rootIsRunService(match[1], node, context));
  });
}

export function isHighFrequencyRunServiceCall(call: SyntaxNode, context: RuleContext): boolean {
  return cachedNodeBoolean(runServiceCallCache, context, call, () => {
    const normalized = (context.getCallPath(call) ?? "").replace(/\s+/g, "");
    const direct = call.text.replace(/\s+/g, "");
    if (/^game:GetService\(["']RunService["']\)(?:\.(?:RenderStepped|Heartbeat|Stepped|PreRender|PreSimulation|PostSimulation):Connect|:BindToRenderStep|:BindToSimulation)\(/.test(direct)) {
      return true;
    }

    const event = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)\.(RenderStepped|Heartbeat|Stepped|PreRender|PreSimulation|PostSimulation):Connect$/);
    if (event) return rootIsRunService(event[1], call, context);

    const bind = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*):(?:BindToRenderStep|BindToSimulation)$/);
    return Boolean(bind && rootIsRunService(bind[1], call, context));
  });
}

export function sourceHasHighFrequencyRunService(source: string): boolean {
  if (/game\s*:\s*GetService\s*\(\s*["']RunService["']\s*\)\s*(?:\.\s*(?:RenderStepped|Heartbeat|Stepped|PreRender|PreSimulation|PostSimulation)\s*:\s*Connect|:\s*(?:BindToRenderStep|BindToSimulation))/.test(source)) {
    return true;
  }

  const aliases = new Set<string>();
  for (const match of source.matchAll(/\blocal\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*game\s*:\s*GetService\s*\(\s*["']RunService["']\s*\)/g)) {
    aliases.add(match[1]);
  }
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\s*(?:\\.\\s*(?:RenderStepped|Heartbeat|Stepped|PreRender|PreSimulation|PostSimulation)\\s*:\\s*Connect|:\\s*(?:BindToRenderStep|BindToSimulation))`);
    if (pattern.test(source)) return true;
  }
  return false;
}

export function knownYieldReason(path: string, call?: SyntaxNode, context?: RuleContext): string | null {
  const normalized = path.replace(/\s+/g, "");
  if (normalized === "task.wait") return "task.wait";
  if (normalized === "coroutine.yield") return "coroutine.yield";

  const member = finalCallMember(normalized);
  if (!YIELDING_ENGINE_MEMBERS.has(member)) return null;
  if (!call || !context) return null;
  return hasRobloxReceiver(normalized, call, context) ? member : null;
}

export function functionYieldPoint(node: SyntaxNode, context: RuleContext): { call: SyntaxNode; reason: string } | null {
  for (const candidate of context.walk(node)) {
    if (candidate.type !== "function_call") continue;
    const nearest = context.nearestFunction(candidate);
    const owner = context.model.functionByNode.get(node.id);
    if (owner && nearest !== owner) continue;
    const path = context.resolveCallPath(context.getCallPath(candidate) ?? "");
    const reason = knownYieldReason(path, candidate, context);
    if (reason) return { call: candidate, reason };
  }
  return null;
}

export function isInstanceProducingExpression(node: SyntaxNode | undefined, context: RuleContext): boolean {
  if (!node) return false;

  const text = node.text.trim();
  if (/^(?:workspace|game|script)(?:\.|:|$)/.test(text)) return true;

  for (const candidate of context.walk(node)) {
    if (candidate.type !== "function_call") continue;
    const path = context.resolveCallPath(context.getCallPath(candidate) ?? "");
    if (path === "Instance.new") return true;
    if (INSTANCE_FACTORY_MEMBERS.has(finalCallMember(path))) return true;
  }

  return false;
}

export function mutableDependencyBase(path: string, externallyMutableRoots: Set<string>): string | null {
  const normalized = path.replace(/\s+/g, "");
  if (/\.current(?:\.|$)/.test(normalized)) return "";

  const segments = normalized.split(".");
  if (segments.length < 2) return null;

  if (externallyMutableRoots.has(segments[0])) return segments[0];

  const mutableIndex = segments.findIndex((segment, index) => index > 0 && ROBLOX_MUTABLE_LEAFS.has(segment));
  if (mutableIndex <= 0) return null;

  const ownerPath = segments.slice(0, mutableIndex).join(".");
  const mutableLeaf = segments[mutableIndex];
  const signalLike = /(?:Changed|Began|Ended|Focused|Heartbeat|Stepped|PreRender|PreSimulation)$/.test(mutableLeaf);
  const objectLike = /(?:instance|attachment|camera|mouse|frame|gui|part|value|humanoid|sound|tween|workspace|root|viewport)/i.test(ownerPath);
  return signalLike || objectLike ? ownerPath : null;
}
