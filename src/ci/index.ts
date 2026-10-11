import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { isSelectedLuauPath } from "../files";
import { loadConfigWithSource } from "../config";
import { createGitScopePlan, findGitRoot, gitExecutable } from "../git";
import { renderAnnotations, renderTextReport } from "../reporter";
import { diagnosticDifference, renderSummaryComment, type FixedDiagnostic } from "./report";
import {
  GitHubClient,
  StalePublication,
  readReviewState,
  reconcileReviews,
  reviewSnapshot,
  type ReviewAnalysis,
  type ReviewFinding,
  type ReviewSnapshot,
} from "./github";
import { aggregateReports, scanProjectWithScope, type ScopedScanOptions } from "../scope";
import { scanPath } from "../scanner";
import type { BlockingLevel, Diagnostic, ScanReport, ScanScope } from "../types";
import packageJson from "../../package.json";

export type CiProvider = "github" | "gitlab";

interface CiSettings {
  provider: CiProvider;
  blocking: BlockingLevel;
  scope: ScanScope;
  comment: boolean;
  reviewComments: boolean;
  commitStatus: boolean;
  directory: string;
  project: string;
}

interface CiManageOptions extends Partial<CiSettings> {
  cwd: string;
  yes: boolean;
  pr: boolean;
}

interface GitHubEvent {
  action?: string;
  before?: string;
  pull_request?: {
    number: number;
    base: { sha: string; ref: string };
    head: { sha: string; ref: string };
  };
  repository?: { full_name?: string };
}

const DEFAULT_SETTINGS: CiSettings = {
  provider: "github",
  blocking: "none",
  scope: "changed",
  comment: true,
  reviewComments: true,
  commitStatus: true,
  directory: ".",
  project: "*",
};

const GITHUB_WORKFLOW = path.join(".github", "workflows", "react-luau-doctor.yml");
const GITLAB_WORKFLOW = ".gitlab-ci.yml";
const PACKAGE_SPEC = `${packageJson.name}@${packageJson.version}`;
function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function renderGitHubWorkflow(settings: CiSettings): string {
  return `name: React-Luau Doctor
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  push:
    branches: [main]

permissions:
  contents: read
  pull-requests: write
  statuses: write

concurrency:
  group: react-luau-doctor-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  react-luau-doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
          ref: \${{ github.event.pull_request.head.sha || github.sha }}
          persist-credentials: false
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.4.0"
      - id: doctor
        env:
          GITHUB_TOKEN: \${{ github.token }}
          DOCTOR_DIRECTORY: ${yamlString(settings.directory)}
          DOCTOR_PROJECT: ${yamlString(settings.project)}
          DOCTOR_BLOCKING: ${settings.blocking}
          DOCTOR_SCOPE: ${settings.scope}
        run: >-
          bunx --bun ${PACKAGE_SPEC} ci run
          --directory "$DOCTOR_DIRECTORY"
          --project "$DOCTOR_PROJECT"
          --blocking "$DOCTOR_BLOCKING"
          --scope "$DOCTOR_SCOPE"
          ${settings.comment ? "--comment" : "--no-comment"}
          ${settings.reviewComments ? "--review-comments" : "--no-review-comments"}
          ${settings.commitStatus ? "--commit-status" : "--no-commit-status"}
      - name: Upload full Doctor report
        if: always() && steps.doctor.outputs.report-path != ''
        uses: actions/upload-artifact@v4
        with:
          name: react-luau-doctor-report
          path: \${{ steps.doctor.outputs.report-path }}
`;
}

export function renderGitLabWorkflow(settings: CiSettings): string {
  return `stages:
  - test

react-luau-doctor:
  stage: test
  image: oven/bun:1.4.0
  variables:
    GIT_DEPTH: "0"
    DOCTOR_DIRECTORY: ${yamlString(settings.directory)}
    DOCTOR_SCOPE: ${yamlString(settings.scope)}
    DOCTOR_BLOCKING: ${yamlString(settings.blocking)}
  before_script:
    - apt-get update -qq && apt-get install -y --no-install-recommends git
  script:
    - 'bunx --bun ${PACKAGE_SPEC} "$DOCTOR_DIRECTORY" --scope "$DOCTOR_SCOPE" --blocking "$DOCTOR_BLOCKING" --no-color'
`;
}

function parseBoolean(value: string, name: string): boolean {
  if (value === "true") return true;

  if (value === "false") return false;

  throw new Error(`${name} must be true or false`);
}

function parseBlocking(value: string): BlockingLevel {
  if (value !== "error" && value !== "warning" && value !== "none") {
    throw new Error("--blocking must be error, warning, or none");
  }

  return value;
}

function parseScope(value: string): ScanScope {
  if (value !== "full" && value !== "files" && value !== "changed" && value !== "lines") {
    throw new Error("--scope must be full, files, changed, or lines");
  }

  return value;
}

