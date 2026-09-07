import type { SyntaxNode } from "../syntax";
import type { DiagnosticInput, FunctionInfo, RuleContext, RuleDefinition } from "../types";
import { normalizeExpressionText, sameNode } from "../ast/walk";
import { assignmentLeft, assignmentTargetNode, declarationNames, isBindingShadowedBetween } from "./helpers";

function refRootFromTarget(target: string, refs: Set<string>): string | null {
  const match = target.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*current\b/);
  if (!match || !refs.has(match[1])) return null;
  return match[1];
}

function isNilGuardedLazyInit(node: SyntaxNode, refName: string): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === "if_statement") {
      const condition = current.childForFieldName("condition")?.text.replace(/\s+/g, "") ?? "";
      const escaped = refName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`^(?:${escaped}\.current==nil|nil==${escaped}\.current)$`).test(condition)) return true;
      return false;
    }
    if (current.type === "function_definition" || current.type === "function_declaration") return false;
    current = current.parent;
  }
  return false;
}

function assignmentRight(text: string): string | null {
  const match = text.match(/^(?:.*?)(?:\+=|-=|\*=|\/=|%=|\^=|\.\.=|=)\s*(.+)$/s);
  return match?.[1]?.trim() ?? null;
}

function refDeclaration(owner: FunctionInfo, refName: string, context: RuleContext): SyntaxNode | null {
  if (!owner.body) return null;
  for (const statement of owner.body.namedChildren) {
    if (statement.type !== "variable_declaration") continue;
    const names = declarationNames(statement);
    const index = names.indexOf(refName);
    if (index === -1) continue;
    const assignment = statement.namedChildren.find((child) => child.type === "assignment_statement");
    const expressions = assignment?.namedChildren.find((child) => child.type === "expression_list")?.namedChildren ?? [];
    const expression = expressions[index] ?? expressions[0];
    if (!expression || expression.type !== "function_call") continue;
    if (context.resolveCallPath(context.getCallPath(expression) ?? "") === "React.useRef") return statement;
  }
  return null;
}

function refInitializer(owner: FunctionInfo, refName: string, context: RuleContext): string | null {
  if (!owner.body) return null;
  for (const statement of owner.body.namedChildren) {
    if (statement.type !== "variable_declaration") continue;
    const names = declarationNames(statement);
    const index = names.indexOf(refName);
    if (index === -1) continue;
    const assignment = statement.namedChildren.find((child) => child.type === "assignment_statement");
    const expressions = assignment?.namedChildren.find((child) => child.type === "expression_list")?.namedChildren ?? [];
    const expression = expressions[index] ?? expressions[0];
    if (!expression || expression.type !== "function_call") return null;
    const path = context.resolveCallPath(context.getCallPath(expression) ?? "");
    if (path !== "React.useRef") return null;
    return context.callArguments(expression)[0]?.text.trim() ?? "nil";
  }
  return null;
}

function isTopLevelOwnerStatement(node: SyntaxNode, owner: FunctionInfo): boolean {
  let current = node.parent;
  while (current && !sameNode(current, owner.node)) {
    if (current.type === "if_statement" || current.type === "for_statement" || current.type === "while_statement" || current.type === "repeat_statement") {
      return false;
    }
    if (current.type === "function_definition" || current.type === "function_declaration") return false;
    current = current.parent;
  }
  return Boolean(current);
}


function exactRefCurrentTarget(node: SyntaxNode, refName: string): boolean {
  return normalizeExpressionText(assignmentLeft(node.text)) === `${refName}.current`;
}

function hasDirectRenderRead(owner: FunctionInfo, refName: string, context: RuleContext): boolean {
  if (!owner.body) return false;
  const target = `${refName}.current`;

  for (const candidate of context.walk(owner.body)) {
    if (candidate.type !== "dot_index_expression" || normalizeExpressionText(candidate.text) !== target) continue;
    if (!context.isDirectlyExecutedInFunction(candidate, owner)) continue;

    let current: SyntaxNode | null = candidate.parent;
    let isWrite = false;
    while (current && !sameNode(current, owner.node)) {
      if (current.type === "assignment_statement" || current.type === "update_statement") {
        isWrite = exactRefCurrentTarget(current, refName);
        break;
      }
      if (current.type === "function_definition" || current.type === "function_declaration") break;
      current = current.parent;
    }
    if (!isWrite) return true;
  }

  return false;
}

function isLatestValueMirror(node: SyntaxNode, owner: FunctionInfo, refName: string, context: RuleContext): boolean {
  if (node.type !== "assignment_statement" || !exactRefCurrentTarget(node, refName)) return false;
  const right = assignmentRight(node.text);
  if (!right) return false;

  const initializer = refInitializer(owner, refName, context);
  if (initializer !== null && normalizeExpressionText(right) === normalizeExpressionText(initializer)) return true;

  // A direct top-level `ref.current = renderValue` is the common use-latest
  // mirror pattern even when the ref used a neutral initial value such as false.
  // Nested writes remain warnings because they are usually imperative render work.
  if (isTopLevelOwnerStatement(node, owner)) {
    return /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(normalizeExpressionText(right));
  }

  // A render-computed ref that is only written during render and read later by
  // effects/events is another use-latest mirror shape. The conditional/looped
  // write can still observe a pre-commit render, so keep it visible as a
  // suggestion rather than treating it as fully safe.
  return !hasDirectRenderRead(owner, refName, context);
}

export const noRefCurrentInRender: RuleDefinition = {
  id: "react-luau/no-ref-current-in-render",
  category: "Correctness",
  severity: "warning",
  description: "Avoid mutating ref.current during render except for predictable initialization or deliberate latest-value mirrors.",
  run(context) {
    const diagnostics: DiagnosticInput[] = [];

    for (const node of context.walk()) {
      if (node.type !== "assignment_statement" && node.type !== "update_statement") continue;
      const owner = context.nearestFunction(node);
      if (!owner || (!owner.isComponent && !owner.isHook)) continue;
      if (!context.isDirectlyExecutedInFunction(node, owner)) continue;
      const refs = context.model.refVariablesByFunction.get(owner.node.id) ?? new Set<string>();
      const target = assignmentLeft(node.text);
      const refName = refRootFromTarget(target, refs);
      if (!refName || isNilGuardedLazyInit(node, refName)) continue;
      const declaration = refDeclaration(owner, refName, context);
      if (isBindingShadowedBetween(node, owner, refName, declaration)) continue;

      const latestValueMirror = isLatestValueMirror(node, owner, refName, context);
      diagnostics.push({
        node: assignmentTargetNode(node),
        severity: latestValueMirror ? "suggestion" : "warning",
        message: latestValueMirror
          ? `${refName}.current mirrors its latest render value during render.`
          : `${refName}.current is mutated during ${owner.isHook ? "hook" : "component"} render.`,
        help: latestValueMirror
          ? "A latest-value ref can expose an uncommitted render value to imperative callbacks. Update it after commit when that distinction matters."
          : "Move ref writes into the event, effect, or ref callback that owns the mutation. A nil-guarded one-time lazy initialization pattern remains allowed for pure construction.",
      });
    }

    return diagnostics;
  },
};
