#!/usr/bin/env bun

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import packageJson from "../package.json";
import {
  effectiveSeverity,
  loadConfigWithSource,
  normalizeCategory,
  normalizeRuleSetting,
  writeConfig,
} from "./config";
import { runCiCommand } from "./ci";
import { checkForUpdatesNow, getCachedUpdateNotice, refreshUpdateCache, startBackgroundUpdateRefresh } from "./update-check";
import { currentUpdateInstallCommand, installLatestVersion } from "./update-install";
import { fixExampleForRule } from "./fix-examples";
import { createProgressRenderer } from "./progress";
import { createInlineSuppressionChecker } from "./inline-disables";
import { renderAnnotations, renderRulesList, renderTextReport } from "./reporter";
import { rules } from "./rules";
import { scanPath } from "./scanner";
import { aggregateReports, scanProjectWithScope } from "./scope";
import type {
  BlockingLevel,
  Category,
  Diagnostic,
  DoctorConfig,
  RuleDefinition,
  ScanProgress,
  ScanReport,
  ScanScope,
  Severity,
} from "./types";

interface CliOptions {
  target: string;
  verbose?: boolean;
  debug: boolean;
  outputDir?: string;
  scoreOnly: boolean;
  json: boolean;
  jsonCompact: boolean;
  jsonOut?: string;
  project?: string;
  scope?: ScanScope;
  base?: string;
  includeUntracked: boolean;
  diff?: boolean | string;
  changedFilesFrom?: string;
  showScore?: boolean;
  categories: Category[];
  staged: boolean;
  maxDurationSeconds?: number;
  blocking?: BlockingLevel;
  respectInlineDisables?: boolean;
  warnings?: boolean;
  noColor: boolean;
  noCache: boolean;
  noParallel: boolean;
  noUpdateCheck: boolean;
  annotations: boolean;
  minSeverity?: Severity;
  help: boolean;
  version: boolean;
}

const VERSION = packageJson.version;
const SCOPES = new Set<ScanScope>(["full", "files", "changed", "lines"]);
const BLOCKING = new Set<BlockingLevel>(["error", "warning", "none"]);
const SEVERITIES = new Set<Severity>(["suggestion", "warning", "error"]);

process.stdout.on("error", (error: Error & { code?: string }) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

function usage(): string {
  return `React-Luau Doctor ${VERSION}

Usage:
  react-luau-doctor [directory] [options]
  react-luau-doctor ci <install|config|upgrade>
  react-luau-doctor why <file:line>
  react-luau-doctor update [--check]
  react-luau-doctor rules <command>

Scan options:
  --verbose                              Show every finding and per-file details
  --debug                                Print resolved local scan details to stderr
  --output-dir <dir>                     Write report.json, diagnostics.json, and summary.json
  --score                                Output only the numeric score
  --json                                 Output one structured JSON report
  --json-compact                         Emit compact JSON instead of indented JSON
  --json-out <path>                      Write the JSON report to a file
  --project <name>                       Select project directories, comma-separated
  --scope <value>                        full, files, changed, or lines
  --base <ref>                           Git base ref for files/changed/lines scope
  --include-untracked                    Include untracked files in git scopes
  --diff [base]                          Alias for changed scope; false forces full scope
  --changed-files-from <file>            Read changed paths from a newline-delimited file
  --no-score                             Hide the local score
  --category <category>                  Only report a category; repeatable
  --staged                               Scan staged git-index content only
  --max-duration <seconds>               Stop after a shared scan time budget and report partial results
  --blocking <level>                     Exit gate: error, warning, or none
  --respect-inline-disables              Respect react-luau-doctor inline suppression comments
  --no-respect-inline-disables           Ignore inline suppressions for audit scans
  --warnings / --no-warnings             Show warnings (default) or errors only
  --annotations                          Emit GitHub Actions workflow annotations
  --no-color                             Disable automatic ANSI colors
  --no-cache                             Disable the persistent OS-level analysis cache
  --no-parallel                          Disable parallel file analysis
  --no-update-check                      Disable the automatic update notice

React-Luau Doctor options:
  --min-severity <level>                 suggestion, warning, or error
  -v, --version                          Print the version
  -h, --help                             Show this help

CI commands:
  ci install [--provider github|gitlab] [--pr] [--blocking <level>] [--scope <value>] [reporting toggles] [-y] [--cwd <cwd>]
  ci config  [--provider github|gitlab] [--blocking <level>] [--scope <value>] [reporting toggles] [-y] [--cwd <cwd>]
  ci upgrade [--provider github|gitlab] [--pr] [-y] [--cwd <cwd>]
  Reporting toggles: --comment/--no-comment, --review-comments/--no-review-comments, --commit-status/--no-commit-status

Update commands:
  update                                 Update the global installation to the latest release
  update --check                         Check npm for a newer release without updating

Rules commands:
  rules list [--category <name>] [--configured] [--json]
  rules explain <rule> [--json]
  rules set <rule> <severity>
  rules enable <rule> [--severity <level>]
  rules disable <rule>
  rules category <category> <severity>

Config:
  react-luau-doctor.config.json
`;
}


function automaticUpdateNoticeEnabled(options: CliOptions, machineReadable: boolean): boolean {
  return !options.noUpdateCheck
    && !machineReadable
    && Boolean(process.stdout.isTTY)
    && !process.env.CI
    && process.env.NO_UPDATE_NOTIFIER === undefined
    && process.env.REACT_LUAU_DOCTOR_NO_UPDATE_CHECK === undefined;
}

function renderUpdateNotice(current: string, latest: string, colorized: boolean): string {
  const label = whyPaint(colorized, "Update available:", WHY_ANSI.bold, WHY_ANSI.yellow);
  const oldVersion = whyPaint(colorized, `v${current}`, WHY_ANSI.dim);
  const newVersion = whyPaint(colorized, `v${latest}`, WHY_ANSI.bold);
  return `${label} ${oldVersion} → ${newVersion}\nRun \`react-luau-doctor update\` to update.`;
}

async function runUpdateCommand(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write("Usage: react-luau-doctor update [--check]\n");
    return;
  }
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--check")) {
    throw new Error("Usage: react-luau-doctor update [--check]");
  }

  const result = await checkForUpdatesNow(VERSION);
  if (!result.updateAvailable) {
    process.stdout.write(`React-Luau Doctor v${VERSION} is up to date.\n`);
    return;
  }

  const colorized = shouldUseColor(false, false);
  if (argv[0] === "--check") {
    process.stdout.write(`${renderUpdateNotice(VERSION, result.latest, colorized)}\n`);
    return;
  }

  const command = currentUpdateInstallCommand();
  if (!command) {
    throw new Error(
      `Could not determine the global package manager for this installation. Run \`npm install -g ${packageJson.name}@latest\` manually.`,
    );
  }

  const label = whyPaint(colorized, "Updating React-Luau Doctor:", WHY_ANSI.bold, WHY_ANSI.yellow);
  const oldVersion = whyPaint(colorized, `v${VERSION}`, WHY_ANSI.dim);
  const newVersion = whyPaint(colorized, `v${result.latest}`, WHY_ANSI.bold);
  process.stdout.write(`${label} ${oldVersion} → ${newVersion}\nUsing \`${command.display}\`\n\n`);
  installLatestVersion(command);
  process.stdout.write(`\nUpdated React-Luau Doctor to v${result.latest}.\n`);
}