function parseProvider(value: string): CiProvider {
  if (value !== "github" && value !== "gitlab") {
    throw new Error("--provider must be github or gitlab");
  }

  return value;
}

function nextValue(
  argv: string[],
  index: number,
  flag: string,
): { value: string; nextIndex: number } {
  const value = argv[index + 1];

  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);

  return { value, nextIndex: index + 1 };
}

function parseCiManageOptions(
  argv: string[],
  action: "install" | "config" | "upgrade",
): CiManageOptions {
  const options: CiManageOptions = { cwd: process.cwd(), yes: false, pr: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--pr") {
      if (action === "config") throw new Error("ci config does not accept --pr");

      options.pr = true;
    } else if (arg === "--cwd") {
      const parsed = nextValue(argv, index, arg);
      options.cwd = path.resolve(parsed.value);
      index = parsed.nextIndex;
    } else if (arg === "--provider") {
      const parsed = nextValue(argv, index, arg);
      options.provider = parseProvider(parsed.value);
      index = parsed.nextIndex;
    } else if (arg === "--blocking") {
      const parsed = nextValue(argv, index, arg);
      options.blocking = parseBlocking(parsed.value);
      index = parsed.nextIndex;
    } else if (arg === "--scope") {
      const parsed = nextValue(argv, index, arg);
      options.scope = parseScope(parsed.value);
      index = parsed.nextIndex;
    } else if (arg === "--comment") options.comment = true;
    else if (arg === "--no-comment") options.comment = false;
    else if (arg === "--review-comments") options.reviewComments = true;
    else if (arg === "--no-review-comments") options.reviewComments = false;
    else if (arg === "--commit-status") options.commitStatus = true;
    else if (arg === "--no-commit-status") options.commitStatus = false;
    else throw new Error(`Unknown ci ${action} option: ${arg}`);
  }

  return options;
}

function parseManagedWorkflowSettings(filename: string): Partial<CiSettings> {
  if (!fs.existsSync(filename)) return {};

  const text = fs.readFileSync(filename, "utf8");
  const match = (name: string): string | undefined =>
    text.match(new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, "m"))?.[1]?.replace(/^['"]|['"]$/g, "");
  const result: Partial<CiSettings> = {
    provider: filename.endsWith(".gitlab-ci.yml") ? "gitlab" : "github",
  };
  const blocking = match("DOCTOR_BLOCKING") ?? match("blocking");
  const scope = match("DOCTOR_SCOPE") ?? match("scope");
  const project = match("DOCTOR_PROJECT") ?? match("project");
  const directory = match("DOCTOR_DIRECTORY") ?? match("directory");
  const flag = (enabled: string, disabled: string): boolean | undefined => {
    if (text.includes(disabled)) return false;

    if (text.includes(enabled)) return true;

    return undefined;
  };
  const comment = match("comment") ?? flag("--comment", "--no-comment")?.toString();
  const reviewComments =
    match("review-comments") ?? flag("--review-comments", "--no-review-comments")?.toString();
  const commitStatus =
    match("commit-status") ?? flag("--commit-status", "--no-commit-status")?.toString();

  if (blocking) result.blocking = parseBlocking(blocking);

  if (scope) result.scope = parseScope(scope);

  if (comment) result.comment = parseBoolean(comment, "comment");

  if (reviewComments) result.reviewComments = parseBoolean(reviewComments, "review-comments");

  if (commitStatus) result.commitStatus = parseBoolean(commitStatus, "commit-status");

  if (project) result.project = project;

  if (directory) result.directory = directory;

  return result;
}

function existingProvider(cwd: string): CiProvider | null {
  if (fs.existsSync(path.join(cwd, GITHUB_WORKFLOW))) return "github";

  if (fs.existsSync(path.join(cwd, GITLAB_WORKFLOW))) return "gitlab";

  return null;
}

async function askChoice(question: string, choices: string[], fallback: string): Promise<string> {
  const rl = readline.createInterface({ input, output });

  try {
    const answer = (await rl.question(`${question} (${choices.join("/")}) [${fallback}]: `)).trim();

    return answer || fallback;
  } finally {
    rl.close();
  }
}

async function completeSettings(
  options: CiManageOptions,
  current: Partial<CiSettings>,
  action: "install" | "config" | "upgrade",
): Promise<CiSettings> {
  const settings: CiSettings = { ...DEFAULT_SETTINGS, ...current, ...options };

  if (options.yes || action === "upgrade") return settings;

  settings.provider = parseProvider(
    await askChoice("CI provider", ["github", "gitlab"], settings.provider),
  );
  settings.blocking = parseBlocking(
    await askChoice("Blocking level", ["none", "error", "warning"], settings.blocking),
  );
  settings.scope = parseScope(
    await askChoice(
      "Pull request scan scope",
      ["changed", "files", "lines", "full"],
      settings.scope,
    ),
  );

  if (settings.provider === "github") {
    settings.comment = parseBoolean(
      await askChoice("Sticky PR summary comment", ["true", "false"], String(settings.comment)),
      "comment",
    );
    settings.reviewComments = parseBoolean(
      await askChoice("Inline review comments", ["true", "false"], String(settings.reviewComments)),
      "review-comments",
    );
    settings.commitStatus = parseBoolean(
      await askChoice("Commit status", ["true", "false"], String(settings.commitStatus)),
      "commit-status",
    );
  }

  return settings;
}

function writeManagedCi(cwd: string, settings: CiSettings): string[] {
  if (settings.provider === "github") {
    const workflow = path.join(cwd, GITHUB_WORKFLOW);
    fs.mkdirSync(path.dirname(workflow), { recursive: true });
    fs.writeFileSync(workflow, renderGitHubWorkflow(settings));

    return [workflow];
  }

  const workflow = path.join(cwd, GITLAB_WORKFLOW);

  if (fs.existsSync(workflow) && !fs.readFileSync(workflow, "utf8").includes("react-luau-doctor")) {
    throw new Error(
      ".gitlab-ci.yml already exists and is not managed by React-Luau Doctor; add the generated job manually instead of overwriting it",
    );
  }

  fs.writeFileSync(workflow, renderGitLabWorkflow(settings));

  return [workflow];
}

function runCommand(cwd: string, command: string, args: string[], allowFailure = false): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });

  if (result.error) {
    if (allowFailure) return "";

    throw new Error(`${command} failed: ${result.error.message}`);
  }

  if ((result.status ?? 1) !== 0) {
    if (allowFailure) return "";

    throw new Error(
      `${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`,
    );
  }

  return (result.stdout ?? "").trim();
}

