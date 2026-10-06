import { presentationFor } from "./presentation";
import { compactFixPreview, previewLineMatches } from "./fix-preview";
import { rulesById } from "./rules";
import type { Diagnostic, Severity } from "./types";

export const WHY_ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  magenta: "\u001b[35m",
};

function whyRgb(red: number, green: number, blue: number): string {
  return `\u001b[38;2;${red};${green};${blue}m`;
}

function whyBgRgb(red: number, green: number, blue: number): string {
  return `\u001b[48;2;${red};${green};${blue}m`;
}

// Close to VS Code's Dark+ semantic-token palette. Truecolor ANSI is supported by
// Windows Terminal, modern PowerShell terminals, and the terminals most people use
// to run the Doctor
export const WHY_THEME = {
  foreground: whyRgb(212, 212, 212),
  variable: whyRgb(156, 220, 254),
  function: whyRgb(220, 220, 170),
  string: whyRgb(206, 145, 120),
  number: whyRgb(181, 206, 168),
  comment: whyRgb(106, 153, 85),
  type: whyRgb(78, 201, 176),
  keyword: whyRgb(197, 134, 192),
  declarationKeyword: whyRgb(86, 156, 214),
  literal: whyRgb(86, 156, 214),
  property: whyRgb(156, 220, 254),
  section: whyRgb(78, 201, 176),
  category: whyRgb(79, 193, 255),
  gutter: whyRgb(96, 96, 96),
  activeGutter: whyRgb(244, 71, 71),
  addedBackground: whyBgRgb(36, 72, 48),
  removedBackground: whyBgRgb(82, 43, 47),
  addedLabelBackground: whyBgRgb(28, 83, 50),
  removedLabelBackground: whyBgRgb(103, 45, 50),
};

export function whyPaint(enabled: boolean, value: string, ...codes: string[]): string {
  if (!enabled || codes.length === 0) return value;

  return `${codes.join("")}${value}${WHY_ANSI.reset}`;
}

function whySeverityPaint(
  enabled: boolean,
  severity: Severity,
  value: string,
): string {
  if (severity === "error")
    return whyPaint(enabled, value, WHY_ANSI.bold, WHY_ANSI.red);

  if (severity === "warning")
    return whyPaint(enabled, value, WHY_ANSI.bold, WHY_ANSI.yellow);

  return whyPaint(enabled, value, WHY_ANSI.bold, WHY_ANSI.magenta);
}

export function whySectionTitle(enabled: boolean, value: string): string {
  return whyPaint(enabled, value, WHY_ANSI.bold, WHY_THEME.section);
}

const LUAU_CONTROL_KEYWORDS = new Set([
  "and",
  "break",
  "continue",
  "do",
  "else",
  "elseif",
  "end",
  "for",
  "if",
  "in",
  "not",
  "or",
  "repeat",
  "return",
  "then",
  "until",
  "while",
]);

const LUAU_DECLARATION_KEYWORDS = new Set([
  "export",
  "function",
  "local",
  "type",
]);

const LUAU_LITERAL_KEYWORDS = new Set(["false", "nil", "true"]);

type WhyLuauTokenKind =
  "whitespace" | "comment" | "string" | "number" | "identifier" | "operator";

interface WhyLuauToken {
  kind: WhyLuauTokenKind;
  text: string;
  start: number;
  end: number;
}

interface WhyCharacterRange {
  start: number;
  end: number;
}

