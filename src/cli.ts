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

import {
  checkForUpdatesNow,
  fetchChangelogReleases,
  getCachedUpdateNotice,
  refreshUpdateCache,
  startBackgroundUpdateRefresh,
  type ChangelogRelease,
} from "./update-check";

import {
  currentUpdateInstallCommand,
  installLatestVersion,
} from "./update-install";

import {
  WHY_ANSI, WHY_THEME, whyPaint, whySectionTitle, wrapWhyWords,
  renderWhyFixPreview, renderWhyDiagnostic,
} from "./why";
import { createProgressRenderer } from "./progress";
import { createInlineSuppressionChecker } from "./inline-disables";

import {
  renderAnnotations,
  renderRulesList,
  renderTextReport,
} from "./reporter";

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
  update --check                         Check npm and show release notes without updating

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

function automaticUpdateNoticeEnabled(
  options: CliOptions,
  machineReadable: boolean,
): boolean {
  return (
    !options.noUpdateCheck &&
    !machineReadable &&
    Boolean(process.stdout.isTTY) &&
    !process.env.CI &&
    process.env.NO_UPDATE_NOTIFIER === undefined &&
    process.env.REACT_LUAU_DOCTOR_NO_UPDATE_CHECK === undefined
  );
}

function renderUpdateHeader(
  current: string,
  latest: string,
  colorized: boolean,
): string {
  const label = whyPaint(
    colorized,
    "Update available:",
    WHY_ANSI.bold,
    WHY_ANSI.yellow,
  );

  const oldVersion = whyPaint(colorized, `v${current}`, WHY_ANSI.dim);
  const newVersion = whyPaint(colorized, `v${latest}`, WHY_ANSI.bold);

  return `${label} ${oldVersion} → ${newVersion}`;
}

function renderUpdateNotice(
  current: string,
  latest: string,
  colorized: boolean,
): string {
  return `${renderUpdateHeader(current, latest, colorized)}\nRun \`react-luau-doctor update --check\` to see what's new.`;
}

function renderChangelogInline(
  value: string,
  colorized: boolean,
  ...baseCodes: string[]
): string {
  if (!colorized) return value;

  const parts: string[] = [];
  let offset = 0;

  for (const match of value.matchAll(/`([^`\n]+)`/g)) {
    const index = match.index ?? 0;

    if (index > offset)
      parts.push(whyPaint(true, value.slice(offset, index), ...baseCodes));

    parts.push(whyPaint(true, match[1], WHY_THEME.variable));
    offset = index + match[0].length;
  }

  if (parts.length === 0) return whyPaint(true, value, ...baseCodes);

  if (offset < value.length)
    parts.push(whyPaint(true, value.slice(offset), ...baseCodes));

  return parts.join("");
}

function renderChangelogNotes(notes: string, colorized: boolean): string {
  return notes
    .split(/\r?\n/)
    .map((line) => {
      const heading = /^#{3,6}\s+(.+)$/.exec(line.trim());

      if (heading)
        return renderChangelogInline(heading[1], colorized, WHY_ANSI.bold);

      const bullet = /^(\s*)[-*]\s+(.+)$/.exec(line);

      if (bullet)
        return `${bullet[1] || "  "}• ${renderChangelogInline(bullet[2], colorized)}`;

      return renderChangelogInline(line, colorized);
    })
    .join("\n")
    .trim();
}

function renderUpdateCheck(
  current: string,
  latest: string,
  releases: ChangelogRelease[],
  releaseNotesUnavailable: boolean,
  colorized: boolean,
): string {
  const lines = [
    renderUpdateHeader(current, latest, colorized),
    "",
    whyPaint(colorized, "What's new", WHY_ANSI.bold),
  ];

  if (releaseNotesUnavailable) {
    lines.push("  Release notes could not be loaded from GitHub.");
  } else if (releases.length === 0) {
    lines.push("  No changelog entries were found between these versions.");
  } else {
    for (const release of releases) {
      lines.push("", whyPaint(colorized, `v${release.version}`, WHY_ANSI.bold));
      const notes = renderChangelogNotes(release.notes, colorized);

      if (notes) lines.push(notes);
    }
  }

  lines.push("", "Run `react-luau-doctor update` to update.");

  return lines.join("\n");
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
    let releases: ChangelogRelease[] = [];
    let releaseNotesUnavailable = false;

    try {
      releases = await fetchChangelogReleases(VERSION, result.latest);
    } catch {
      releaseNotesUnavailable = true;
    }

    process.stdout.write(
      `${renderUpdateCheck(VERSION, result.latest, releases, releaseNotesUnavailable, colorized)}\n`,
    );

    return;
  }

  const command = currentUpdateInstallCommand();

  if (!command) {
    throw new Error(
      `Could not determine the global package manager for this installation. Run \`npm install -g ${packageJson.name}@latest\` manually.`,
    );
  }

  const label = whyPaint(
    colorized,
    "Updating React-Luau Doctor:",
    WHY_ANSI.bold,
    WHY_ANSI.yellow,
  );

  const oldVersion = whyPaint(colorized, `v${VERSION}`, WHY_ANSI.dim);
  const newVersion = whyPaint(colorized, `v${result.latest}`, WHY_ANSI.bold);

  process.stdout.write(
    `${label} ${oldVersion} → ${newVersion}\nUsing \`${command.display}\`\n\n`,
  );

  installLatestVersion(command);
  process.stdout.write(`\nUpdated React-Luau Doctor to v${result.latest}.\n`);
}