function openPullRequest(cwd: string, files: string[], action: "install" | "upgrade"): void {
  findGitRoot(cwd);

  if (!runCommand(cwd, "gh", ["--version"], true)) {
    throw new Error("--pr requires the GitHub CLI (gh) to be installed and authenticated");
  }

  const branch =
    action === "install" ? "chore/add-react-luau-doctor-ci" : "chore/upgrade-react-luau-doctor-ci";
  const title = action === "install" ? "Add React-Luau Doctor CI" : "Upgrade React-Luau Doctor CI";
  runCommand(cwd, "git", ["switch", "-c", branch]);
  runCommand(cwd, "git", ["add", "--", ...files.map((file) => path.relative(cwd, file))]);
  runCommand(cwd, "git", ["commit", "-m", title]);
  runCommand(cwd, "git", ["push", "-u", "origin", branch]);
  const url = runCommand(cwd, "gh", [
    "pr",
    "create",
    "--title",
    title,
    "--body",
    "Adds React-Luau Doctor pull request analysis.",
  ]);
  process.stdout.write(`${url}\n`);
}

async function runCiManage(
  action: "install" | "config" | "upgrade",
  argv: string[],
): Promise<void> {
  const options = parseCiManageOptions(argv, action);
  const provider = options.provider ?? existingProvider(options.cwd) ?? DEFAULT_SETTINGS.provider;
  const workflowPath = path.join(
    options.cwd,
    provider === "github" ? GITHUB_WORKFLOW : GITLAB_WORKFLOW,
  );
  const current = parseManagedWorkflowSettings(workflowPath);
  const settings = await completeSettings({ ...options, provider }, current, action);

  if (action === "install" && fs.existsSync(workflowPath) && !options.yes) {
    const overwrite = await askChoice(
      `${path.relative(options.cwd, workflowPath)} already exists. Replace it`,
      ["true", "false"],
      "false",
    );

    if (overwrite !== "true") return;
  }

  const files = writeManagedCi(options.cwd, settings);

  for (const filename of files) {
    process.stdout.write(
      `${action === "install" ? "Installed" : action === "config" ? "Updated" : "Upgraded"} ${path.relative(options.cwd, filename)}\n`,
    );
  }

  if (options.pr) openPullRequest(options.cwd, files, action === "install" ? "install" : "upgrade");
}

