import type { FunctionInfo, RuleContext, RuleDefinition } from "../types";

function enclosingComponent(context: RuleContext, candidate: FunctionInfo): FunctionInfo | null {
  let current = candidate.node.parent;
  while (current) {
    const info = context.model.functionByNode.get(`${current.type}:${current.startIndex}:${current.endIndex}`);
    if (info?.isComponent) return info;
    current = current.parent;
  }
  return null;
}

function isRenderedBy(context: RuleContext, component: FunctionInfo, name: string): boolean {
  if (!component.body) return false;
  for (const call of context.walk(component.body)) {
    if (call.type !== "function_call") continue;
    if (context.nearestFunction(call) !== component) continue;
    const path = context.resolveCallPath(context.getCallPath(call) ?? "");
    if (path !== "React.createElement") continue;
    if (context.callArguments(call)[0]?.text.trim() === name) return true;
  }
  return false;
}


function componentNameNode(context: RuleContext, candidate: FunctionInfo): FunctionInfo["node"] {
  const direct = candidate.node.childForFieldName("name");
  if (direct) return direct;
  let current = candidate.node.parent;
  while (current && current.type !== "variable_declaration" && current.type !== "function_declaration") current = current.parent;
  if (current) {
    const identifier = [...context.walk(current)].find((node) =>
      node.type === "identifier" && node.text === candidate.name && node.startIndex < candidate.node.startIndex
    );
    if (identifier) return identifier;
  }
  return candidate.node;
}

export const noNestedComponentDefinition: RuleDefinition = {
  id: "react-luau/no-nested-component-definition",
  category: "Architecture",
  severity: "warning",
  description: "Do not define rendered component types inside another component.",
  run(context) {
    const diagnostics = [];

    for (const candidate of context.model.functions) {
      if (!candidate.isComponent || !candidate.name || !/^[A-Z]/.test(candidate.name)) continue;
      const parent = enclosingComponent(context, candidate);
      if (!parent || !isRenderedBy(context, parent, candidate.name)) continue;

      diagnostics.push({
        node: componentNameNode(context, candidate),
        message: `${candidate.name} is defined inside ${parent.name ?? "another component"} and rendered as a component type.`,
        help: "Move the nested component to module scope. Recreating a component type on each parent render can remount it and discard its local state.",
      });
    }

    return diagnostics;
  },
};
