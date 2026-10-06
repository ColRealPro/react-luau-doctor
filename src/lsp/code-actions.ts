import {
  CodeActionKind, type CodeAction, type Diagnostic, type Range,
} from "vscode-languageserver/node";
import { rulesById } from "../rules";
import { parseLuau } from "../parser";
import type { SyntaxNode } from "../syntax";
import type { EditorDiagnosticData } from "./positions";

function compare(left: Range["start"], right: Range["start"]): number {
  return left.line - right.line || left.character - right.character;
}

export async function diagnosticCodeActions(
  uri: string,
  version: number,
  source: string,
  diagnostics: readonly Diagnostic[],
  range: Range,
  respectInlineDisables = true,
): Promise<CodeAction[]> {
  const selected = diagnostics.filter((item) =>
    compare(item.range.start, range.end) <= 0 &&
    (compare(range.start, range.end) === 0
      ? compare(range.start, item.range.end) < 0
      : compare(range.start, item.range.end) <= 0),
  );

  if (selected.length === 0) return [];

  const actions: CodeAction[] = [];
  const seen = new Set<string>();
  const explained = new Set<string>();
  const lines = source.split(/\r\n|\n|\r/);
  const eol = source.match(/\r\n|\n|\r/)?.[0] ?? "\n";
  const tree = respectInlineDisables ? await parseLuau(source) : undefined;

  try {
    for (const diagnostic of selected) {
      const rule = String(diagnostic.code);

      if (!rulesById.has(rule)) continue;

      const line = (diagnostic.data as EditorDiagnosticData | undefined)
        ?.suppressionLine ?? diagnostic.range.start.line;
      const key = `${rule}:${line}`;

      const finding = (diagnostic.data as EditorDiagnosticData | undefined)?.finding;
      if (finding && !explained.has(finding.id)) {
        explained.add(finding.id);
        actions.push({
          title: `Explain ${rule.replace(/^react-luau\//, "")}`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          command: {
            title: "Explain rule",
            command: "reactLuauDoctor.explainRule",
            arguments: [{ uri, version, findingId: finding.id }],
          },
        });
      }

      if (seen.has(key)) continue;
      seen.add(key);

      if (!tree || tree.rootNode.hasError || !lines[line]) continue;

      // Inserting a comment inside a multiline token would change program data
      const crossesLine = (node: SyntaxNode): boolean => {
        if (node.startPosition.row >= line || node.endPosition.row < line)
          return false;
        if (node.type === "string" || node.type === "comment") return true;
        return node.namedChildren.some(crossesLine);
      };

      if (crossesLine(tree.rootNode)) continue;

      const previous = lines[line - 1];
      const directive = previous?.match(
        /^(\s*--\s*react-luau-doctor-disable-next-line\b)(.*?)(\s*--.*)?$/i,
      );
      let editRange: Range;
      let newText: string;

      if (directive) {
        const tokens = directive[2]!.trim();

        if (!tokens || tokens.split(/[\s,]+/).some((token) =>
          token === "all" || token === "*" || token === rule ||
          `react-luau/${token}` === rule,
        )) continue;

        editRange = {
          start: { line: line - 1, character: 0 },
          end: { line: line - 1, character: previous!.length },
        };
        newText = `${directive[1]} ${tokens}, ${rule}${directive[3] ?? ""}`;
      } else {
        const character = line === 0 && source.startsWith("\uFEFF") ? 1 : 0;
        editRange = { start: { line, character }, end: { line, character } };
        const indent = lines[line]!.match(/^[\t ]*/)?.[0] ?? "";
        newText = `${indent}-- react-luau-doctor-disable-next-line ${rule}${eol}`;
      }

      actions.push({
        title: `Suppress ${rule.replace(/^react-luau\//, "")} for this line`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        edit: {
          documentChanges: [{
            textDocument: { uri, version },
            edits: [{ range: editRange, newText }],
          }],
        },
      });
    }
  } finally {
    tree?.delete?.();
  }

  return actions;
}
