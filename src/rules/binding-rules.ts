import { reactApiPath, resolveLocalValue } from "../ast/local-values";
import { normalizeExpressionText } from "../ast/walk";
import type { SyntaxNode } from "../syntax";
import type { RuleContext, RuleDefinition } from "../types";
import { callNameNode } from "./helpers";

function isBinding(
  context: RuleContext,
  expression: SyntaxNode,
  seen = new Set<number>(),
): boolean {
  if (seen.has(expression.id)) return false;

  seen.add(expression.id);
  const resolved = resolveLocalValue(context, expression);

  if (
    !resolved ||
    resolved.returnIndex !== 0 ||
    resolved.value.type !== "function_call"
  )
    return false;

  if (
    ["React.useBinding", "React.createBinding", "React.joinBindings"].includes(
      reactApiPath(context, resolved.value) ?? "",
    )
  )
    return true;

  const name = resolved.value.childForFieldName("name");

  return (
    name?.type === "method_index_expression" &&
    name.namedChildren.at(-1)?.text === "map" &&
    Boolean(
      name.namedChildren[0] && isBinding(context, name.namedChildren[0], seen),
    )
  );
}

function isLazyRefInitialization(
  context: RuleContext,
  call: SyntaxNode,
): boolean {
  let node = call.parent;

  while (
    node &&
    !["function_definition", "function_declaration"].includes(node.type)
  ) {
    if (node.type === "if_statement") {
      const condition = node.childForFieldName("condition");
      const text = condition && normalizeExpressionText(condition.text);

      const match = text?.match(
        /^(?:([A-Za-z_]\w*)\.current==nil|nil==([A-Za-z_]\w*)\.current)$/,
      );

      if (!match) return false;

      const refName = match[1] ?? match[2];

      const ref =
        condition &&
        [...context.walk(condition)].find(
          (child) => child.type === "identifier" && child.text === refName,
        );

      const resolved = ref && resolveLocalValue(context, ref);

      if (!resolved || reactApiPath(context, resolved.value) !== "React.useRef")
        return false;

      let assignment = call.parent;

      while (assignment && assignment.id !== node.id) {
        if (assignment.type === "assignment_statement") {
          const target = assignment.namedChildren.find(
            (child) => child.type === "variable_list",
          )?.namedChildren[0];

          const thenBlock = node.namedChildren.find(
            (child) => child.type === "block",
          );

          return Boolean(
            target &&
            normalizeExpressionText(target.text) === `${refName}.current` &&
            thenBlock &&
            call.startIndex >= thenBlock.startIndex &&
            call.endIndex <= thenBlock.endIndex,
          );
        }

        assignment = assignment.parent;
      }

      return false;
    }

    node = node.parent;
  }

  return false;
}

const hookInitializerArguments = new Map([
  ["React.useRef", 0],
  ["React.useState", 0],
  ["React.useBinding", 0],
  ["React.useReducer", 1],
]);

function isHookInitializer(context: RuleContext, call: SyntaxNode): boolean {
  let node = call;

  while (node.parent) {
    const parent = node.parent;

    if (["function_definition", "function_declaration"].includes(parent.type))
      return false;

    if (parent.type === "arguments") {
      const hook = parent.parent;

      if (hook?.type === "function_call") {
        const argumentIndex = hookInitializerArguments.get(
          reactApiPath(context, hook) ?? "",
        );

        if (
          argumentIndex !== undefined &&
          context.callArguments(hook)[argumentIndex]?.id === node.id
        )
          return true;
      }
    }

    node = parent;
  }

  return false;
}

export const noCreateBindingInRender: RuleDefinition = {
  id: "react-luau/no-create-binding-in-render",
  category: "Correctness",
  severity: "warning",
  description: "Preserve binding identity across function component renders",

  guidance: {
    explanation:
      "React.createBinding creates a new binding and initial value on every render",

    help: "Use React.useBinding to preserve the binding and updater across renders",
  },

  run(context) {
    return context.findCalls().flatMap((call) => {
      const owner = context.nearestFunction(call);

      if (
        !owner ||
        (!owner.isComponent && !owner.isHook) ||
        reactApiPath(context, call) !== "React.createBinding" ||
        isLazyRefInitialization(context, call)
      )
        return [];

      return [
        {
          node: callNameNode(call),
          message: "React.createBinding creates a new binding on every render",
          help: "Use React.useBinding so rerenders preserve the binding and its current value",
        },
      ];
    });
  },
};

export const noBindingGetValueInRender: RuleDefinition = {
  id: "react-luau/no-binding-getvalue-in-render",
  category: "Correctness",
  severity: "warning",
  description:
    "Do not read binding snapshots during render except in hook initialization arguments",

  guidance: {
    explanation:
      "getValue returns a snapshot without subscribing — later binding updates do not rerender the component or update props built from that snapshot",

    help: "Pass the binding directly to the prop or use binding:map(function(value) return ... end)",
    caveat:
      "Snapshots in the first argument to React.useRef, React.useState, or React.useBinding, or the second argument to React.useReducer, are allowed because those arguments are used only for initialization",
  },

  run(context) {
    return context.findCalls().flatMap((call) => {
      const owner = context.nearestFunction(call);
      const name = call.childForFieldName("name");
      const receiver = name?.namedChildren[0];

      if (
        !owner ||
        (!owner.isComponent && !owner.isHook) ||
        name?.type !== "method_index_expression" ||
        name.namedChildren.at(-1)?.text !== "getValue" ||
        !receiver ||
        !isBinding(context, receiver) ||
        isHookInitializer(context, call)
      )
        return [];

      return [
        {
          node: name,
          message: `${receiver.text}:getValue() reads a binding snapshot during render`,
          help: "Pass the binding itself or map it so the prop subscribes to binding updates",
        },
      ];
    });
  },
};
