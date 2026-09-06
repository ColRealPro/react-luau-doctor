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

export function knownYieldReason(path: string): string | null {
  const normalized = path.replace(/\s+/g, "");
  if (normalized === "task.wait") return "task.wait";
  if (normalized === "coroutine.yield") return "coroutine.yield";

  const member = finalCallMember(normalized);
  if (YIELDING_ENGINE_MEMBERS.has(member)) return member;
  return null;
}

export function functionYieldPoint(node: SyntaxNode, context: RuleContext): { call: SyntaxNode; reason: string } | null {
  for (const candidate of context.walk(node)) {
    if (candidate.type !== "function_call") continue;
    const nearest = context.nearestFunction(candidate);
    const owner = context.model.functionByNode.get(node.id);
    if (owner && nearest !== owner) continue;
    const path = context.resolveCallPath(context.getCallPath(candidate) ?? "");
    const reason = knownYieldReason(path);
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