function splitLongOption(arg: string): { name: string; inlineValue?: string } {
  if (!arg.startsWith("--")) return { name: arg };
  const equals = arg.indexOf("=");
  if (equals < 0) return { name: arg };
  return { name: arg.slice(0, equals), inlineValue: arg.slice(equals + 1) };
}

function requiredValue(argv: string[], index: number, name: string, inlineValue?: string): { value: string; nextIndex: number } {
  if (inlineValue !== undefined) {
    if (!inlineValue) throw new Error(`${name} requires a value`);
    return { value: inlineValue, nextIndex: index };
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${name} requires a value`);
  return { value, nextIndex: index + 1 };
}

function shouldUseColor(noColor = false, machineReadable = false): boolean {
  return !noColor && !machineReadable && process.env.NO_COLOR === undefined && Boolean(process.stdout.isTTY);
}

const WHY_ANSI = {
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
// to run the Doctor.
const WHY_THEME = {
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

function whyPaint(enabled: boolean, value: string, ...codes: string[]): string {
  if (!enabled || codes.length === 0) return value;
  return `${codes.join("")}${value}${WHY_ANSI.reset}`;
}

function whySeverityPaint(enabled: boolean, severity: Severity, value: string): string {
  if (severity === "error") return whyPaint(enabled, value, WHY_ANSI.bold, WHY_ANSI.red);
  if (severity === "warning") return whyPaint(enabled, value, WHY_ANSI.bold, WHY_ANSI.yellow);
  return whyPaint(enabled, value, WHY_ANSI.bold, WHY_ANSI.magenta);
}

function whySectionTitle(enabled: boolean, value: string): string {
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
const LUAU_DECLARATION_KEYWORDS = new Set(["export", "function", "local", "type"]);
const LUAU_LITERAL_KEYWORDS = new Set(["false", "nil", "true"]);

type WhyLuauTokenKind = "whitespace" | "comment" | "string" | "number" | "identifier" | "operator";
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

    const number = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)/.exec(rest);
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

    const operator = /^(?:\.\.\.|\.\.|==|~=|<=|>=|::|->|\+=|-=|\*=|\/=|%=|\^=|[+\-*\/%^#=<>:.,;()[\]{}])/.exec(rest);
    const token = operator?.[0] ?? ch;
    push("operator", token, index);
    index += token.length;
  }
  return tokens;
}

function previousWhyToken(tokens: WhyLuauToken[], index: number): WhyLuauToken | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (tokens[cursor].kind !== "whitespace") return tokens[cursor];
  }
  return undefined;
}

function nextWhyToken(tokens: WhyLuauToken[], index: number): WhyLuauToken | undefined {
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    if (tokens[cursor].kind !== "whitespace") return tokens[cursor];
  }
  return undefined;
}

function whyIdentifierCodes(tokens: WhyLuauToken[], index: number): string[] {
  const value = tokens[index].text;
  if (LUAU_CONTROL_KEYWORDS.has(value)) return [WHY_ANSI.bold, WHY_THEME.keyword];
  if (LUAU_DECLARATION_KEYWORDS.has(value)) return [WHY_ANSI.bold, WHY_THEME.declarationKeyword];
  if (LUAU_LITERAL_KEYWORDS.has(value)) return [WHY_ANSI.bold, WHY_THEME.literal];

  const previous = previousWhyToken(tokens, index);
  const next = nextWhyToken(tokens, index);
  const previousText = previous?.text;
  const nextText = next?.text;

  if (previousText === "function" || nextText === "(") return [WHY_THEME.function];
  if ((previousText === "." || previousText === ":") && nextText === "(") return [WHY_THEME.function];
  if (previousText === "type" || (previousText === ":" && nextText !== "(")) return [WHY_THEME.type];
  if (previousText === "." || previousText === ":") return [WHY_THEME.property];
  if (/^[A-Z]/.test(value) && (nextText === "." || nextText === "<")) return [WHY_THEME.type];
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

function whyRangeContains(ranges: WhyCharacterRange[], position: number): boolean {
  return ranges.some((range) => position >= range.start && position < range.end);
}

function highlightLuauLine(
  line: string,
  colorized: boolean,
  backgroundRanges: WhyCharacterRange[] = [],
  backgroundCode?: string,
): string {
  if (!colorized || !line) return line;
  const tokens = tokenizeWhyLuauLine(line);
  return tokens.map((token, index) => {
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
      const changed = Boolean(backgroundCode) && whyRangeContains(backgroundRanges, segmentStart);
      if (foreground.length === 0 && !changed) segments.push(value);
      else segments.push(whyPaint(true, value, ...foreground, ...(changed && backgroundCode ? [backgroundCode] : [])));
    }
    return segments.join("");
  }).join("");
}

function changedCharacterRanges(before: string, after: string): { before: WhyCharacterRange[]; after: WhyCharacterRange[] } {
  if (before === after) return { before: [], after: [] };
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  return {
    before: before.length - suffix > prefix ? [{ start: prefix, end: before.length - suffix }] : [],
    after: after.length - suffix > prefix ? [{ start: prefix, end: after.length - suffix }] : [],
  };
}

interface WhyPreviewDiff {
  beforeRanges: WhyCharacterRange[][];
  afterRanges: WhyCharacterRange[][];
}

function whyPreviewDiff(beforeLines: string[], afterLines: string[]): WhyPreviewDiff {
  const rows = beforeLines.length + 1;
  const columns = afterLines.length + 1;
  const dp = Array.from({ length: rows }, () => Array<number>(columns).fill(0));
  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      dp[beforeIndex][afterIndex] = beforeLines[beforeIndex] === afterLines[afterIndex]
        ? dp[beforeIndex + 1][afterIndex + 1] + 1
        : Math.max(dp[beforeIndex + 1][afterIndex], dp[beforeIndex][afterIndex + 1]);
    }
  }

  const matches: Array<[number, number]> = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < beforeLines.length && afterIndex < afterLines.length) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      matches.push([beforeIndex, afterIndex]);
      beforeIndex += 1;
      afterIndex += 1;
    } else if (dp[beforeIndex + 1][afterIndex] >= dp[beforeIndex][afterIndex + 1]) beforeIndex += 1;
    else afterIndex += 1;
  }

  const beforeRanges = beforeLines.map(() => [] as WhyCharacterRange[]);
  const afterRanges = afterLines.map(() => [] as WhyCharacterRange[]);
  const sentinels: Array<[number, number]> = [[-1, -1], ...matches, [beforeLines.length, afterLines.length]];
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
      const ranges = changedCharacterRanges(beforeLines[left], afterLines[right]);
      beforeRanges[left] = ranges.before;
      afterRanges[right] = ranges.after;
    }
    for (let offset = paired; offset < beforeCount; offset += 1) {
      const line = beforeStart + offset;
      beforeRanges[line] = [{ start: 0, end: Math.max(1, beforeLines[line].length) }];
    }
    for (let offset = paired; offset < afterCount; offset += 1) {
      const line = afterStart + offset;
      afterRanges[line] = [{ start: 0, end: Math.max(1, afterLines[line].length) }];
    }
  }

  return { beforeRanges, afterRanges };
}

function normalizeWhyPreviewLines(value: string): string[] {
  const lines = value.split(/\r?\n/).map((line) => expandWhyTabs(line));
  while (lines.length > 1 && lines[0].trim().length === 0) lines.shift();
  while (lines.length > 1 && lines.at(-1)?.trim().length === 0) lines.pop();
  if (lines.length <= 1) return lines;

  const indentation = (line: string): number => line.match(/^ */)?.[0].length ?? 0;
  const nonBlank = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.trim().length > 0);
  if (nonBlank.length === 0) return lines;

  const firstIndent = indentation(nonBlank[0].line);
  if (firstIndent > 0) {
    const commonIndent = Math.min(...nonBlank.map(({ line }) => indentation(line)));
    return lines.map((line) => line.trim().length === 0 ? "" : line.slice(Math.min(commonIndent, indentation(line))));
  }

  // Syntax-node text begins at the expression itself, so the first line has no
  // file indentation while continuation lines still include the source file's
  // tabs/spaces. Remove the continuation baseline, but preserve indentation
  // relative to that baseline for nested code inside the expression.
  const continuation = nonBlank.filter(({ index }) => index > nonBlank[0].index);
  if (continuation.length === 0) return lines;
  const continuationBaseline = Math.min(...continuation.map(({ line }) => indentation(line)));
  if (continuationBaseline <= 0) return lines;

  return lines.map((line, index) => {
    if (index <= nonBlank[0].index || line.trim().length === 0) return line;
    return line.slice(Math.min(continuationBaseline, indentation(line)));
  });
}

function renderWhyFixPreview(preview: { before: string; after: string; note?: string }, colorized: boolean, textWidth: number): string[] {
  const beforeLines = normalizeWhyPreviewLines(preview.before);
  const afterLines = normalizeWhyPreviewLines(preview.after);
  const diff = whyPreviewDiff(beforeLines, afterLines);
  const currentLabel = colorized
    ? whyPaint(true, " CURRENT ", WHY_ANSI.bold, WHY_THEME.foreground, WHY_THEME.removedLabelBackground)
    : "CURRENT";
  const suggestedLabel = colorized
    ? whyPaint(true, " SUGGESTED ", WHY_ANSI.bold, WHY_THEME.foreground, WHY_THEME.addedLabelBackground)
    : "SUGGESTED";
  const lines: string[] = [currentLabel];
  beforeLines.forEach((line, index) => {
    lines.push(`  ${highlightLuauLine(line, colorized, diff.beforeRanges[index], WHY_THEME.removedBackground)}`);
  });
  lines.push("", suggestedLabel);
  afterLines.forEach((line, index) => {
    lines.push(`  ${highlightLuauLine(line, colorized, diff.afterRanges[index], WHY_THEME.addedBackground)}`);
  });
  if (preview.note) {
    lines.push("", ...wrapWhyWords(preview.note, textWidth).map((line) => whyPaint(colorized, line, WHY_ANSI.dim)));
  }
  return lines;
}

function wrapWhyWords(value: string, width: number): string[] {
  const safeWidth = Math.max(32, width);
  const paragraphs = value.split(/\r?\n/);
  const lines: string[] = [];

  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
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
    if (paragraphIndex < paragraphs.length - 1 && paragraphs[paragraphIndex + 1].trim()) lines.push("");
  }

  return lines.length > 0 ? lines : [""];
}

function whyTextWidth(): number {
  return Math.max(60, (process.stdout.columns ?? 120) - 2);
}

function parseBlocking(value: string, name: string): BlockingLevel {
  if (!BLOCKING.has(value as BlockingLevel)) throw new Error(`${name} must be error, warning, or none`);
  return value as BlockingLevel;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    target: ".",
    debug: false,
    scoreOnly: false,
    json: false,
    jsonCompact: false,
    includeUntracked: false,
    categories: [],
    staged: false,
    annotations: false,
    noColor: false,
    noCache: false,
    noParallel: false,
    noUpdateCheck: false,
    help: false,
    version: false,
  };

  let sawTarget = false;
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const { name: arg, inlineValue } = splitLongOption(raw);

    if (arg === "--verbose") options.verbose = true;
    else if (arg === "--debug") options.debug = true;
    else if (arg === "--score") options.scoreOnly = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--json-compact") options.jsonCompact = true;
    else if (arg === "--include-untracked") options.includeUntracked = true;
    else if (arg === "--no-score") options.showScore = false;
    else if (arg === "--staged") options.staged = true;
    else if (arg === "--no-respect-inline-disables") options.respectInlineDisables = false;
    else if (arg === "--respect-inline-disables") options.respectInlineDisables = true;
    else if (arg === "--warnings") options.warnings = true;
    else if (arg === "--no-warnings") options.warnings = false;
    else if (arg === "--no-color") options.noColor = true;
    else if (arg === "--no-cache") options.noCache = true;
    else if (arg === "--no-parallel") options.noParallel = true;
    else if (arg === "--no-update-check") options.noUpdateCheck = true;
    else if (arg === "--annotations") options.annotations = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else if (arg === "--output-dir") {
      const parsed = requiredValue(argv, index, arg, inlineValue);
      options.outputDir = parsed.value;
      index = parsed.nextIndex;
    } else if (arg === "--json-out") {
      const parsed = requiredValue(argv, index, arg, inlineValue);
      options.jsonOut = parsed.value;
      index = parsed.nextIndex;
    } else if (arg === "--project") {
      const parsed = requiredValue(argv, index, arg, inlineValue);
      options.project = parsed.value;
      index = parsed.nextIndex;
    } else if (arg === "--scope") {
      const parsed = requiredValue(argv, index, arg, inlineValue);
      if (!SCOPES.has(parsed.value as ScanScope)) throw new Error("--scope must be full, files, changed, or lines");
      options.scope = parsed.value as ScanScope;
      index = parsed.nextIndex;
    } else if (arg === "--base") {
      const parsed = requiredValue(argv, index, arg, inlineValue);
      options.base = parsed.value;
      index = parsed.nextIndex;
    } else if (arg === "--diff") {
      if (inlineValue !== undefined) options.diff = inlineValue === "false" ? false : inlineValue === "true" ? true : inlineValue;
      else {
        const next = argv[index + 1];
        if (next && !next.startsWith("-")) {
          options.diff = next === "false" ? false : next === "true" ? true : next;
          index += 1;
        } else options.diff = true;
      }
    } else if (arg === "--changed-files-from") {
      const parsed = requiredValue(argv, index, arg, inlineValue);
      options.changedFilesFrom = parsed.value;
      index = parsed.nextIndex;
    } else if (arg === "--category") {
      const parsed = requiredValue(argv, index, arg, inlineValue);
      const category = normalizeCategory(parsed.value);
      if (!category) throw new Error(`Unknown category: ${parsed.value}`);
      options.categories.push(category);
      index = parsed.nextIndex;
    } else if (arg === "--max-duration") {
      const parsed = requiredValue(argv, index, arg, inlineValue);
      const seconds = Number(parsed.value);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--max-duration must be a positive number of seconds");
      options.maxDurationSeconds = seconds;
      index = parsed.nextIndex;
    } else if (arg === "--blocking") {
      const parsed = requiredValue(argv, index, arg, inlineValue);
      options.blocking = parseBlocking(parsed.value, arg);
      index = parsed.nextIndex;
    } else if (arg === "--min-severity") {
      const parsed = requiredValue(argv, index, arg, inlineValue);
      if (!SEVERITIES.has(parsed.value as Severity)) throw new Error("--min-severity must be suggestion, warning, or error");
      options.minSeverity = parsed.value as Severity;
      index = parsed.nextIndex;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${raw}`);
    } else if (!sawTarget) {
      options.target = raw;
      sawTarget = true;
    } else {
      throw new Error(`Unexpected argument: ${raw}`);
    }
  }

  return options;
}