function splitLongOption(arg: string): { name: string; inlineValue?: string } {
  if (!arg.startsWith("--")) return { name: arg };

  const equals = arg.indexOf("=");

  if (equals < 0) return { name: arg };

  return { name: arg.slice(0, equals), inlineValue: arg.slice(equals + 1) };
}

function requiredValue(
  argv: string[],
  index: number,
  name: string,
  inlineValue?: string,
): { value: string; nextIndex: number } {
  if (inlineValue !== undefined) {
    if (!inlineValue) throw new Error(`${name} requires a value`);

    return { value: inlineValue, nextIndex: index };
  }

  const value = argv[index + 1];

  if (!value || value.startsWith("-"))
    throw new Error(`${name} requires a value`);

  return { value, nextIndex: index + 1 };
}

function shouldUseColor(noColor = false, machineReadable = false): boolean {
  return (
    !noColor &&
    !machineReadable &&
    process.env.NO_COLOR === undefined &&
    Boolean(process.stdout.isTTY)
  );
}

function whyTextWidth(): number {
  return Math.max(60, (process.stdout.columns ?? 120) - 2);
}

function parseBlocking(value: string, name: string): BlockingLevel {
  if (!BLOCKING.has(value as BlockingLevel))
    throw new Error(`${name} must be error, warning, or none`);

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
    else if (arg === "--no-respect-inline-disables")
      options.respectInlineDisables = false;
    else if (arg === "--respect-inline-disables")
      options.respectInlineDisables = true;
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

      if (!SCOPES.has(parsed.value as ScanScope))
        throw new Error("--scope must be full, files, changed, or lines");

      options.scope = parsed.value as ScanScope;
      index = parsed.nextIndex;
    } else if (arg === "--base") {
      const parsed = requiredValue(argv, index, arg, inlineValue);
      options.base = parsed.value;
      index = parsed.nextIndex;
    } else if (arg === "--diff") {
      if (inlineValue !== undefined)
        options.diff =
          inlineValue === "false"
            ? false
            : inlineValue === "true"
              ? true
              : inlineValue;
      else {
        const next = argv[index + 1];

        if (next && !next.startsWith("-")) {
          options.diff =
            next === "false" ? false : next === "true" ? true : next;

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

      if (!Number.isFinite(seconds) || seconds <= 0)
        throw new Error("--max-duration must be a positive number of seconds");

      options.maxDurationSeconds = seconds;
      index = parsed.nextIndex;
    } else if (arg === "--blocking") {
      const parsed = requiredValue(argv, index, arg, inlineValue);
      options.blocking = parseBlocking(parsed.value, arg);
      index = parsed.nextIndex;
    } else if (arg === "--min-severity") {
      const parsed = requiredValue(argv, index, arg, inlineValue);

      if (!SEVERITIES.has(parsed.value as Severity))
        throw new Error("--min-severity must be suggestion, warning, or error");

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

function resolveScope(
  options: CliOptions,
  config: DoctorConfig,
): { scope: ScanScope; base?: string } {
  if (options.scope)
    return { scope: options.scope, base: options.base ?? config.base };

  if (options.diff !== undefined) {
    if (options.diff === false)
      return { scope: "full", base: options.base ?? config.base };

    return {
      scope: "changed",

      base:
        options.base ??
        (typeof options.diff === "string" ? options.diff : config.base),
    };
  }

  if (config.scope)
    return { scope: config.scope, base: options.base ?? config.base };

  if (config.diff !== undefined) {
    if (config.diff === false)
      return { scope: "full", base: options.base ?? config.base };

    return {
      scope: "changed",

      base:
        options.base ??
        (typeof config.diff === "string" ? config.diff : config.base),
    };
  }

  if (options.changedFilesFrom)
    return { scope: "files", base: options.base ?? config.base };

  return { scope: "full", base: options.base ?? config.base };
}

function validateModeFlags(options: CliOptions, scope: ScanScope): void {
  if (options.scope && options.diff !== undefined && options.diff !== false)
    throw new Error("Cannot combine --scope and --diff. Pick one mode");

  if (options.staged && options.diff !== undefined && options.diff !== false)
    throw new Error("Cannot combine --staged and --diff. Pick one mode");

  if (options.staged && (scope === "full" || scope === "changed")) {
    throw new Error(
      `Cannot combine --staged with --scope ${scope}. Use --scope files or --scope lines, or omit --scope`,
    );
  }

  if (options.includeUntracked && options.staged)
    throw new Error(
      "Cannot combine --include-untracked with --staged. The git index never holds untracked files",
    );

  if (options.includeUntracked && scope === "full")
    throw new Error(
      "--include-untracked requires files, changed, or lines scope",
    );

  if (options.scoreOnly && options.json)
    throw new Error("Cannot combine --score and --json. Pick one output mode");

  if (options.scoreOnly && options.showScore === false)
    throw new Error("Cannot combine --score with --no-score");

  if (options.annotations && (options.json || options.scoreOnly))
    throw new Error("--annotations cannot be combined with --json or --score");
}

function findProjectByName(root: string, name: string): string | null {
  const direct = path.resolve(root, name);

  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return direct;

  const ignored = new Set([
    ".git",
    "node_modules",
    "Packages",
    "DevPackages",
    "ServerPackages",
    "dist",
    "vendor",
  ]);

  const queue: Array<{ directory: string; depth: number }> = [
    { directory: root, depth: 0 },
  ];

  const matches: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current.depth >= 3) continue;

    for (const entry of fs.readdirSync(current.directory, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || ignored.has(entry.name)) continue;

      const absolute = path.join(current.directory, entry.name);

      if (entry.name === name) matches.push(absolute);

      queue.push({ directory: absolute, depth: current.depth + 1 });
    }
  }

  if (matches.length > 1)
    throw new Error(
      `Project selector "${name}" is ambiguous: ${matches.map((match) => path.relative(root, match)).join(", ")}`,
    );

  return matches[0] ?? null;
}

function resolveProjectRoots(
  root: string,
  projectFlag: string | undefined,
  config: DoctorConfig,
): string[] {
  const requested = projectFlag
    ? projectFlag
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : (config.projects ?? []);

  if (requested.length === 0) return [root];

  return [
    ...new Set(
      requested.map((project) => {
        const resolved = findProjectByName(root, project);

        if (!resolved) throw new Error(`Could not find project: ${project}`);

        return resolved;
      }),
    ),
  ];
}

function serializeReport(report: ScanReport, compact: boolean): string {
  return compact ? JSON.stringify(report) : JSON.stringify(report, null, 2);
}

function writeJsonFile(
  filename: string,
  value: unknown,
  compact = false,
): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true });

  fs.writeFileSync(
    filename,
    `${compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`,
  );
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

  if (level === "warning")
    return report.counts.error > 0 || report.counts.warning > 0;

  return report.counts.error > 0;
}