function tokenizeWhyLuauLine(line: string): WhyLuauToken[] {
  const tokens: WhyLuauToken[] = [];
  let index = 0;

  const push = (kind: WhyLuauTokenKind, value: string, start: number): void => {
    tokens.push({ kind, text: value, start, end: start + value.length });
  };

  while (index < line.length) {
    const rest = line.slice(index);
    const ch = line[index];

    const whitespace = /^\s+/.exec(rest);

    if (whitespace) {
      push("whitespace", whitespace[0], index);
      index += whitespace[0].length;
      continue;
    }

    if (rest.startsWith("--")) {
      push("comment", rest, index);
      break;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      let tokenEnd = index + 1;

      while (tokenEnd < line.length) {
        if (line.charCodeAt(tokenEnd) === 92) {
          tokenEnd += 2;
          continue;
        }

        if (line[tokenEnd] === ch) {
          tokenEnd += 1;
          break;
        }

        tokenEnd += 1;
      }

      push("string", line.slice(index, tokenEnd), index);
      index = tokenEnd;
      continue;
    }

    if (rest.startsWith("[[")) {
      const close = line.indexOf("]]", index + 2);
      const tokenEnd = close >= 0 ? close + 2 : line.length;
      push("string", line.slice(index, tokenEnd), index);
      index = tokenEnd;
      continue;
    }

    const number =
      /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)/.exec(
        rest,
      );

    if (number) {
      push("number", number[0], index);
      index += number[0].length;
      continue;
    }

    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);

    if (identifier) {
      push("identifier", identifier[0], index);
      index += identifier[0].length;
      continue;
    }

    const operator =
      /^(?:\.\.\.|\.\.|==|~=|<=|>=|::|->|\+=|-=|\*=|\/=|%=|\^=|[+\-*\/%^#=<>:.,;()[\]{}])/.exec(
        rest,
      );

    const token = operator?.[0] ?? ch;
    push("operator", token, index);
    index += token.length;
  }

  return tokens;
}

function previousWhyToken(
  tokens: WhyLuauToken[],
  index: number,
): WhyLuauToken | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (tokens[cursor].kind !== "whitespace") return tokens[cursor];
  }

  return undefined;
}

function nextWhyToken(
  tokens: WhyLuauToken[],
  index: number,
): WhyLuauToken | undefined {
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    if (tokens[cursor].kind !== "whitespace") return tokens[cursor];
  }

  return undefined;
}

function whyIdentifierCodes(tokens: WhyLuauToken[], index: number): string[] {
  const value = tokens[index].text;

  if (LUAU_CONTROL_KEYWORDS.has(value))
    return [WHY_ANSI.bold, WHY_THEME.keyword];

  if (LUAU_DECLARATION_KEYWORDS.has(value))
    return [WHY_ANSI.bold, WHY_THEME.declarationKeyword];

  if (LUAU_LITERAL_KEYWORDS.has(value))
    return [WHY_ANSI.bold, WHY_THEME.literal];

  const previous = previousWhyToken(tokens, index);
  const next = nextWhyToken(tokens, index);
  const previousText = previous?.text;
  const nextText = next?.text;

  if (previousText === "function" || nextText === "(")
    return [WHY_THEME.function];

  if ((previousText === "." || previousText === ":") && nextText === "(")
    return [WHY_THEME.function];

  if (previousText === "type" || (previousText === ":" && nextText !== "("))
    return [WHY_THEME.type];

  if (previousText === "." || previousText === ":") return [WHY_THEME.property];

  if (/^[A-Z]/.test(value) && (nextText === "." || nextText === "<"))
    return [WHY_THEME.type];

  if (nextText === "=" && previousText !== "local") return [WHY_THEME.property];

  return [WHY_THEME.variable];
}

function whyTokenCodes(tokens: WhyLuauToken[], index: number): string[] {
  const token = tokens[index];

  if (token.kind === "comment") return [WHY_THEME.comment];

  if (token.kind === "string") return [WHY_THEME.string];

  if (token.kind === "number") return [WHY_THEME.number];

  if (token.kind === "identifier") return whyIdentifierCodes(tokens, index);

  if (token.kind === "operator") return [WHY_THEME.foreground];

  return [];
}

function whyRangeContains(
  ranges: WhyCharacterRange[],
  position: number,
): boolean {
  return ranges.some(
    (range) => position >= range.start && position < range.end,
  );
}