function resolveScope(options: CliOptions, config: DoctorConfig): { scope: ScanScope; base?: string } {
  if (options.scope) return { scope: options.scope, base: options.base ?? config.base };
  if (options.diff !== undefined) {
    if (options.diff === false) return { scope: "full", base: options.base ?? config.base };
    return { scope: "changed", base: options.base ?? (typeof options.diff === "string" ? options.diff : config.base) };
  }
  if (config.scope) return { scope: config.scope, base: options.base ?? config.base };
  if (config.diff !== undefined) {
    if (config.diff === false) return { scope: "full", base: options.base ?? config.base };
    return { scope: "changed", base: options.base ?? (typeof config.diff === "string" ? config.diff : config.base) };
  }
  if (options.changedFilesFrom) return { scope: "files", base: options.base ?? config.base };
  return { scope: "full", base: options.base ?? config.base };
}

function validateModeFlags(options: CliOptions, scope: ScanScope): void {
  if (options.scope && options.diff !== undefined && options.diff !== false) throw new Error("Cannot combine --scope and --diff; pick one mode");
  if (options.staged && options.diff !== undefined && options.diff !== false) throw new Error("Cannot combine --staged and --diff; pick one mode");
  if (options.staged && (scope === "full" || scope === "changed")) {
    throw new Error(`Cannot combine --staged with --scope ${scope}; use --scope files or --scope lines, or omit --scope`);
  }
  if (options.includeUntracked && options.staged) throw new Error("Cannot combine --include-untracked with --staged; the git index never holds untracked files");
  if (options.includeUntracked && scope === "full") throw new Error("--include-untracked requires files, changed, or lines scope");
  if (options.scoreOnly && options.json) throw new Error("Cannot combine --score and --json; pick one output mode");
  if (options.scoreOnly && options.showScore === false) throw new Error("Cannot combine --score with --no-score");
  if (options.annotations && (options.json || options.scoreOnly)) throw new Error("--annotations cannot be combined with --json or --score");
}