function resolveCiProjectRoots(directory: string, project: string): string[] {
  if (!project || project === "*") return [directory];

  return project.split(",").map((entry) => {
    const resolved = path.resolve(directory, entry.trim());

    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Could not find project: ${entry}`);
    }

    return resolved;
  });
}

function gitResult(directory: string, args: string[]): string | null {
  const result = spawnSync(gitExecutable, args, {
    cwd: directory,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });

  return result.status === 0 ? result.stdout : null;
}

function renameResolver(directory: string, head: string): ReviewAnalysis["canonicalFile"] {
  const cache = new Map<string, Map<string, string> | null>();

  return (file, commit) => {
    if (!commit) return file;

    if (!cache.has(commit)) {
      const diff = gitResult(directory, [
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        commit,
        head,
      ]);
      const renames = new Map<string, string>();

      if (diff !== null) {
        const fields = diff.split("\0");

        for (let i = 0; i < fields.length && fields[i]; ) {
          const status = fields[i++];
          const oldPath = fields[i++];

          if (/^[RC]/.test(status)) {
            const newPath = fields[i++];

            if (status.startsWith("R")) renames.set(oldPath, newPath);
          }
        }
      }

      cache.set(commit, diff === null ? null : renames);
    }

    const renames = cache.get(commit);

    return renames ? (renames.get(file) ?? file) : null;
  };
}

interface CiScan {
  repoRoot: string;
  report: ScanReport;
  comparison: ScanReport;
  fixed: FixedDiagnostic[];
  analysis: ReviewAnalysis;
}

async function scanForCi(
  settings: CiSettings,
  isPullRequest: boolean,
  base: string | undefined,
  head: string,
  snapshot?: ReviewSnapshot,
): Promise<CiScan> {
  const directory = path.resolve(settings.directory);
  const repoRoot = isPullRequest ? findGitRoot(directory) : directory;
  const roots = resolveCiProjectRoots(directory, settings.project);
  const canonicalFile = renameResolver(repoRoot, head);
  const historicalFiles = new Set<string>();

  for (const review of snapshot?.reviews ?? []) {
    const state = readReviewState(review.body ?? "");

    if (!state) continue;

    for (const finding of state.findings) {
      const file = canonicalFile(finding.file, state.commit);

      if (file) historicalFiles.add(file);
    }
  }

  for (const comment of snapshot?.comments ?? []) {
    if (
      comment.user?.type === "Bot" &&
      comment.body?.startsWith("<!-- react-luau-doctor:review -->")
    ) {
      const file = canonicalFile(comment.path, comment.commit_id ?? "");

      if (file) historicalFiles.add(file);
    }
  }

  const reports: Array<{ projectRoot: string; report: ScanReport }> = [];
  const comparisons: Array<{ projectRoot: string; report: ScanReport }> = [];
  const currentDiagnostics: Diagnostic[] = [];
  const fixed: FixedDiagnostic[] = [];
  const verifiedFiles = new Set<string>();
  const deletedFiles = new Set<string>();
  const uncertainFiles = new Set<string>();
  const unverifiedFiles = new Set<string>();
  const verificationSkippedFiles = new Set<string>();
  const configs = roots.map((root) => ({ root, config: loadConfigWithSource(root).config }));
  const signature = createHash("sha256")
    .update(
      JSON.stringify({
        version: packageJson.version,
        configs: configs.map(({ root, config }) => ({
          root: path.relative(directory, root),
          config,
        })),
      }),
    )
    .digest("hex");
  let complete = true;
  let potentiallyRelocated = false;
  const normalize = (file: string) => file.split(path.sep).join("/");
  const relativeFile = (file: string, root: string) =>
    normalize(path.relative(directory, path.resolve(root, file)));
  const rebaseDiagnostic = (diagnostic: Diagnostic, root: string): Diagnostic => ({
    ...diagnostic,
    file: relativeFile(diagnostic.file, root),
  });

  for (const { root: projectRoot, config } of configs) {
    const sources = new Map<string, string>();
    const eligibleFiles = new Set<string>();
    const scope = isPullRequest ? settings.scope : "full";
    const comparisonOptions = {
      scope: "changed" as const,
      base,
      config,
      minSeverity: "suggestion" as const,
      categories: config.categories,
      respectInlineDisables: config.respectInlineDisables ?? true,
      onDelta: (
        current: Diagnostic[],
        baseline: Diagnostic[],
        context: Parameters<NonNullable<ScopedScanOptions["onDelta"]>>[2],
      ) => {
        complete &&=
          !context.current.partial &&
          !context.baseline.partial &&
          !context.current.unverifiedFiles?.length &&
          !context.baseline.unverifiedFiles?.length;

        for (const file of [
          ...(context.current.unverifiedFiles ?? []),
          ...(context.baseline.unverifiedFiles ?? []),
        ]) {
          unverifiedFiles.add(relativeFile(file, projectRoot));
        }

        const skipped = new Set([
          ...(context.current.skippedFiles ?? []),
          ...(context.baseline.skippedFiles ?? []),
        ]);
        const currentFiles = new Set(context.plan.currentFiles.map((file) => file.relativePath));

        for (const file of context.plan.changedFiles) {
          const repoFile = repoRelativeDiagnosticPath(projectRoot, file, repoRoot);
          eligibleFiles.add(repoFile);

          if (!currentFiles.has(file)) deletedFiles.add(repoFile);

          if (!skipped.has(file)) verifiedFiles.add(repoFile);
        }

        for (const input of context.plan.currentFiles) {
          if (input.relativePath && input.source !== undefined) {
            sources.set(
              repoRelativeDiagnosticPath(projectRoot, input.relativePath, repoRoot),
              input.source,
            );
          }
        }

        for (const diagnostic of current) {
          currentDiagnostics.push(rebaseDiagnostic(diagnostic, projectRoot));
        }

        if (complete) {
          const baselineSources = new Map(
            context.plan.baselineFiles.map((file) => [
              file.relativePath,
              file.source?.split(/\r?\n/) ?? [],
            ]),
          );
          const currentSources = new Map(
            context.plan.currentFiles.map((file) => [
              file.relativePath,
              file.source?.split(/\r?\n/) ?? [],
            ]),
          );

          for (const diagnostic of diagnosticDifference(baseline, current, {
            left: (entry) =>
              baselineSources.get(entry.file)?.[entry.location.line - 1]?.trim() ?? "",
            right: (entry) =>
              currentSources.get(entry.file)?.[entry.location.line - 1]?.trim() ?? "",
          })) {
            if (
              !currentFiles.has(diagnostic.file) &&
              current.some(
                (entry) =>
                  entry.file !== diagnostic.file &&
                  entry.rule === diagnostic.rule &&
                  entry.severity === diagnostic.severity &&
                  entry.message === diagnostic.message,
              )
            ) {
              potentiallyRelocated = true;
              continue;
            }

            const oldFile = context.plan.baselinePaths.get(diagnostic.file) ?? diagnostic.file;
            const oldSource =
              context.plan.baselineFiles.find((file) => file.relativePath === diagnostic.file)
                ?.source ?? "";
            const newSource =
              sources.get(repoRelativeDiagnosticPath(projectRoot, diagnostic.file, repoRoot)) ?? "";
            // Suppression changes cannot establish that the underlying issue was fixed
            const directives = (source: string) =>
              source
                .split(/\r?\n/)
                .filter((line) => /react-luau-doctor.*(?:disable|ignore)/i.test(line))
                .join("\n");

            if (directives(oldSource) !== directives(newSource)) continue;

            fixed.push({
              ...rebaseDiagnostic({ ...diagnostic, file: oldFile }, projectRoot),
              ...(diagnostic.baselineLocationUncertain ? { baselineLocationUncertain: true } : {}),
            });
          }
        }
      },
    };
    const report = await scanProjectWithScope(projectRoot, { ...comparisonOptions, scope });
    reports.push({ projectRoot, report });

    for (const file of report.unverifiedFiles ?? []) {
      unverifiedFiles.add(relativeFile(file, projectRoot));
    }

    complete &&= !report.partial && !report.unverifiedFiles?.length;

    if (isPullRequest && base) {
      const comparison =
        scope === "changed" ? report : await scanProjectWithScope(projectRoot, comparisonOptions);
      comparisons.push({ projectRoot, report: comparison });
      // Only historical files outside the current PR diff need a supplementary scan
      const extraFiles: Array<{ absolutePath: string; relativePath: string; source: string }> = [];

      for (const file of historicalFiles) {
        const absolutePath = path.resolve(repoRoot, file);
        const relativePath = normalize(path.relative(projectRoot, absolutePath));

        if (
          relativePath.startsWith("../") ||
          path.isAbsolute(relativePath) ||
          !isSelectedLuauPath(relativePath, config) ||
          eligibleFiles.has(file)
        ) {
          continue;
        }

        eligibleFiles.add(file);

        if (!fs.existsSync(absolutePath)) {
          const existsAtHead = gitResult(repoRoot, ["ls-tree", "-z", head, "--", file]);

          if (existsAtHead === "") {
            verifiedFiles.add(file);
            deletedFiles.add(file);
          }

          continue;
        }

        const source = fs.readFileSync(absolutePath, "utf8");
        sources.set(file, source);
        extraFiles.push({ absolutePath, relativePath, source });
      }

      if (extraFiles.length) {
        const extra = await scanPath(projectRoot, {
          files: extraFiles,
          projectRoot,
          config,
          categories: config.categories,
        });
        complete &&= !extra.partial && !extra.unverifiedFiles?.length;

        for (const file of extra.unverifiedFiles ?? []) {
          unverifiedFiles.add(relativeFile(file, projectRoot));
        }

        for (const file of extra.skippedFiles ?? []) {
          verificationSkippedFiles.add(relativeFile(file, projectRoot));
        }

        for (const file of extraFiles) {
          if (!extra.skippedFiles?.includes(file.relativePath)) {
            verifiedFiles.add(repoRelativeDiagnosticPath(projectRoot, file.relativePath, repoRoot));
          }
        }

        currentDiagnostics.push(
          ...extra.diagnostics.map((diagnostic) => rebaseDiagnostic(diagnostic, projectRoot)),
        );
      }
    }

    for (const [file, source] of sources) {
      if (/react-luau-doctor.*(?:disable|ignore)/i.test(source)) uncertainFiles.add(file);
    }
  }

  const report =
    roots.length === 1 && roots[0] === directory
      ? reports[0].report
      : aggregateReports(directory, reports);
  const comparison = comparisons.length ? aggregateReports(directory, comparisons) : report;
  const sourceCache = new Map<string, string[]>();
  const toFinding = (diagnostic: Diagnostic): ReviewFinding => {
    const file = repoRelativeDiagnosticPath(directory, diagnostic.file, repoRoot);
    const absolute = path.resolve(repoRoot, file);

    if (!sourceCache.has(file)) {
      sourceCache.set(
        file,
        fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8").split(/\r?\n/) : [],
      );
    }

    return {
      file,
      rule: diagnostic.rule,
      severity: diagnostic.severity,
      message: diagnostic.message,
      line: diagnostic.location.line,
      column: diagnostic.location.column,
      diagnosticId: diagnostic.id,
      anchor: createHash("sha256")
        .update(sourceCache.get(file)?.[diagnostic.location.line - 1]?.trim() ?? "")
        .digest("hex")
        .slice(0, 16),
      status: "active",
    };
  };

  return {
    repoRoot,
    report: {
      ...report,
      partial: Boolean(report.partial) || !complete,
      unverifiedFiles: unverifiedFiles.size ? [...unverifiedFiles].sort() : undefined,
      skippedFiles: [
        ...new Set([...(report.skippedFiles ?? []), ...verificationSkippedFiles]),
      ].sort(),
      notes: potentiallyRelocated
        ? [
            ...(report.notes ?? []),
            "Some removed findings may have moved to other files and were not counted as fixed",
          ]
        : report.notes,
    },
    comparison,
    fixed: complete ? fixed : [],
    analysis: {
      signature,
      complete,
      current: currentDiagnostics.map(toFinding),
      introduced: comparison.diagnostics.map((diagnostic) => ({
        diagnostic,
        finding: toFinding(diagnostic),
      })),
      verifiedFiles,
      deletedFiles,
      canonicalFile,
      eligible: (finding) =>
        !uncertainFiles.has(finding.file) &&
        configs.some(({ root, config }) => {
          const relative = normalize(path.relative(root, path.resolve(repoRoot, finding.file)));

          return (
            !relative.startsWith("../") &&
            !path.isAbsolute(relative) &&
            isSelectedLuauPath(relative, config) &&
            config.rules?.[finding.rule] !== "off"
          );
        }),
    },
  };
}

function shouldBlock(report: ScanReport, level: BlockingLevel): boolean {
  if (level === "none") return false;

  if (level === "warning") return report.counts.error > 0 || report.counts.warning > 0;

  return report.counts.error > 0;
}

function affectedFiles(report: ScanReport): number {
  return new Set(report.diagnostics.map((diagnostic) => diagnostic.file)).size;
}

function writeOutput(name: string, value: string | number): void {
  const outputFile = process.env.GITHUB_OUTPUT;

  if (!outputFile) return;

  fs.appendFileSync(outputFile, `${name}=${value}\n`);
}

function githubEvent(): GitHubEvent {
  const filename = process.env.GITHUB_EVENT_PATH;

  if (!filename || !fs.existsSync(filename)) return {};

  return JSON.parse(fs.readFileSync(filename, "utf8")) as GitHubEvent;
}

function githubRepo(event: GitHubEvent): string | null {
  return process.env.GITHUB_REPOSITORY ?? event.repository?.full_name ?? null;
}

function githubRunUrl(): string | null {
  const server = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;

  return server && repository && runId ? `${server}/${repository}/actions/runs/${runId}` : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function repoRelativeDiagnosticPath(
  directory: string,
  diagnosticFile: string,
  repoRoot: string,
): string {
  const absoluteDirectory = path.resolve(directory);
  const prefix = path.relative(repoRoot, absoluteDirectory).split(path.sep).join("/");

  return prefix && prefix !== "." ? path.posix.join(prefix, diagnosticFile) : diagnosticFile;
}

function githubFileUrl(
  repo: string,
  sha: string,
  diagnostic: Diagnostic,
  directory: string,
  repoRoot: string,
): string {
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const repoPath = repoRelativeDiagnosticPath(directory, diagnostic.file, repoRoot);
  const encoded = repoPath
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16)}`,
      ),
    )
    .join("/");

  return `${server}/${repo}/blob/${sha}/${encoded}${(diagnostic as FixedDiagnostic).baselineLocationUncertain ? "" : `#L${diagnostic.location.line}`}`;
}