function highlightLuauLine(
  line: string,
  colorized: boolean,
  backgroundRanges: WhyCharacterRange[] = [],
  backgroundCode?: string,
): string {
  if (!colorized || !line) return line;

  const tokens = tokenizeWhyLuauLine(line);

  return tokens
    .map((token, index) => {
      const foreground = whyTokenCodes(tokens, index);
      const cuts = new Set<number>([token.start, token.end]);

      for (const range of backgroundRanges) {
        if (range.end <= token.start || range.start >= token.end) continue;

        cuts.add(Math.max(token.start, range.start));
        cuts.add(Math.min(token.end, range.end));
      }

      const points = [...cuts].sort((a, b) => a - b);
      const segments: string[] = [];

      for (let point = 0; point < points.length - 1; point += 1) {
        const segmentStart = points[point];
        const segmentEnd = points[point + 1];
        const value = line.slice(segmentStart, segmentEnd);

        const changed =
          Boolean(backgroundCode) &&
          whyRangeContains(backgroundRanges, segmentStart);

        if (foreground.length === 0 && !changed) segments.push(value);
        else
          segments.push(
            whyPaint(
              true,
              value,
              ...foreground,
              ...(changed && backgroundCode ? [backgroundCode] : []),
            ),
          );
      }

      return segments.join("");
    })
    .join("");
}

function changedCharacterRanges(
  before: string,
  after: string,
): { before: WhyCharacterRange[]; after: WhyCharacterRange[] } {
  if (before === after) return { before: [], after: [] };

  let prefix = 0;

  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  )
    prefix += 1;

  let suffix = 0;

  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix += 1;

  return {
    before:
      before.length - suffix > prefix
        ? [{ start: prefix, end: before.length - suffix }]
        : [],

    after:
      after.length - suffix > prefix
        ? [{ start: prefix, end: after.length - suffix }]
        : [],
  };
}

interface WhyPreviewDiff {
  beforeRanges: WhyCharacterRange[][];
  afterRanges: WhyCharacterRange[][];
}

function whyPreviewDiff(
  beforeLines: string[],
  afterLines: string[],
): WhyPreviewDiff {
  const matches = previewLineMatches(beforeLines, afterLines);

  const beforeRanges = beforeLines.map(() => [] as WhyCharacterRange[]);
  const afterRanges = afterLines.map(() => [] as WhyCharacterRange[]);

  const sentinels: Array<[number, number]> = [
    [-1, -1],
    ...matches,
    [beforeLines.length, afterLines.length],
  ];

  for (let matchIndex = 0; matchIndex < sentinels.length - 1; matchIndex += 1) {
    const [previousBefore, previousAfter] = sentinels[matchIndex];
    const [nextBefore, nextAfter] = sentinels[matchIndex + 1];
    const beforeStart = previousBefore + 1;
    const afterStart = previousAfter + 1;
    const beforeCount = nextBefore - beforeStart;
    const afterCount = nextAfter - afterStart;
    const paired = Math.min(beforeCount, afterCount);

    for (let offset = 0; offset < paired; offset += 1) {
      const left = beforeStart + offset;
      const right = afterStart + offset;

      const ranges = changedCharacterRanges(
        beforeLines[left],
        afterLines[right],
      );

      beforeRanges[left] = ranges.before;
      afterRanges[right] = ranges.after;
    }

    for (let offset = paired; offset < beforeCount; offset += 1) {
      const line = beforeStart + offset;

      beforeRanges[line] = [
        { start: 0, end: Math.max(1, beforeLines[line].length) },
      ];
    }

    for (let offset = paired; offset < afterCount; offset += 1) {
      const line = afterStart + offset;

      afterRanges[line] = [
        { start: 0, end: Math.max(1, afterLines[line].length) },
      ];
    }
  }

  return { beforeRanges, afterRanges };
}