function findRule(requested: string): RuleDefinition {
  const rule = rules.find(
    (candidate) =>
      candidate.id === requested || candidate.id.endsWith(`/${requested}`),
  );

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
  return new Map(
    rules.map((rule) => [
      rule.id,
      effectiveSeverity(rule.severity, rule.id, config) ?? "off",
    ]),
  );
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
      process.stdout.write(
        `${JSON.stringify(
          filtered.map((rule) => ({
            id: rule.id,
            severity: severityMap.get(rule.id),
            defaultSeverity: rule.severity,
            category: rule.category,
            description: rule.description,
          })),
          null,
          2,
        )}\n`,
      );
    } else
      process.stdout.write(
        `${renderRulesList(filtered, process.stdout.columns ?? 120, severityMap, shouldUseColor(noColor))}\n`,
      );

    return;
  }

  if (action === "explain") {
    const requested = remaining[0];

    if (!requested) throw new Error("rules explain requires a rule id");

    const json = remaining.slice(1).includes("--json");
    const extra = remaining.slice(1).filter((arg) => arg !== "--json");

    if (extra.length > 0)
      throw new Error(`Unknown rules explain option: ${extra[0]}`);

    const rule = findRule(requested);

    const currentSeverity =
      effectiveSeverity(rule.severity, rule.id, config) ?? "off";

    const result = {
      id: rule.id,
      severity: currentSeverity,
      defaultSeverity: rule.severity,
      category: rule.category,
      description: rule.description,
      example: rule.guidance?.example,
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

      if (
        rule.guidance?.explanation &&
        rule.guidance.explanation !== rule.description
      ) {
        lines.push("", ...wrapWhyWords(rule.guidance.explanation, width));
      }

      if (rule.guidance?.help) {
        lines.push(
          "",
          whySectionTitle(colorized, "How to fix"),
          ...wrapWhyWords(rule.guidance.help, width),
        );
      }

      if (result.example) {
        lines.push(
          "",
          whySectionTitle(colorized, "Example fix"),
          ...renderWhyFixPreview(result.example, colorized, width),
        );
      }

      lines.push(
        "",
        ...wrapWhyWords(
          "This is an example pattern, not an automatic edit. To explain a finding in your code, run:",
          width,
        ),
        "  react-luau-doctor why <file:line>",
      );

      process.stdout.write(`${lines.join("\n")}\n`);
    }

    return;
  }

  if (action === "set") {
    const requested = remaining[0];
    const rawSeverity = remaining[1];

    if (!requested || !rawSeverity)
      throw new Error("rules set requires <rule> <severity>");

    const rule = findRule(requested);
    const severity = normalizeRuleSetting(rawSeverity);

    if (!severity)
      throw new Error(
        "Rule severity must be off, suggestion, warning/warn, or error",
      );

    const filename = writeConfig(cwd, (current) => ({
      ...current,
      rules: { ...current.rules, [rule.id]: severity },
    }));

    process.stdout.write(
      `Set ${rule.id} to ${severity} in ${path.relative(cwd, filename)}\n`,
    );

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

      if (!normalized || normalized === "off")
        throw new Error(
          "--severity must be suggestion, warning/warn, or error",
        );

      severity = normalized;
    }

    const filename = writeConfig(cwd, (current) => ({
      ...current,
      rules: { ...current.rules, [rule.id]: severity },
    }));

    process.stdout.write(
      `Enabled ${rule.id} at ${severity} in ${path.relative(cwd, filename)}\n`,
    );

    return;
  }

  if (action === "disable") {
    const requested = remaining[0];

    if (!requested) throw new Error("rules disable requires a rule id");

    const rule = findRule(requested);

    const filename = writeConfig(cwd, (current) => ({
      ...current,
      rules: { ...current.rules, [rule.id]: "off" },
    }));

    process.stdout.write(
      `Disabled ${rule.id} in ${path.relative(cwd, filename)}\n`,
    );

    return;
  }

  if (action === "category") {
    const rawCategory = remaining[0];
    const rawSeverity = remaining[1];

    if (!rawCategory || !rawSeverity)
      throw new Error("rules category requires <category> <severity>");

    const category = normalizeCategory(rawCategory);
    const severity = normalizeRuleSetting(rawSeverity);

    if (!category) throw new Error(`Unknown category: ${rawCategory}`);

    if (!severity)
      throw new Error(
        "Category severity must be off, suggestion, warning/warn, or error",
      );

    const categoryRules = rules.filter((rule) => rule.category === category);

    const filename = writeConfig(cwd, (current) => ({
      ...current,

      rules: Object.fromEntries([
        ...Object.entries(current.rules ?? {}),
        ...categoryRules.map((rule) => [rule.id, severity] as const),
      ]),
    }));

    process.stdout.write(
      `Set ${categoryRules.length} ${category} rules to ${severity} in ${path.relative(cwd, filename)}\n`,
    );

    return;
  }

  throw new Error(`Unknown rules command: ${action}`);
}