async function publishCommitStatus(
  client: GitHubClient,
  sha: string,
  report: ScanReport,
  blocking: BlockingLevel,
): Promise<void> {
  const blocked = shouldBlock(report, blocking);
  const body = {
    state: report.partial ? "error" : blocked ? "failure" : "success",
    context: "React-Luau Doctor",
    description: report.partial
      ? "Analysis incomplete; findings and fixes are unverified"
      : `Score ${report.score}/100 · ${report.counts.error} errors · ${report.counts.warning} warnings`,
    target_url: githubRunUrl() ?? undefined,
  };

  if (client.pullNumber) await client.mutate(`/statuses/${sha}`, "POST", body);
  else await client.request(`/statuses/${sha}`, { method: "POST", body });
}

interface CiRunOptions extends CiSettings {}

function parseCiRunOptions(argv: string[]): CiRunOptions {
  const settings = { ...DEFAULT_SETTINGS };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--directory") {
      const parsed = nextValue(argv, index, arg);
      settings.directory = parsed.value;
      index = parsed.nextIndex;
    } else if (arg === "--project") {
      const parsed = nextValue(argv, index, arg);
      settings.project = parsed.value;
      index = parsed.nextIndex;
    } else if (arg === "--blocking") {
      const parsed = nextValue(argv, index, arg);
      settings.blocking = parseBlocking(parsed.value);
      index = parsed.nextIndex;
    } else if (arg === "--scope") {
      const parsed = nextValue(argv, index, arg);
      settings.scope = parseScope(parsed.value);
      index = parsed.nextIndex;
    } else if (arg === "--comment") settings.comment = true;
    else if (arg === "--no-comment") settings.comment = false;
    else if (arg === "--review-comments") settings.reviewComments = true;
    else if (arg === "--no-review-comments") settings.reviewComments = false;
    else if (arg === "--commit-status") settings.commitStatus = true;
    else if (arg === "--no-commit-status") settings.commitStatus = false;
    else throw new Error(`Unknown ci run option: ${arg}`);
  }

  return settings;
}