function normalizeWhyPreviewLines(value: string): string[] {
  const lines = value.split(/\r?\n/).map((line) => expandWhyTabs(line));

  while (lines.length > 1 && lines[0].trim().length === 0) lines.shift();

  while (lines.length > 1 && lines.at(-1)?.trim().length === 0) lines.pop();

  if (lines.length <= 1) return lines;

  const indentation = (line: string): number =>
    line.match(/^ */)?.[0].length ?? 0;

  const nonBlank = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.trim().length > 0);

  if (nonBlank.length === 0) return lines;

  const firstIndent = indentation(nonBlank[0].line);

  if (firstIndent > 0) {
    const commonIndent = Math.min(
      ...nonBlank.map(({ line }) => indentation(line)),
    );

    return lines.map((line) =>
      line.trim().length === 0
        ? ""
        : line.slice(Math.min(commonIndent, indentation(line))),
    );
  }

  // Syntax-node text begins at the expression itself, so the first line has no
  // file indentation while continuation lines still include the source file's
  // tabs/spaces. Remove the continuation baseline, but preserve indentation
  // relative to that baseline for nested code inside the expression
  const continuation = nonBlank.filter(
    ({ index }) => index > nonBlank[0].index,
  );

  if (continuation.length === 0) return lines;

  const continuationBaseline = Math.min(
    ...continuation.map(({ line }) => indentation(line)),
  );

  if (continuationBaseline <= 0) return lines;

  return lines.map((line, index) => {
    if (index <= nonBlank[0].index || line.trim().length === 0) return line;

    return line.slice(Math.min(continuationBaseline, indentation(line)));
  });
}

export function renderWhyFixPreview(
  preview: { before: string; after: string; note?: string },
  colorized: boolean,
  textWidth: number,
): string[] {
  preview = compactFixPreview({
    ...preview,
    before: preview.before.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "?"),
    after: preview.after.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "?"),
  });

  const beforeLines = normalizeWhyPreviewLines(preview.before);
  const afterLines = normalizeWhyPreviewLines(preview.after);
  const diff = whyPreviewDiff(beforeLines, afterLines);

  const currentLabel = colorized
    ? whyPaint(
        true,
        " CURRENT ",
        WHY_ANSI.bold,
        WHY_THEME.foreground,
        WHY_THEME.removedLabelBackground,
      )
    : "CURRENT";

  const suggestedLabel = colorized
    ? whyPaint(
        true,
        " SUGGESTED ",
        WHY_ANSI.bold,
        WHY_THEME.foreground,
        WHY_THEME.addedLabelBackground,
      )
    : "SUGGESTED";

  const lines: string[] = [currentLabel];

  beforeLines.forEach((line, index) => {
    lines.push(
      `  ${highlightLuauLine(line, colorized, diff.beforeRanges[index], WHY_THEME.removedBackground)}`,
    );
  });

  lines.push("", suggestedLabel);

  afterLines.forEach((line, index) => {
    lines.push(
      `  ${highlightLuauLine(line, colorized, diff.afterRanges[index], WHY_THEME.addedBackground)}`,
    );
  });

  if (preview.note) {
    lines.push(
      "",
      ...wrapWhyWords(preview.note, textWidth).map((line) =>
        whyPaint(colorized, line, WHY_ANSI.dim),
      ),
    );
  }

  return lines;
}

export function wrapWhyWords(value: string, width: number): string[] {
  const safeWidth = Math.max(32, width);
  const paragraphs = value.split(/\r?\n/);
  const lines: string[] = [];

  for (
    let paragraphIndex = 0;
    paragraphIndex < paragraphs.length;
    paragraphIndex += 1
  ) {
    const paragraph = paragraphs[paragraphIndex].trim().replace(/\s+/g, " ");

    if (!paragraph) {
      lines.push("");
      continue;
    }

    let line = "";

    for (const word of paragraph.split(" ")) {
      if (!line) {
        line = word;
        continue;
      }

      if (line.length + 1 + word.length <= safeWidth) {
        line += ` ${word}`;
        continue;
      }

      lines.push(line);
      line = word;
    }

    if (line) lines.push(line);

    if (
      paragraphIndex < paragraphs.length - 1 &&
      paragraphs[paragraphIndex + 1].trim()
    )
      lines.push("");
  }

  return lines.length > 0 ? lines : [""];
}

