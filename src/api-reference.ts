import type { SyntaxNode } from "./syntax";
import type { RuleContext } from "./types";
import {
  isUnboundIdentifier,
  localValueBinding,
  unwrapExpression,
} from "./ast/local-values";

export interface ApiFunctionReference {
  returnType: string;
  allocation: "new" | "argument";
  equality: "reference" | "value" | "unknown";
  argumentIndex?: number;
}

// Return types alone do not describe equality or allocation
// Keep these reviewed facts offline so editor diagnostics are deterministic
// Sources: https://github.com/Roblox/creator-docs/tree/main/content/en-us/reference/engine
//          https://github.com/Roblox/react-luau/blob/main/modules/shared/src/objectIs.lua
const functions = new Map<string, ApiFunctionReference>();

function register(
  namespace: string,
  members: string[],
  reference: ApiFunctionReference,
): void {
  for (const member of members)
    functions.set(`${namespace}.${member}`, reference);
}

for (const type of [
  "Instance",
  "Random",
  "RaycastParams",
  "OverlapParams",
  "CatalogSearchParams",
  "SharedTable",
]) {
  register(type, ["new"], {
    returnType: type,
    allocation: "new",
    equality: "reference",
  });
}

register("table", ["clone", "create", "pack"], {
  returnType: "table",
  allocation: "new",
  equality: "reference",
});
register("SharedTable", ["clone", "cloneAndFreeze"], {
  returnType: "SharedTable",
  allocation: "new",
  equality: "reference",
});
register("string", ["split"], {
  returnType: "table",
  allocation: "new",
  equality: "reference",
});
register("buffer", ["create", "fromstring"], {
  returnType: "buffer",
  allocation: "new",
  equality: "reference",
});
register("coroutine", ["create"], {
  returnType: "thread",
  allocation: "new",
  equality: "reference",
});
register("coroutine", ["wrap"], {
  returnType: "function",
  allocation: "new",
  equality: "reference",
});
register("table", ["freeze"], {
  returnType: "table",
  allocation: "argument",
  equality: "reference",
  argumentIndex: 0,
});

for (const [type, members] of Object.entries({
  Color3: ["new", "fromRGB", "fromHSV", "fromHex"],
  ColorSequence: ["new"],
  ColorSequenceKeypoint: ["new"],
  NumberSequence: ["new"],
  NumberSequenceKeypoint: ["new"],
  NumberRange: ["new"],
  UDim: ["new"],
  UDim2: ["new", "fromScale", "fromOffset"],
  Vector2: ["new"],
  Vector3: ["new", "fromNormalId", "fromAxis"],
  CFrame: [
    "new",
    "Angles",
    "fromEulerAnglesXYZ",
    "fromEulerAnglesYXZ",
    "fromOrientation",
    "fromAxisAngle",
    "fromMatrix",
    "lookAt",
    "lookAlong",
  ],
  Rect: ["new"],
  BrickColor: ["new", "palette"],
})) {
  register(type, members, {
    returnType: type,
    allocation: "new",
    equality: "value",
  });
}

const instanceMethods = new Map<string, ApiFunctionReference>([
  ...["GetChildren", "GetDescendants", "GetAttributes", "GetTags"].map(
    (member): [string, ApiFunctionReference] => [
      member,
      { returnType: "table", allocation: "new", equality: "reference" },
    ],
  ),
  [
    "Clone",
    { returnType: "Instance", allocation: "new", equality: "reference" },
  ],
]);

export function apiFunctionReference(
  path: string,
): ApiFunctionReference | null {
  return functions.get(path) ?? null;
}

function globalPath(
  context: RuleContext,
  expression: SyntaxNode,
  seen = new Set<number>(),
): string | null {
  const node = unwrapExpression(expression);

  if (seen.has(node.id)) return null;

  seen.add(node.id);

  if (node.type === "identifier") {
    if (isUnboundIdentifier(context, node)) return node.text;

    const binding = localValueBinding(context, node);

    return binding?.returnIndex === 0
      ? globalPath(context, binding.value, seen)
      : null;
  }

  if (node.type !== "dot_index_expression") return null;

  const namespace = node.childForFieldName("table");
  const member = node.childForFieldName("field");
  const path = namespace && globalPath(context, namespace, seen);

  return path && member ? `${path}.${member.text}` : null;
}

function isInstanceReceiver(
  context: RuleContext,
  expression: SyntaxNode,
  seen = new Set<number>(),
): boolean {
  const node = unwrapExpression(expression);

  if (seen.has(node.id)) return false;

  seen.add(node.id);

  if (node.type === "identifier") {
    if (isUnboundIdentifier(context, node))
      return ["game", "workspace", "script"].includes(node.text);

    const binding = localValueBinding(context, node);

    return (
      binding?.returnIndex === 0 &&
      isInstanceReceiver(context, binding.value, seen)
    );
  }

  if (node.type === "dot_index_expression") {
    const receiver = node.childForFieldName("table");

    return Boolean(receiver && isInstanceReceiver(context, receiver, seen));
  }

  if (node.type !== "function_call") return false;

  const name = node.childForFieldName("name");

  if (!name) return false;

  if (globalPath(context, name) === "Instance.new") return true;

  if (name.type !== "method_index_expression") return false;

  const receiver = name.childForFieldName("table");
  const member = name.childForFieldName("method")?.text;

  return Boolean(
    receiver &&
    member &&
    [
      "GetService",
      "WaitForChild",
      "FindFirstChild",
      "FindFirstAncestor",
      "Clone",
    ].includes(member) &&
    isInstanceReceiver(context, receiver, seen),
  );
}

export function apiReferenceForCall(
  context: RuleContext,
  call: SyntaxNode,
): ApiFunctionReference | null {
  const name = call.childForFieldName("name");

  if (!name) return null;

  const path = globalPath(context, name);

  if (path) return apiFunctionReference(path);

  if (name.type !== "method_index_expression") return null;

  const receiver = name.childForFieldName("table");
  const member = name.childForFieldName("method")?.text;

  return receiver && member && isInstanceReceiver(context, receiver)
    ? (instanceMethods.get(member) ?? null)
    : null;
}
