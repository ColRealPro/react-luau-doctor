import {
  resolveLocalFunction,
  resolveLocalValue,
  reactApiPath,
} from "../ast/local-values";

import type { SyntaxNode } from "../syntax";
import type { DiagnosticInput, RuleDefinition } from "../types";
import { assignmentTargetNode, callNameNode } from "./helpers";

import {
  mightMutateParameters,
  mutatedParameterIndexesForCall,
  mutationOriginForExpression,
} from "./parameter-mutations";

export const noMutatingStateUpdater: RuleDefinition = {
  id: "react-luau/no-mutating-state-updater",
  category: "Correctness",
  severity: "error",
  description: "Do not mutate previous state inside a state updater",

  guidance: {
    explanation:
      "An updater receives existing React state, including its nested tables — mutating it changes previous state and returning the same table can prevent an update",

    help: "Create a new table and copy any nested table you need to change before returning the new state",
  },

  run(context) {
    const diagnostics: DiagnosticInput[] = [];
    const seen = new Set<number>();

    for (const call of context.findCalls()) {
      const name = call.childForFieldName("name");
      const setter = name && resolveLocalValue(context, name);

      if (
        !setter ||
        setter.returnIndex !== 1 ||
        reactApiPath(context, setter.value) !== "React.useState"
      )
        continue;

      const argument = context.callArguments(call)[0];
      const updater = argument && resolveLocalFunction(context, argument);
      const previous = updater?.parameters[0];

      if (!updater?.body || !previous) continue;

      for (const node of context.walk(updater.body)) {
        if (seen.has(node.id)) continue;

        let targets: SyntaxNode[] = [];

        if (
          node.type === "assignment_statement" ||
          node.type === "update_statement"
        ) {
          const left = node.namedChildren.find(
            (child) => child.type === "variable_list",
          );

          targets = (
            left?.namedChildren ?? [assignmentTargetNode(node)]
          ).filter((target) =>
            ["dot_index_expression", "bracket_index_expression"].includes(
              target.type,
            ),
          );
        } else if (
          node.type === "function_call" &&
          mightMutateParameters(context, node)
        ) {
          const args = context.callArguments(node);

          targets = [
            ...mutatedParameterIndexesForCall(context, node, updater),
          ].flatMap((index) => (args[index] ? [args[index]] : []));
        }

        const mutated = targets.find((target) => {
          const value =
            node.type === "function_call" ? target : target.namedChildren[0];

          if (!value) return false;

          const origin = mutationOriginForExpression(context, value, updater);

          return origin.kind === "parameter" && origin.name === previous;
        });

        if (!mutated) continue;

        seen.add(node.id);

        diagnostics.push({
          node: node.type === "function_call" ? callNameNode(node) : mutated,
          message: `This updater mutates previous state through ${mutated.text}`,
          help: "Copy the table being changed and return new state — copying only the outer table does not copy nested tables",
        });
      }
    }

    return diagnostics;
  },
};