function whyDiagnosticRanges(diagnostic: Diagnostic): Diagnostic["location"][] {
  return diagnostic.highlights && diagnostic.highlights.length > 0
    ? diagnostic.highlights
    : [diagnostic.location];
}

function expandWhyTabs(value: string, tabWidth = 4): string {
  let result = "";
  let column = 0;

  for (const character of value) {
    if (character === "\t") {
      const spaces = tabWidth - (column % tabWidth);
      result += " ".repeat(spaces);
      column += spaces;
    } else {
      result += character;
      column += 1;
    }
  }

  return result;
}

function whyVisualColumn(line: string, column: number): number {
  return expandWhyTabs(line.slice(0, Math.max(0, column - 1))).length + 1;
}

function whyFrameIntervals(
  ranges: Diagnostic["location"][],
  sourceLength: number,
): Array<{ start: number; end: number }> {
  const intervals = ranges
    .map((range) => ({
      start: Math.max(1, range.line - 2),
      end: Math.min(sourceLength, range.endLine + 2),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Array<{ start: number; end: number }> = [];

  for (const interval of intervals) {
    const previous = merged.at(-1);

    if (previous && interval.start <= previous.end + 1)
      previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }

  return merged;
}

function whyCaretForLine(
  sourceLine: string,
  line: number,
  ranges: Diagnostic["location"][],
): string | null {
  const expanded = expandWhyTabs(sourceLine);

  const marks = Array.from(
    { length: Math.max(1, expanded.length + 1) },
    () => false,
  );

  let hasMark = false;

  for (const range of ranges) {
    if (line < range.line || line > range.endLine) continue;

    const rawStart = line === range.line ? range.column : 1;

    const rawEnd =
      line === range.endLine ? range.endColumn : sourceLine.length + 1;

    const start = Math.max(1, whyVisualColumn(sourceLine, rawStart));
    const end = Math.max(start + 1, whyVisualColumn(sourceLine, rawEnd));

    for (
      let column = start - 1;
      column < Math.min(marks.length, end - 1);
      column += 1
    ) {
      marks[column] = true;
      hasMark = true;
    }
  }

  if (!hasMark) return null;

  let value = marks
    .map((marked) => (marked ? "^" : " "))
    .join("")
    .replace(/\s+$/, "");

  if (!value) value = "^";

  return value;
}

function renderWhyCodeFrame(
  sourceText: string,
  diagnostic: Diagnostic,
  colorized: boolean,
): string {
  const source = sourceText.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "?").split(/\r?\n/);
  const ranges = whyDiagnosticRanges(diagnostic);
  const intervals = whyFrameIntervals(ranges, source.length);

  const width = String(
    Math.max(...intervals.map((interval) => interval.end), 1),
  ).length;

  const lines: string[] = [];

  intervals.forEach((interval, intervalIndex) => {
    if (intervalIndex > 0) {
      lines.push(
        `${whyPaint(colorized, "…", WHY_ANSI.dim, WHY_THEME.gutter)} ${" ".repeat(width)} ${whyPaint(colorized, "|", WHY_ANSI.dim, WHY_THEME.gutter)} ${whyPaint(colorized, "…", WHY_ANSI.dim, WHY_THEME.gutter)}`,
      );
    }

    for (let line = interval.start; line <= interval.end; line += 1) {
      const sourceLine = source[line - 1] ?? "";
      const caretText = whyCaretForLine(sourceLine, line, ranges);
      const active = caretText !== null;

      const marker = active
        ? whyPaint(colorized, ">", WHY_ANSI.bold, WHY_ANSI.red)
        : whyPaint(colorized, "|", WHY_ANSI.dim, WHY_THEME.gutter);

      const number = whyPaint(
        colorized,
        String(line).padStart(width),
        active ? WHY_ANSI.bold : WHY_ANSI.dim,
        active ? WHY_THEME.activeGutter : WHY_THEME.gutter,
      );

      const code = highlightLuauLine(expandWhyTabs(sourceLine), colorized);

      lines.push(
        `${marker} ${number} ${whyPaint(colorized, "|", WHY_ANSI.dim, WHY_THEME.gutter)} ${code}`,
      );

      if (caretText) {
        const caret = whyPaint(
          colorized,
          caretText,
          WHY_ANSI.bold,
          WHY_ANSI.red,
        );

        lines.push(
          `  ${" ".repeat(width)} ${whyPaint(colorized, "|", WHY_ANSI.dim, WHY_THEME.gutter)} ${caret}`,
        );
      }
    }
  });

  return lines.join("\n");
}

function whySeverityMeaning(severity: Severity): string {
  if (severity === "error")
    return "This can cause incorrect behavior or violate React's rules and should normally be fixed";

  if (severity === "warning")
    return "This pattern is very likely to be a real issue in the code shown and is normally worth fixing";

  return "This may be intentional. Doctor found a plausible improvement, but the right choice depends on how this value or pattern is meant to affect rendering";
}

export function renderWhyDiagnostic(
  sourceText: string,
  diagnostic: Diagnostic,
  colorized: boolean,
  textWidth = 118,
): string {
  const rule = rulesById.get(diagnostic.rule);
  if (!rule) throw new Error(`Unknown rule: ${diagnostic.rule}`);
  const presentation = presentationFor(diagnostic);

  const lines: string[] = [
    whyPaint(colorized, diagnostic.rule, WHY_ANSI.bold, WHY_ANSI.magenta),
    whyPaint(
      colorized,
      `${diagnostic.file}:${diagnostic.location.line}:${diagnostic.location.column}`,
      WHY_ANSI.bold,
    ),
    [
      `${whyPaint(colorized, "Severity", WHY_ANSI.bold)}: ${whySeverityPaint(colorized, diagnostic.severity, diagnostic.severity)}`,
      `${whyPaint(colorized, "Category", WHY_ANSI.bold)}: ${whyPaint(colorized, diagnostic.category, WHY_ANSI.bold, WHY_THEME.category)}`,
    ].join(whyPaint(colorized, " | ", WHY_ANSI.dim)),
    "",
    renderWhyCodeFrame(sourceText, diagnostic, colorized),
    "",
    whySectionTitle(colorized, "Why this fired"),
    ...wrapWhyWords(diagnostic.message, textWidth),
  ];

  if (
    presentation.explanation !== diagnostic.message &&
    presentation.explanation !== rule.description
  ) {
    lines.push("", ...wrapWhyWords(presentation.explanation, textWidth));
  }

  lines.push(
    "",
    whySectionTitle(colorized, "What the rule checks"),
    ...wrapWhyWords(rule.description, textWidth),
    "",
    whySectionTitle(colorized, "Confidence"),
    ...wrapWhyWords(whySeverityMeaning(diagnostic.severity), textWidth),
  );

  if (presentation.help) {
    lines.push(
      "",
      whySectionTitle(colorized, "How to fix"),
      ...wrapWhyWords(presentation.help, textWidth),
    );
  }

  const fixPreview = presentation.example;

  if (fixPreview) {
    const previewTitle =
      fixPreview.kind === "exact" ? "Suggested change" : "Example pattern";

    lines.push(
      "",
      whySectionTitle(colorized, previewTitle),
      ...renderWhyFixPreview(fixPreview, colorized, textWidth),
    );
  }

  if (presentation.caveat) {
    lines.push(
      "",
      whySectionTitle(
        colorized,
        "When the current approach may be intentional",
      ),
      ...wrapWhyWords(presentation.caveat, textWidth),
    );
  }

  return `${lines.join("\n")}\n`;
}