function findProjectByName(root: string, name: string): string | null {
  const direct = path.resolve(root, name);
  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return direct;

  const ignored = new Set([".git", "node_modules", "Packages", "DevPackages", "ServerPackages", "dist", "vendor"]);
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  const matches: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= 3) continue;
    for (const entry of fs.readdirSync(current.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || ignored.has(entry.name)) continue;
      const absolute = path.join(current.directory, entry.name);
      if (entry.name === name) matches.push(absolute);
      queue.push({ directory: absolute, depth: current.depth + 1 });
    }
  }
  if (matches.length > 1) throw new Error(`Project selector "${name}" is ambiguous: ${matches.map((match) => path.relative(root, match)).join(", ")}`);
  return matches[0] ?? null;
}

function resolveProjectRoots(root: string, projectFlag: string | undefined, config: DoctorConfig): string[] {
  const requested = projectFlag ? projectFlag.split(",").map((value) => value.trim()).filter(Boolean) : config.projects ?? [];
  if (requested.length === 0) return [root];

  return [...new Set(requested.map((project) => {
    const resolved = findProjectByName(root, project);
    if (!resolved) throw new Error(`Could not find project: ${project}`);
    return resolved;
  }))];
}

function serializeReport(report: ScanReport, compact: boolean): string {
  return compact ? JSON.stringify(report) : JSON.stringify(report, null, 2);
}

function writeJsonFile(filename: string, value: unknown, compact = false): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`);
}

function writeDiagnosticsDump(directory: string, report: ScanReport): void {
  fs.mkdirSync(directory, { recursive: true });
  writeJsonFile(path.join(directory, "report.json"), report);
  writeJsonFile(path.join(directory, "diagnostics.json"), report.diagnostics);
  writeJsonFile(path.join(directory, "summary.json"), {
    schemaVersion: report.schemaVersion,
    root: report.root,
    scope: report.scope ?? "full",
    base: report.base ?? null,
    scannedFiles: report.scannedFiles,
    candidateFiles: report.candidateFiles,
    partial: report.partial,
    skippedFiles: report.skippedFiles ?? [],
    durationMs: report.durationMs,
    score: report.score,
    counts: report.counts,
  });
}

function shouldBlock(report: ScanReport, level: BlockingLevel): boolean {
  if (level === "none") return false;
  if (level === "warning") return report.counts.error > 0 || report.counts.warning > 0;
  return report.counts.error > 0;
}

function findRule(requested: string): RuleDefinition {
  const rule = rules.find((candidate) => candidate.id === requested || candidate.id.endsWith(`/${requested}`));
  if (!rule) throw new Error(`Unknown rule: ${requested}`);
  return rule;
}

function parseCommandCwd(argv: string[]): { cwd: string; remaining: string[] } {
  let cwd = process.cwd();
  const remaining: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-c" || arg === "--cwd") {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a path`);
      cwd = path.resolve(value);
    } else remaining.push(arg);
  }
  return { cwd, remaining };
}