function whyLocationContains(
  location: Diagnostic["location"],
  line: number,
  column?: number,
): boolean {
  if (line < location.line || line > location.endLine) return false;

  if (column === undefined) return true;

  if (location.line === location.endLine)
    return column >= location.column && column <= location.endColumn;

  if (line === location.line) return column >= location.column;

  if (line === location.endLine) return column <= location.endColumn;

  return true;
}

function whyLocationMatches(
  diagnostic: Diagnostic,
  line: number,
  column?: number,
): boolean {
  if (whyLocationContains(diagnostic.location, line, column)) return true;

  return (diagnostic.highlights ?? []).some((location) =>
    whyLocationContains(location, line, column),
  );
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

  if (!fs.existsSync(filename))
    throw new Error(`File does not exist: ${match[1]}`);

  const colorized = shouldUseColor(noColor, false);
  const source = fs.readFileSync(filename, "utf8");
  const isSuppressed = createInlineSuppressionChecker(source);
  const auditReport = await scanWhyFile(filename, cwd, cache, onProgress);
  // `why` renders its own output before returning to the CLI entry point. Clear
  // the transient progress line here so the diagnostic never starts on the same
  // terminal row as a completed progress bar.
  beforeOutput?.();

  const matching = auditReport.diagnostics.filter((diagnostic) =>
    whyLocationMatches(diagnostic, line, column),
  );

  const visible = matching.filter(
    (diagnostic) => !isSuppressed(diagnostic.rule, diagnostic.location.line),
  );

  if (visible.length > 0) {
    for (let index = 0; index < visible.length; index += 1) {
      if (index > 0) process.stdout.write("\n");

      process.stdout.write(
        renderWhyDiagnostic(source, visible[index], colorized, whyTextWidth()),
      );
    }

    return;
  }

  const suppressed = matching.filter((diagnostic) =>
    isSuppressed(diagnostic.rule, diagnostic.location.line),
  );

  if (suppressed.length > 0) {
    process.stdout.write(
      `No visible diagnostic at ${location}. ${suppressed.length} diagnostic${suppressed.length === 1 ? " is" : "s are"} hidden by an inline react-luau-doctor suppression.\n\n`,
    );

    for (let index = 0; index < suppressed.length; index += 1) {
      if (index > 0) process.stdout.write("\n");

      process.stdout.write(
        renderWhyDiagnostic(source, suppressed[index], colorized, whyTextWidth()),
      );
    }

    return;
  }

  const nearby = auditReport.diagnostics
    .filter(
      (diagnostic) => !isSuppressed(diagnostic.rule, diagnostic.location.line),
    )
    .filter((diagnostic) => Math.abs(diagnostic.location.line - line) <= 3)
    .sort(
      (a, b) =>
        Math.abs(a.location.line - line) - Math.abs(b.location.line - line),
    );

  process.stdout.write(
    `No React-Luau Doctor diagnostic found at ${location}.\n`,
  );

  if (nearby.length > 0) {
    process.stdout.write("Nearby diagnostics in this file:\n");

    for (const diagnostic of nearby.slice(0, 5)) {
      process.stdout.write(
        `  ${diagnostic.file}:${diagnostic.location.line}:${diagnostic.location.column}  ${diagnostic.rule}\n`,
      );
    }
  }
}

function pathIsInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);

  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function runScan(
  options: CliOptions,
  onProgress?: (progress: ScanProgress) => void,
): Promise<ScanReport> {
  const commandRoot = process.cwd();
  const target = path.resolve(commandRoot, options.target);

  if (!fs.existsSync(target))
    throw new Error(`Scan path does not exist: ${options.target}`);

  const targetStat = fs.statSync(target);
  const scanRoot = targetStat.isFile() ? path.dirname(target) : target;

  // CLI configuration is owned by the directory the command was launched from.
  // Narrowing the scan target must not silently switch to a different config.
  const loaded = loadConfigWithSource(commandRoot);
  const config = loaded.config;
  const resolvedScope = resolveScope(options, config);

  const scope =
    options.staged && options.scope === undefined
      ? "files"
      : resolvedScope.scope;

  validateModeFlags(options, scope);

  if (
    targetStat.isFile() &&
    (scope !== "full" || options.staged || options.changedFilesFrom)
  ) {
    throw new Error(
      "Git scopes require a directory target. Scan the containing project directory instead",
    );
  }

  const targetInsideCommandRoot = pathIsInside(commandRoot, target);
  const selectionRoot = targetInsideCommandRoot ? commandRoot : scanRoot;

  const requestedProjectRoots = resolveProjectRoots(
    selectionRoot,
    options.project,
    config,
  );

  const projectTargets = requestedProjectRoots.flatMap((projectRoot) => {
    if (pathIsInside(projectRoot, target))
      return [{ projectRoot, targetRoot: target }];

    if (pathIsInside(target, projectRoot))
      return [{ projectRoot, targetRoot: projectRoot }];

    return [];
  });

  if (projectTargets.length === 0) {
    throw new Error(
      `Scan target is outside the selected project${requestedProjectRoots.length === 1 ? "" : "s"}: ${options.target}`,
    );
  }

  const displayRoot = targetInsideCommandRoot ? commandRoot : selectionRoot;

  const minSeverity =
    (options.warnings ?? config.warnings ?? true)
      ? (options.minSeverity ?? "suggestion")
      : "error";

  const categories =
    options.categories.length > 0 ? options.categories : config.categories;

  const respectInlineDisables =
    options.respectInlineDisables ?? config.respectInlineDisables ?? true;

  const deadlineAt =
    options.maxDurationSeconds !== undefined
      ? performance.now() + options.maxDurationSeconds * 1000
      : undefined;

  const reports: Array<{ projectRoot: string; report: ScanReport }> = [];

  for (const { projectRoot, targetRoot } of projectTargets) {
    let report: ScanReport;

    const projectName =
      projectTargets.length > 1
        ? path.relative(displayRoot, projectRoot) || "."
        : undefined;

    const projectProgress = onProgress
      ? (progress: ScanProgress) =>
          onProgress({
            ...progress,

            phase:
              [projectName, progress.phase].filter(Boolean).join(":") ||
              undefined,

            label:
              projectName && progress.label
                ? `${projectName}: ${progress.label}`
                : progress.label,
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

      const unknown = remaining.filter(
        (arg) => arg !== "--no-color" && arg !== "--no-cache",
      );

      if (unknown.length > 0)
        throw new Error(`Unknown why option: ${unknown[0]}`);

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
      process.stdout.write(
        `React-Luau Doctor ${VERSION}\nBun ${Bun.version}\n${process.platform} ${process.arch}\n${os.release()}\n`,
      );

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

    const machineReadable =
      options.scoreOnly || options.json || options.annotations;

    const colorized = shouldUseColor(options.noColor, machineReadable);

    const updateNoticeEnabled = automaticUpdateNoticeEnabled(
      options,
      machineReadable,
    );

    if (updateNoticeEnabled) startBackgroundUpdateRefresh();

    const progress = createProgressRenderer({
      enabled: Boolean(
        process.stdout.isTTY && !process.env.CI && !machineReadable,
      ),

      colorized,
    });

    let report: ScanReport;

    try {
      report = await runScan(options, (scanProgress) =>
        progress.update(scanProgress),
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

    if (options.outputDir)
      writeDiagnosticsDump(
        path.resolve(process.cwd(), options.outputDir),
        report,
      );

    const config = loadConfigWithSource(process.cwd()).config;
    const showScore = options.showScore ?? true;
    const verbose = options.verbose ?? config.verbose ?? false;

    if (options.scoreOnly) process.stdout.write(`${report.score}\n`);
    else if (options.json) process.stdout.write(json);
    else if (options.annotations) {
      const annotations = renderAnnotations(report);

      if (annotations) process.stdout.write(`${annotations}\n`);
    } else
      process.stdout.write(
        `${renderTextReport(report, showScore, colorized, verbose, process.stdout.columns ?? 120)}\n`,
      );

    if (updateNoticeEnabled) {
      const update = getCachedUpdateNotice(VERSION);

      if (update)
        process.stdout.write(
          `\n${renderUpdateNotice(update.current, update.latest, colorized)}\n`,
        );
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
