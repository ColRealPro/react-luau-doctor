import type { SyntaxNode } from "../syntax";
import type { RuleContext, RuleDefinition } from "../types";
import { sameNode } from "../ast/walk";
import { fieldName, fieldNameNode, fieldValue } from "./helpers";

function staticString(node: SyntaxNode): boolean {
  if (node.type === "string") {
    return !node.namedChildren.some((child) => child.type === "interpolation");
  }
  if (node.type === "parenthesized_expression") {
    const expression = node.namedChildren[0];
    return Boolean(expression && staticString(expression));
  }
  if (node.type === "binary_expression" && node.children.some((child) => child.type === "..")) {
    return node.namedChildren.length === 2 && node.namedChildren.every(staticString);
  }
  return false;
}

function isNameField(field: SyntaxNode): boolean {
  if (fieldName(field) === "Name") return true;
  const name = field.childForFieldName("name");
  return Boolean(name?.type === "string" && /^["']Name["']$/.test(name.text) && field.text.trimStart().startsWith("["));
}

function isNamedChild(call: SyntaxNode, context: RuleContext): boolean {
  const field = call.parent;
  if (field?.type !== "field" || !sameNode(fieldValue(field), call)) return false;
  const key = field.childForFieldName("name");
  if (key?.type !== "identifier" && !(key?.type === "string" && staticString(key))) return false;
  const children = field.parent;
  const parentCall = children?.parent?.type === "arguments" ? children.parent.parent : null;
  if (children?.type !== "table_constructor" || parentCall?.type !== "function_call") return false;
  if (context.resolveCallPath(context.getCallPath(parentCall) ?? "") !== "React.createElement") return false;
  return sameNode(context.callArguments(parentCall)[2], children);
}

export const noStaticNameProp: RuleDefinition = {
  id: "react-luau/no-static-name-prop",
  category: "Correctness",
  severity: "warning",
  description: "Name Roblox instance children through their table keys instead of a static Name prop.",
  run(context) {
    const diagnostics = [];

    for (const call of context.findCalls()) {
      if (context.resolveCallPath(context.getCallPath(call) ?? "") !== "React.createElement") continue;
      const [element, props] = context.callArguments(call);
      if (element?.type !== "string" || !staticString(element) || props?.type !== "table_constructor" || !isNamedChild(call, context)) continue;

      for (const field of props.namedChildren) {
        if (field.type !== "field" || !isNameField(field)) continue;
        const value = fieldValue(field);
        if (!value || !staticString(value)) continue;

        diagnostics.push({
          node: fieldNameNode(field),
          message: "Static Name prop on a Roblox instance can be expressed as the child table key.",
          help: "Use the key in the parent's children table as this instance's name. Keep the Name prop when the instance name must change dynamically.",
        });
      }
    }

    return diagnostics;
  },
};