function ruleSeverityMap(config: DoctorConfig): Map<string, string> {
  return new Map(rules.map((rule) => [rule.id, effectiveSeverity(rule.severity, rule.id, config) ?? "off"]));
}

function runRulesCommand(argv: string[]): void {
  const noColor = argv.includes("--no-color");
  const cleaned = argv.filter((arg) => arg !== "--no-color");
  const action = cleaned[0] ?? "list";
  const { cwd, remaining } = parseCommandCwd(cleaned.slice(1));
  const loaded = loadConfigWithSource(cwd);
  const config = loaded.config;

  if (action === "list") {
    let category: Category | null = null;
    let configured = false;
    let json = false;

    for (let index = 0; index < remaining.length; index += 1) {
      const arg = remaining[index];
      if (arg === "--configured") configured = true;
      else if (arg === "--json") json = true;
      else if (arg === "--category") {
        const value = remaining[++index];
        if (!value) throw new Error("rules list --category requires a name");
        category = normalizeCategory(value);
        if (!category) throw new Error(`Unknown category: ${value}`);
      } else throw new Error(`Unknown rules list option: ${arg}`);
    }

    const severityMap = ruleSeverityMap(config);
    const filtered = rules.filter((rule) => {
      if (category && rule.category !== category) return false;
      if (configured && config.rules?.[rule.id] === undefined) return false;
      return true;
    });

    if (json) {
      process.stdout.write(`${JSON.stringify(filtered.map((rule) => ({
        id: rule.id,
        severity: severityMap.get(rule.id),
        defaultSeverity: rule.severity,
        category: rule.category,
        description: rule.description,
      })), null, 2)}\n`);
    } else process.stdout.write(`${renderRulesList(filtered, process.stdout.columns ?? 120, severityMap, shouldUseColor(noColor))}\n`);
    return;
  }

  if (action === "explain") {
    const requested = remaining[0];
    if (!requested) throw new Error("rules explain requires a rule id");
    const json = remaining.slice(1).includes("--json");
    const extra = remaining.slice(1).filter((arg) => arg !== "--json");
    if (extra.length > 0) throw new Error(`Unknown rules explain option: ${extra[0]}`);
    const rule = findRule(requested);
    const currentSeverity = effectiveSeverity(rule.severity, rule.id, config) ?? "off";
    const result = {
      id: rule.id,
      severity: currentSeverity,
      defaultSeverity: rule.severity,
      category: rule.category,
      description: rule.description,
      example: fixExampleForRule(rule.id),
    };
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      const colorized = shouldUseColor(noColor);
      const width = whyTextWidth();
      const lines = [
        whyPaint(colorized, rule.id, WHY_ANSI.bold, WHY_ANSI.magenta),
        `${rule.category} | Severity: ${currentSeverity} | Default: ${rule.severity}`,
        "",
        whySectionTitle(colorized, "What this checks"),
        ...wrapWhyWords(rule.description, width),
      ];
      if (result.example) {
        lines.push("", whySectionTitle(colorized, "Example fix"),
          ...renderWhyFixPreview(result.example, colorized, width));
      }
      lines.push("", ...wrapWhyWords("This is an example pattern, not an automatic edit. To explain a finding in your code, run:", width),
        "  react-luau-doctor why <file:line>");
      process.stdout.write(`${lines.join("\n")}\n`);
    }
    return;
  }

  if (action === "set") {
    const requested = remaining[0];
    const rawSeverity = remaining[1];
    if (!requested || !rawSeverity) throw new Error("rules set requires <rule> <severity>");
    const rule = findRule(requested);
    const severity = normalizeRuleSetting(rawSeverity);
    if (!severity) throw new Error("Rule severity must be off, suggestion, warning/warn, or error");
    const filename = writeConfig(cwd, (current) => ({ ...current, rules: { ...current.rules, [rule.id]: severity } }));
    process.stdout.write(`Set ${rule.id} to ${severity} in ${path.relative(cwd, filename)}\n`);
    return;
  }

  if (action === "enable") {
    const requested = remaining[0];
    if (!requested) throw new Error("rules enable requires a rule id");
    const rule = findRule(requested);
    let severity: Severity = rule.severity;
    const severityIndex = remaining.indexOf("--severity");
    if (severityIndex >= 0) {
      const value = remaining[severityIndex + 1];
      const normalized = value ? normalizeRuleSetting(value) : null;
      if (!normalized || normalized === "off") throw new Error("--severity must be suggestion, warning/warn, or error");
      severity = normalized;
    }
    const filename = writeConfig(cwd, (current) => ({ ...current, rules: { ...current.rules, [rule.id]: severity } }));
    process.stdout.write(`Enabled ${rule.id} at ${severity} in ${path.relative(cwd, filename)}\n`);
    return;
  }

  if (action === "disable") {
    const requested = remaining[0];
    if (!requested) throw new Error("rules disable requires a rule id");
    const rule = findRule(requested);
    const filename = writeConfig(cwd, (current) => ({ ...current, rules: { ...current.rules, [rule.id]: "off" } }));
    process.stdout.write(`Disabled ${rule.id} in ${path.relative(cwd, filename)}\n`);
    return;
  }

  if (action === "category") {
    const rawCategory = remaining[0];
    const rawSeverity = remaining[1];
    if (!rawCategory || !rawSeverity) throw new Error("rules category requires <category> <severity>");
    const category = normalizeCategory(rawCategory);
    const severity = normalizeRuleSetting(rawSeverity);
    if (!category) throw new Error(`Unknown category: ${rawCategory}`);
    if (!severity) throw new Error("Category severity must be off, suggestion, warning/warn, or error");
    const categoryRules = rules.filter((rule) => rule.category === category);
    const filename = writeConfig(cwd, (current) => ({
      ...current,
      rules: Object.fromEntries([
        ...Object.entries(current.rules ?? {}),
        ...categoryRules.map((rule) => [rule.id, severity] as const),
      ]),
    }));
    process.stdout.write(`Set ${categoryRules.length} ${category} rules to ${severity} in ${path.relative(cwd, filename)}\n`);
    return;
  }

  throw new Error(`Unknown rules command: ${action}`);
}

function whyLocationContains(location: Diagnostic["location"], line: number, column?: number): boolean {
  if (line < location.line || line > location.endLine) return false;
  if (column === undefined) return true;
  if (location.line === location.endLine) return column >= location.column && column <= location.endColumn;
  if (line === location.line) return column >= location.column;
  if (line === location.endLine) return column <= location.endColumn;
  return true;
}

