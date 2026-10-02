import type { Diagnostic, Hover, Position } from "vscode-languageserver/node";
import type { ResolvedPresentation } from "../presentation";

function contains(diagnostic: Diagnostic, position: Position): boolean {
  const { start, end } = diagnostic.range;

  return (
    (position.line > start.line ||
      (position.line === start.line &&
        position.character >= start.character)) &&
    (position.line < end.line ||
      (position.line === end.line && position.character < end.character))
  );
}

function plainText(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+|>~]/g, "\\$&");
}

function codeBlock(source: string): string {
  const longest = Math.max(
    0,
    ...[...source.matchAll(/`+/g)].map(([ticks]) => ticks.length),
  );

  const fence = "`".repeat(Math.max(3, longest + 1));

  return `${fence}lua\n${source}\n${fence}`;
}

export function diagnosticHover(
  diagnostics: readonly Diagnostic[],
  position: Position,
): Hover | null {
  const diagnostic = diagnostics.find((item) => contains(item, position));

  if (!diagnostic) return null;

  const detail = diagnostic.data as ResolvedPresentation | undefined;

  if (!detail) return null;

  const code = String(diagnostic.code ?? "").replace(/^react-luau\//, "");

  const parts = [
    `**React-Luau Doctor** · \`${plainText(code)}\``,
    plainText(detail.summary),
  ];

  if (detail.help) {
    parts.push(`**How to fix**\n\n${plainText(detail.help)}`);
  }

  if (detail.example) {
    const title =
      detail.example.kind === "exact" ? "Suggested change" : "Example pattern";

    parts.push(
      `**${title}**`,
      `**Current**\n\n${codeBlock(detail.example.before)}`,
      `**Suggested**\n\n${codeBlock(detail.example.after)}`,
    );

    if (detail.example.note) {
      parts.push(plainText(detail.example.note));
    }
  }

  // if (detail.explanation !== detail.summary) {
  //   parts.push(plainText(detail.explanation));
  // }

  return {
    range: diagnostic.range,
    contents: { kind: "markdown", value: parts.join("\n\n") },
  };
}