async function runCiJob(argv: string[]): Promise<void> {
  const settings = parseCiRunOptions(argv);
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";

  if (eventName === "pull_request_target") {
    throw new Error(
      "ci run does not execute PR analysis under pull_request_target; use pull_request with least-privilege permissions",
    );
  }

  const event = githubEvent();
  const isPullRequest = eventName === "pull_request" && event.pull_request !== undefined;
  const base = isPullRequest ? event.pull_request!.base.sha : undefined;
  const head = isPullRequest ? event.pull_request!.head.sha : (process.env.GITHUB_SHA ?? "HEAD");
  const repo = githubRepo(event);
  const client = repo
    ? new GitHubClient(repo, event.pull_request?.number ?? 0, {
        head,
        base: base ?? "",
        runId: process.env.GITHUB_RUN_ID ?? "",
        attempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
      })
    : undefined;
  let snapshot: ReviewSnapshot | undefined;

  if (client && isPullRequest && settings.reviewComments) {
    try {
      snapshot = await reviewSnapshot(client);
    } catch (error) {
      process.stderr.write(
        `react-luau-doctor: could not update inline review comments: ${errorMessage(error)}\n`,
      );
    }
  }

  const scan = await scanForCi(settings, isPullRequest, base, head, snapshot);
  const { report, fixed, analysis } = scan;
  const baselineCommit = scan.comparison.base ?? base;
  const skipped =
    isPullRequest &&
    report.scannedFiles === 0 &&
    fixed.length === 0 &&
    report.diagnostics.length === 0 &&
    !report.partial;
  const effectiveBlocking = isPullRequest ? settings.blocking : "none";
  process.stdout.write(
    `${renderTextReport(report, true, false, false, process.stdout.columns ?? 120)}\n`,
  );
  const annotations = renderAnnotations(report);

  if (annotations) process.stdout.write(`${annotations}\n`);

  writeOutput("score", report.score);
  writeOutput("total-issues", report.diagnostics.length);
  writeOutput("fixed-issues", fixed.length);
  writeOutput("error-count", report.counts.error);
  writeOutput("warning-count", report.counts.warning);
  writeOutput("suggestion-count", report.counts.suggestion);
  writeOutput("affected-files", affectedFiles(report));
  writeOutput("analysis-complete", report.partial ? "false" : "true");
  const render = (inlineCount: number, limit?: number) =>
    renderSummaryComment(report, {
      baseBranch: event.pull_request?.base.ref ?? "baseline",
      fixed,
      sha: head,
      inlineCount,
      incomplete: report.partial,
      skipped,
      runUrl: githubRunUrl(),
      limit,
      includeDiagnosticDetails: limit === Number.POSITIVE_INFINITY,
      url: (diagnostic, baseline) =>
        githubFileUrl(
          repo ?? "unknown/repository",
          baseline ? (baselineCommit ?? "HEAD") : head,
          diagnostic,
          settings.directory,
          scan.repoRoot,
        ),
    });
  const fullReport = render(0, Number.POSITIVE_INFINITY);

  if (process.env.GITHUB_STEP_SUMMARY) {
    // Keep complete reports available without depending on annotation or comment limits
    if (Buffer.byteLength(fullReport) < 900_000) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, fullReport);
    } else {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `${render(0)}\nThe complete diagnostic report exceeds the workflow summary limit and is available in the report artifact and logs\n`,
      );
    }
  }

  const reportFile = path.join(
    fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "react-luau-doctor-report-")),
    "report.json",
  );
  fs.writeFileSync(
    reportFile,
    JSON.stringify(
      {
        ...report,
        fixedDiagnostics: fixed,
        baseBranch: event.pull_request?.base.ref,
        baseCommit: baselineCommit,
        baseBranchCommit: base,
        headCommit: head,
      },
      null,
      2,
    ) + "\n",
  );
  writeOutput("report-path", reportFile);
  process.stdout.write(
    `Full diagnostic report\n${JSON.stringify({ ...report, fixedDiagnostics: fixed })}\n`,
  );

  if (client && isPullRequest) {
    let inlineCount =
      snapshot?.comments.filter(
        (comment) =>
          comment.user?.type === "Bot" &&
          comment.body?.startsWith("<!-- react-luau-doctor:review -->"),
      ).length ?? 0;
    let stale = false;
    const publishSummary = async () => {
      if (!settings.comment || stale) return;

      try {
        await client.sticky(render(inlineCount), !report.partial);
      } catch (error) {
        stale ||= error instanceof StalePublication;
        process.stderr.write(
          `react-luau-doctor: could not update the sticky PR comment: ${errorMessage(error)}\n`,
        );
      }
    };
    // The summary also acts as the run watermark before reconciling historical reviews
    await publishSummary();

    if (settings.reviewComments && snapshot && base && !stale) {
      try {
        // New inline comments use the latest push, while the summary keeps the PR baseline
        const reviewBase = event.action === "synchronize" ? event.before : base;

        if (
          event.action === "synchronize" &&
          (!reviewBase ||
            !/^[a-f0-9]{40}$/i.test(reviewBase) ||
            gitResult(scan.repoRoot, ["merge-base", "--is-ancestor", reviewBase, head]) === null)
        ) {
          throw new Error(
            "Previous PR head is unavailable or history was rewritten; new inline comments were skipped",
          );
        }

        const lines = createGitScopePlan(path.resolve(settings.directory), {
          scope: "lines",
          base: reviewBase,
        }).changedLines;
        const canInline = (diagnostic: Diagnostic) =>
          (lines.get(diagnostic.file) ?? []).some(
            (range) =>
              diagnostic.location.line >= range.start && diagnostic.location.line <= range.end,
          );
        let introduced = !event.action || event.action === "opened" ? analysis.introduced : [];

        if (
          analysis.complete &&
          event.action === "synchronize" &&
          analysis.introduced.some(({ diagnostic }) => canInline(diagnostic))
        ) {
          const update = await scanForCi({ ...settings, scope: "changed" }, true, reviewBase, head);

          if (!update.analysis.complete) {
            throw new Error(
              "Previous PR head analysis was incomplete; new inline comments were skipped",
            );
          }

          const fresh = new Set(
            update.comparison.diagnostics.map(
              (diagnostic) => diagnostic.file + "\0" + diagnostic.id,
            ),
          );
          introduced = analysis.introduced.filter(({ diagnostic }) =>
            fresh.has(diagnostic.file + "\0" + diagnostic.id),
          );
        }

        const latestSnapshot = await reviewSnapshot(client);
        inlineCount = await reconcileReviews(
          client,
          latestSnapshot,
          {
            ...analysis,
            introduced,
          },
          canInline,
        );
      } catch (error) {
        stale ||= error instanceof StalePublication;
        process.stderr.write(
          `react-luau-doctor: could not update inline review comments: ${errorMessage(error)}\n`,
        );
      }

      await publishSummary();
    }
  }

  if (client && settings.commitStatus) {
    try {
      await publishCommitStatus(client, head, report, effectiveBlocking);
    } catch (error) {
      process.stderr.write(
        `react-luau-doctor: could not publish the commit status: ${errorMessage(error)}\n`,
      );
    }
  }

  if (report.partial || shouldBlock(report, effectiveBlocking)) process.exitCode = 1;
}

export async function runCiCommand(argv: string[]): Promise<void> {
  const action = argv[0];

  if (action === "install" || action === "config" || action === "upgrade") {
    await runCiManage(action, argv.slice(1));

    return;
  }

  if (action === "run") {
    await runCiJob(argv.slice(1));

    return;
  }

  throw new Error("ci requires install, config, or upgrade");
}