function whyDiagnosticRanges(diagnostic: Diagnostic): Diagnostic["location"][] {
  return diagnostic.highlights && diagnostic.highlights.length > 0 ? diagnostic.highlights : [diagnostic.location];
}

function whyLocationMatches(diagnostic: Diagnostic, line: number, column?: number): boolean {
  if (whyLocationContains(diagnostic.location, line, column)) return true;
  return (diagnostic.highlights ?? []).some((location) => whyLocationContains(location, line, column));
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

function whyFrameIntervals(ranges: Diagnostic["location"][], sourceLength: number): Array<{ start: number; end: number }> {
  const intervals = ranges
    .map((range) => ({
      start: Math.max(1, range.line - 2),
      end: Math.min(sourceLength, range.endLine + 2),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end + 1) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

function whyCaretForLine(sourceLine: string, line: number, ranges: Diagnostic["location"][]): string | null {
  const expanded = expandWhyTabs(sourceLine);
  const marks = Array.from({ length: Math.max(1, expanded.length + 1) }, () => false);
  let hasMark = false;
  for (const range of ranges) {
    if (line < range.line || line > range.endLine) continue;
    const rawStart = line === range.line ? range.column : 1;
    const rawEnd = line === range.endLine ? range.endColumn : sourceLine.length + 1;
    const start = Math.max(1, whyVisualColumn(sourceLine, rawStart));
    const end = Math.max(start + 1, whyVisualColumn(sourceLine, rawEnd));
    for (let column = start - 1; column < Math.min(marks.length, end - 1); column += 1) {
      marks[column] = true;
      hasMark = true;
    }
  }
  if (!hasMark) return null;
  let value = marks.map((marked) => marked ? "^" : " ").join("").replace(/\s+$/, "");
  if (!value) value = "^";
  return value;
}

function renderWhyCodeFrame(filename: string, diagnostic: Diagnostic, colorized: boolean): string {
  const source = fs.readFileSync(filename, "utf8").split(/\r?\n/);
  const ranges = whyDiagnosticRanges(diagnostic);
  const intervals = whyFrameIntervals(ranges, source.length);
  const width = String(Math.max(...intervals.map((interval) => interval.end), 1)).length;
  const lines: string[] = [];

  intervals.forEach((interval, intervalIndex) => {
    if (intervalIndex > 0) {
      lines.push(`${whyPaint(colorized, "…", WHY_ANSI.dim, WHY_THEME.gutter)} ${" ".repeat(width)} ${whyPaint(colorized, "|", WHY_ANSI.dim, WHY_THEME.gutter)} ${whyPaint(colorized, "…", WHY_ANSI.dim, WHY_THEME.gutter)}`);
    }
    for (let line = interval.start; line <= interval.end; line += 1) {
      const sourceLine = source[line - 1] ?? "";
      const caretText = whyCaretForLine(sourceLine, line, ranges);
      const active = caretText !== null;
      const marker = active ? whyPaint(colorized, ">", WHY_ANSI.bold, WHY_ANSI.red) : whyPaint(colorized, "|", WHY_ANSI.dim, WHY_THEME.gutter);
      const number = whyPaint(colorized, String(line).padStart(width), active ? WHY_ANSI.bold : WHY_ANSI.dim, active ? WHY_THEME.activeGutter : WHY_THEME.gutter);
      const code = highlightLuauLine(expandWhyTabs(sourceLine), colorized);
      lines.push(`${marker} ${number} ${whyPaint(colorized, "|", WHY_ANSI.dim, WHY_THEME.gutter)} ${code}`);
      if (caretText) {
        const caret = whyPaint(colorized, caretText, WHY_ANSI.bold, WHY_ANSI.red);
        lines.push(`  ${" ".repeat(width)} ${whyPaint(colorized, "|", WHY_ANSI.dim, WHY_THEME.gutter)} ${caret}`);
      }
    }
  });

  return lines.join("\n");
}

function whySeverityMeaning(severity: Severity): string {
  if (severity === "error") return "This can violate React or Luau correctness rules and should normally be fixed.";
  if (severity === "warning") return "This pattern is very likely to be a real issue in the code shown and is normally worth fixing.";
  return "This may be intentional. Doctor found a plausible improvement, but the right choice depends on how this value or pattern is meant to affect rendering.";
}

function whyRuleSpecificContext(diagnostic: Diagnostic): string | null {
  if (diagnostic.rule === "react-luau/prefer-binding-over-state-candidate") {
    return "A Binding can update visual values without rerendering the component. Here, at least one use may be structural or otherwise depend on a rerender, so replacing all of the state with a Binding is not automatically safe.";
  }
  if (diagnostic.rule === "react-luau/prefer-binding-over-state") {
    return "A Binding can update these values without rerendering the component, and every use of the value only needs that kind of update. React state is therefore doing extra reconciliation work here.";
  }
  if (diagnostic.rule === "react-luau/rerender-high-frequency-state") {
    return "Doctor found a state setter on a high-frequency callback path. Calling a setter every frame still has overhead, and any changed value can schedule React reconciliation; this rule now suppresses simple one-shot guards it can prove.";
  }
  if (
    diagnostic.rule === "react-luau/no-side-effects-in-render" &&
    diagnostic.message.includes("code it calls eventually changes state outside the current render")
  ) {
    return "Doctor is not judging this call by its name. It followed the code behind the call and found a mutation that can affect existing state outside this render. That means the call can change the app even if React later abandons this render.";
  }
  return null;
}

function whyRuleCaveat(diagnostic: Diagnostic): string | null {
  if (diagnostic.rule === "react-luau/prefer-binding-over-state-candidate") {
    return "Keep React state when the value genuinely changes component structure, conditional children, hook inputs, or other behavior that must go through React reconciliation. Mixed cases often benefit from splitting visual Binding updates from a smaller structural state value.";
  }
  if (diagnostic.rule === "react-luau/prefer-binding-over-state") {
    return "Keep React state if changing the value must rebuild component structure rather than only update Roblox Instance properties or other Binding-aware consumers.";
  }
  if (diagnostic.rule === "react-luau/rerender-high-frequency-state") {
    return "A same-value state update can be bailed out by React, so this finding does not prove that the component actually rerenders every frame. It flags the per-frame setter path and is suppressed when Doctor can prove a simple one-shot or direct no-change guard.";
  }
  return null;
}

function renderWhyDiagnostic(filename: string, diagnostic: Diagnostic, colorized: boolean): string {
  const rule = findRule(diagnostic.rule);
  const textWidth = whyTextWidth();
  const lines: string[] = [
    whyPaint(colorized, diagnostic.rule, WHY_ANSI.bold, WHY_ANSI.magenta),
    whyPaint(colorized, `${diagnostic.file}:${diagnostic.location.line}:${diagnostic.location.column}`, WHY_ANSI.bold),
    [
      `${whyPaint(colorized, "Severity", WHY_ANSI.bold)}: ${whySeverityPaint(colorized, diagnostic.severity, diagnostic.severity)}`,
      `${whyPaint(colorized, "Category", WHY_ANSI.bold)}: ${whyPaint(colorized, diagnostic.category, WHY_ANSI.bold, WHY_THEME.category)}`,
    ].join(whyPaint(colorized, " | ", WHY_ANSI.dim)),
    "",
    renderWhyCodeFrame(filename, diagnostic, colorized),
    "",
    whySectionTitle(colorized, "Why this fired"),
    ...wrapWhyWords(diagnostic.message, textWidth),
  ];

  const specificContext = whyRuleSpecificContext(diagnostic);
  if (specificContext) lines.push("", ...wrapWhyWords(specificContext, textWidth));

  lines.push(
    "",
    whySectionTitle(colorized, "What the rule checks"),
    ...wrapWhyWords(rule.description, textWidth),
    "",
    whySectionTitle(colorized, "Confidence"),
    ...wrapWhyWords(whySeverityMeaning(diagnostic.severity), textWidth),
  );

  if (diagnostic.help) {
    lines.push("", whySectionTitle(colorized, "How to fix"), ...wrapWhyWords(diagnostic.help, textWidth));
  }
  const fixPreview = diagnostic.fixPreview ?? fixExampleForRule(diagnostic.rule);
  if (fixPreview) {
    const previewTitle = fixPreview.kind === "exact" ? "Suggested change" : "Example pattern";
    lines.push("", whySectionTitle(colorized, previewTitle), ...renderWhyFixPreview(fixPreview, colorized, textWidth));
  }
  const caveat = whyRuleCaveat(diagnostic);
  if (caveat) {
    lines.push("", whySectionTitle(colorized, "When the current approach may be intentional"), ...wrapWhyWords(caveat, textWidth));
  }

  return `${lines.join("\n")}\n`;
}

async function scanWhyFile(
  filename: string,
  cwd: string,
  cache: boolean,
  onProgress?: (progress: ScanProgress) => void,
): Promise<ScanReport> {
  // Scan only the requested file, but build its project model from the same root
  // as a normal project scan. Project-aware rules otherwise disappear when `why`
  // is invoked on a single file. Suppressions are evaluated after this one audit
  // scan so `why` never rebuilds project context just to discover hidden findings.
  return scanPath(cwd, {
    files: [{ absolutePath: filename, forceScan: true }],
    respectInlineDisables: false,
    onProgress,
    cache,
  });
}

async function runWhy(
  location: string,
  cwd: string,
  noColor = false,
  cache = true,
  onProgress?: (progress: ScanProgress) => void,
  beforeOutput?: () => void,
): Promise<void> {
  const match = location.match(/^(.*):(\d+)(?::(\d+))?$/);
  if (!match) throw new Error("Location must be file:line or file:line:column");
  const filename = path.resolve(cwd, match[1]);
  const line = Number(match[2]);
  const column = match[3] === undefined ? undefined : Number(match[3]);
  if (!fs.existsSync(filename)) throw new Error(`File does not exist: ${match[1]}`);

  const colorized = shouldUseColor(noColor, false);
  const source = fs.readFileSync(filename, "utf8");
  const isSuppressed = createInlineSuppressionChecker(source);
  const auditReport = await scanWhyFile(filename, cwd, cache, onProgress);
  // `why` renders its own output before returning to the CLI entry point. Clear
  // the transient progress line here so the diagnostic never starts on the same
  // terminal row as a completed progress bar.
  beforeOutput?.();
  const matching = auditReport.diagnostics.filter((diagnostic) => whyLocationMatches(diagnostic, line, column));
  const visible = matching.filter((diagnostic) => !isSuppressed(diagnostic.rule, diagnostic.location.line));

  if (visible.length > 0) {
    for (let index = 0; index < visible.length; index += 1) {
      if (index > 0) process.stdout.write("\n");
      process.stdout.write(renderWhyDiagnostic(filename, visible[index], colorized));
    }
    return;
  }

  const suppressed = matching.filter((diagnostic) => isSuppressed(diagnostic.rule, diagnostic.location.line));
  if (suppressed.length > 0) {
    process.stdout.write(`No visible diagnostic at ${location}. ${suppressed.length} diagnostic${suppressed.length === 1 ? " is" : "s are"} hidden by an inline react-luau-doctor suppression.\n\n`);
    for (let index = 0; index < suppressed.length; index += 1) {
      if (index > 0) process.stdout.write("\n");
      process.stdout.write(renderWhyDiagnostic(filename, suppressed[index], colorized));
    }
    return;
  }

  const nearby = auditReport.diagnostics
    .filter((diagnostic) => !isSuppressed(diagnostic.rule, diagnostic.location.line))
    .filter((diagnostic) => Math.abs(diagnostic.location.line - line) <= 3)
    .sort((a, b) => Math.abs(a.location.line - line) - Math.abs(b.location.line - line));
  process.stdout.write(`No React-Luau Doctor diagnostic found at ${location}.\n`);
  if (nearby.length > 0) {
    process.stdout.write("Nearby diagnostics in this file:\n");
    for (const diagnostic of nearby.slice(0, 5)) {
      process.stdout.write(`  ${diagnostic.file}:${diagnostic.location.line}:${diagnostic.location.column}  ${diagnostic.rule}\n`);
    }
  }
}

function pathIsInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function runScan(
  options: CliOptions,
  onProgress?: (progress: ScanProgress) => void,
): Promise<ScanReport> {
  const commandRoot = process.cwd();
  const target = path.resolve(commandRoot, options.target);
  if (!fs.existsSync(target)) throw new Error(`Scan path does not exist: ${options.target}`);
  const targetStat = fs.statSync(target);
  const scanRoot = targetStat.isFile() ? path.dirname(target) : target;

  // CLI configuration is owned by the directory the command was launched from.
  // Narrowing the scan target must not silently switch to a different config.
  const loaded = loadConfigWithSource(commandRoot);
  const config = loaded.config;
  const resolvedScope = resolveScope(options, config);
  const scope = options.staged && options.scope === undefined ? "files" : resolvedScope.scope;
  validateModeFlags(options, scope);


  if (targetStat.isFile() && (scope !== "full" || options.staged || options.changedFilesFrom)) {
    throw new Error("Git scopes require a directory target; scan the containing project directory instead");
  }

  const targetInsideCommandRoot = pathIsInside(commandRoot, target);
  const selectionRoot = targetInsideCommandRoot ? commandRoot : scanRoot;
  const requestedProjectRoots = resolveProjectRoots(selectionRoot, options.project, config);
  const projectTargets = requestedProjectRoots.flatMap((projectRoot) => {
    if (pathIsInside(projectRoot, target)) return [{ projectRoot, targetRoot: target }];
    if (pathIsInside(target, projectRoot)) return [{ projectRoot, targetRoot: projectRoot }];
    return [];
  });
  if (projectTargets.length === 0) {
    throw new Error(`Scan target is outside the selected project${requestedProjectRoots.length === 1 ? "" : "s"}: ${options.target}`);
  }

  const displayRoot = targetInsideCommandRoot ? commandRoot : selectionRoot;
  const minSeverity = (options.warnings ?? config.warnings ?? true) ? options.minSeverity ?? "suggestion" : "error";
  const categories = options.categories.length > 0 ? options.categories : config.categories;
  const respectInlineDisables = options.respectInlineDisables ?? config.respectInlineDisables ?? true;
  const deadlineAt = options.maxDurationSeconds !== undefined ? performance.now() + options.maxDurationSeconds * 1000 : undefined;
  const reports: Array<{ projectRoot: string; report: ScanReport }> = [];
  for (const { projectRoot, targetRoot } of projectTargets) {
    let report: ScanReport;
    const projectName = projectTargets.length > 1 ? path.relative(displayRoot, projectRoot) || "." : undefined;
    const projectProgress = onProgress
      ? (progress: ScanProgress) => onProgress({
          ...progress,
          phase: [projectName, progress.phase].filter(Boolean).join(":") || undefined,
          label: projectName && progress.label ? `${projectName}: ${progress.label}` : progress.label,
        })
      : undefined;

    if (targetStat.isFile()) {
      report = await scanPath(targetRoot, {
        projectRoot,
        config,
        minSeverity,
        categories,
        respectInlineDisables,
        deadlineAt,
        onProgress: projectProgress,
        cache: !options.noCache,
        parallel: !options.noParallel,
      });
      report.scope = "full";
    } else {
      report = await scanProjectWithScope(projectRoot, {
        targetRoot,
        scope,
        base: resolvedScope.base,
        includeUntracked: options.includeUntracked,
        staged: options.staged,
        changedFilesFrom: options.changedFilesFrom,
        config,
        minSeverity,
        categories,
        respectInlineDisables,
        deadlineAt,
        onProgress: projectProgress,
        cache: !options.noCache,
        parallel: !options.noParallel,
      });
    }
    reports.push({ projectRoot, report });
  }

  const report = aggregateReports(displayRoot, reports);
  if (options.debug) {
    const debugLines = [
      `[debug] version=${VERSION}`,
      `[debug] bun=${Bun.version} platform=${process.platform}/${process.arch}`,
      `[debug] target=${target}`,
      `[debug] config=${loaded.filename ?? "none"}`,
      `[debug] scope=${report.scope ?? scope} base=${report.base ?? resolvedScope.base ?? "auto"}`,
      `[debug] projects=${projectTargets.map(({ projectRoot }) => path.relative(displayRoot, projectRoot) || ".").join(",")}`,
      `[debug] candidates=${report.candidateFiles ?? 0} scanned=${report.scannedFiles} partial=${Boolean(report.partial)}`,
      `[debug] parallel=${!options.noParallel}`,
    ];
    process.stderr.write(`${debugLines.join("\n")}\n`);
  }
  return report;
}

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);

    if (argv[0] === "__update-cache") {
      await refreshUpdateCache({ silent: true });
      return;
    }

    if (argv[0] === "update") {
      await runUpdateCommand(argv.slice(1));
      return;
    }

    if (argv[0] === "ci") {
      await runCiCommand(argv.slice(1));
      return;
    }

    if (argv[0] === "rules") {
      runRulesCommand(argv.slice(1));
      return;
    }

    if (argv[0] === "why") {
      const location = argv[1];
      if (!location) throw new Error("why requires file:line");
      const { cwd, remaining } = parseCommandCwd(argv.slice(2));
      const noColor = remaining.includes("--no-color");
      const noCache = remaining.includes("--no-cache");
      const unknown = remaining.filter((arg) => arg !== "--no-color" && arg !== "--no-cache");
      if (unknown.length > 0) throw new Error(`Unknown why option: ${unknown[0]}`);
      const colorized = shouldUseColor(noColor, false);
      const progress = createProgressRenderer({
        enabled: Boolean(process.stdout.isTTY && !process.env.CI),
        colorized,
      });
      try {
        await runWhy(
          location,
          cwd,
          noColor,
          !noCache,
          (scanProgress) => progress.update(scanProgress),
          () => progress.clear(),
        );
      } finally {
        progress.clear();
      }
      return;
    }

    if (argv[0] === "version") {
      process.stdout.write(`React-Luau Doctor ${VERSION}\nBun ${Bun.version}\n${process.platform} ${process.arch}\n${os.release()}\n`);
      return;
    }

    const options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(usage());
      return;
    }
    if (options.version) {
      process.stdout.write(`${VERSION}\n`);
      return;
    }
    const machineReadable = options.scoreOnly || options.json || options.annotations;
    const colorized = shouldUseColor(options.noColor, machineReadable);
    const updateNoticeEnabled = automaticUpdateNoticeEnabled(options, machineReadable);
    if (updateNoticeEnabled) startBackgroundUpdateRefresh();
    const progress = createProgressRenderer({
      enabled: Boolean(process.stdout.isTTY && !process.env.CI && !machineReadable),
      colorized,
    });
    let report: ScanReport;
    try {
      report = await runScan(
        options,
        (scanProgress) => progress.update(scanProgress),
      );
    } finally {
      progress.clear();
    }
    const compactJson = options.jsonCompact;
    const json = `${serializeReport(report, compactJson)}\n`;
    if (options.jsonOut) {
      const outputPath = path.resolve(process.cwd(), options.jsonOut);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, json);
    }
    if (options.outputDir) writeDiagnosticsDump(path.resolve(process.cwd(), options.outputDir), report);

    const config = loadConfigWithSource(process.cwd()).config;
    const showScore = options.showScore ?? true;
    const verbose = options.verbose ?? config.verbose ?? false;

    if (options.scoreOnly) process.stdout.write(`${report.score}\n`);
    else if (options.json) process.stdout.write(json);
    else if (options.annotations) {
      const annotations = renderAnnotations(report);
      if (annotations) process.stdout.write(`${annotations}\n`);
    } else process.stdout.write(`${renderTextReport(report, showScore, colorized, verbose, process.stdout.columns ?? 120)}\n`);

    if (updateNoticeEnabled) {
      const update = getCachedUpdateNotice(VERSION);
      if (update) process.stdout.write(`\n${renderUpdateNotice(update.current, update.latest, colorized)}\n`);
    }

    const blocking = options.blocking ?? config.blocking ?? "error";
    if (shouldBlock(report, blocking)) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`react-luau-doctor: ${message}\n`);
    process.exitCode = 2;
  }
}

void main();
