import {
  DiagnosticSeverity,
  type Diagnostic,
  type Position,
  type Range,
} from "vscode-languageserver/node";

import { presentationFor } from "../presentation";
import type { Diagnostic as DoctorDiagnostic, Location } from "../types";

/** Doctor columns are one-based UTF-8 bytes. LSP characters are zero-based UTF-16 units. */
export class SourcePositions {
  private readonly lines: string[];

  constructor(source: string) {
    this.lines = source.split(/\r\n|\n|\r/);
  }

  position(line: number, column: number): Position {
    const index = Math.max(0, Math.min(this.lines.length - 1, line - 1));
    const text = this.lines[index] ?? "";
    const bytes = Math.max(0, column - 1);
    let consumed = 0;
    let character = 0;

    for (const point of text) {
      const width = Buffer.byteLength(point, "utf8");

      if (consumed + width > bytes) break;

      consumed += width;
      character += point.length;
    }

    return { line: index, character };
  }

  range(location: Location): Range {
    return {
      start: this.position(location.line, location.column),
      end: this.position(location.endLine, location.endColumn),
    };
  }
}

export function toLspDiagnostics(
  source: string,
  findings: readonly DoctorDiagnostic[],
): Diagnostic[] {
  const positions = new SourcePositions(source);

  return findings.flatMap((finding) => {
    const presentation = presentationFor(finding);

    const severity =
      finding.severity === "error"
        ? DiagnosticSeverity.Error
        : finding.severity === "warning"
          ? DiagnosticSeverity.Warning
          : DiagnosticSeverity.Hint;

    const ranges = finding.editorRanges ?? [{ location: finding.location }];

    return ranges.map(({ location, summary }) => ({
      range: positions.range(location),
      severity,
      code: finding.rule,
      source: "React-Luau Doctor",
      message: summary ?? presentation.summary,
      data: { ...presentation, summary: summary ?? presentation.summary },
    }));
  });
}
