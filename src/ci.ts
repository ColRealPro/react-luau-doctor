import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { isSelectedLuauPath } from "./files";
import { loadConfigWithSource } from "./config";
import { createGitScopePlan, findGitRoot } from "./git";
import type { LineRange } from "./git";
import { renderAnnotations, renderTextReport } from "./reporter";
import { aggregateReports, scanProjectWithScope } from "./scope";
import { scanPath } from "./scanner";
import type { BlockingLevel, Diagnostic, ScanReport, ScanScope } from "./types";
import packageJson from "../package.json";

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
const SUMMARY_MARKER = "<!-- react-luau-doctor:summary -->";
const REVIEW_MARKER = "<!-- react-luau-doctor:review -->";
const MAX_REVIEW_COMMENTS = 20;
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
  issues: write
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
  if (value !== "error" && value !== "warning" && value !== "none") throw new Error("--blocking must be error, warning, or none");
  return value;
}

function parseScope(value: string): ScanScope {
  if (value !== "full" && value !== "files" && value !== "changed" && value !== "lines") {
    throw new Error("--scope must be full, files, changed, or lines");
  }
  return value;
}

function parseProvider(value: string): CiProvider {
  if (value !== "github" && value !== "gitlab") throw new Error("--provider must be github or gitlab");
  return value;
}

function nextValue(argv: string[], index: number, flag: string): { value: string; nextIndex: number } {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return { value, nextIndex: index + 1 };
}

function parseCiManageOptions(argv: string[], action: "install" | "config" | "upgrade"): CiManageOptions {
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
  const match = (name: string): string | undefined => text.match(new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, "m"))?.[1]?.replace(/^['"]|['"]$/g, "");
  const result: Partial<CiSettings> = { provider: filename.endsWith(".gitlab-ci.yml") ? "gitlab" : "github" };
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
  const reviewComments = match("review-comments") ?? flag("--review-comments", "--no-review-comments")?.toString();
  const commitStatus = match("commit-status") ?? flag("--commit-status", "--no-commit-status")?.toString();
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

async function completeSettings(options: CiManageOptions, current: Partial<CiSettings>, action: "install" | "config" | "upgrade"): Promise<CiSettings> {
  const settings: CiSettings = { ...DEFAULT_SETTINGS, ...current, ...options };
  if (options.yes || action === "upgrade") return settings;

  settings.provider = parseProvider(await askChoice("CI provider", ["github", "gitlab"], settings.provider));
  settings.blocking = parseBlocking(await askChoice("Blocking level", ["none", "error", "warning"], settings.blocking));
  settings.scope = parseScope(await askChoice("Pull request scan scope", ["changed", "files", "lines", "full"], settings.scope));
  if (settings.provider === "github") {
    settings.comment = parseBoolean(await askChoice("Sticky PR summary comment", ["true", "false"], String(settings.comment)), "comment");
    settings.reviewComments = parseBoolean(await askChoice("Inline review comments", ["true", "false"], String(settings.reviewComments)), "review-comments");
    settings.commitStatus = parseBoolean(await askChoice("Commit status", ["true", "false"], String(settings.commitStatus)), "commit-status");
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
    throw new Error(".gitlab-ci.yml already exists and is not managed by React-Luau Doctor; add the generated job manually instead of overwriting it");
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
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
  return (result.stdout ?? "").trim();
}

function openPullRequest(cwd: string, files: string[], action: "install" | "upgrade"): void {
  findGitRoot(cwd);
  if (!runCommand(cwd, "gh", ["--version"], true)) throw new Error("--pr requires the GitHub CLI (gh) to be installed and authenticated");
  const branch = action === "install" ? "chore/add-react-luau-doctor-ci" : "chore/upgrade-react-luau-doctor-ci";
  const title = action === "install" ? "Add React-Luau Doctor CI" : "Upgrade React-Luau Doctor CI";
  runCommand(cwd, "git", ["switch", "-c", branch]);
  runCommand(cwd, "git", ["add", "--", ...files.map((file) => path.relative(cwd, file))]);
  runCommand(cwd, "git", ["commit", "-m", title]);
  runCommand(cwd, "git", ["push", "-u", "origin", branch]);
  const url = runCommand(cwd, "gh", ["pr", "create", "--title", title, "--body", "Adds React-Luau Doctor pull request analysis."]);
  process.stdout.write(`${url}\n`);
}

async function runCiManage(action: "install" | "config" | "upgrade", argv: string[]): Promise<void> {
  const options = parseCiManageOptions(argv, action);
  const provider = options.provider ?? existingProvider(options.cwd) ?? DEFAULT_SETTINGS.provider;
  const workflowPath = path.join(options.cwd, provider === "github" ? GITHUB_WORKFLOW : GITLAB_WORKFLOW);
  const current = parseManagedWorkflowSettings(workflowPath);
  const settings = await completeSettings({ ...options, provider }, current, action);

  if (action === "install" && fs.existsSync(workflowPath) && !options.yes) {
    const overwrite = await askChoice(`${path.relative(options.cwd, workflowPath)} already exists. Replace it`, ["true", "false"], "false");
    if (overwrite !== "true") return;
  }

  const files = writeManagedCi(options.cwd, settings);
  for (const filename of files) process.stdout.write(`${action === "install" ? "Installed" : action === "config" ? "Updated" : "Upgraded"} ${path.relative(options.cwd, filename)}\n`);
  if (options.pr) openPullRequest(options.cwd, files, action === "install" ? "install" : "upgrade");
}

function diagnosticFingerprint(diagnostic: Diagnostic): string {
  return `${diagnostic.file}\0${diagnostic.rule}\0${diagnostic.severity}\0${diagnostic.message}`;
}

function countDifference(left: Diagnostic[], right: Diagnostic[]): number {
  const counts = new Map<string, number>();
  for (const diagnostic of right) {
    const key = diagnosticFingerprint(diagnostic);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let difference = 0;
  for (const diagnostic of left) {
    const key = diagnosticFingerprint(diagnostic);
    const remaining = counts.get(key) ?? 0;
    if (remaining > 0) counts.set(key, remaining - 1);
    else difference += 1;
  }
  return difference;
}

async function fixedIssueCount(directory: string, base: string): Promise<number> {
  const plan = createGitScopePlan(directory, { scope: "changed", base });
  if (plan.currentFiles.length === 0 && plan.baselineFiles.length === 0) return 0;
  const config = loadConfigWithSource(directory).config;
  const selected = (file: { relativePath?: string }) => isSelectedLuauPath(file.relativePath ?? "", config);
  const current = await scanPath(directory, { files: plan.currentFiles.filter(selected), config, categories: config.categories });
  const baseline = await scanPath(directory, { files: plan.baselineFiles.filter(selected), config, categories: config.categories });
  return countDifference(baseline.diagnostics, current.diagnostics);
}

function resolveCiProjectRoots(directory: string, project: string): string[] {
  if (!project || project === "*") return [directory];
  return project.split(",").map((entry) => {
    const resolved = path.resolve(directory, entry.trim());
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`Could not find project: ${entry}`);
    return resolved;
  });
}

async function scanForCi(settings: CiSettings, eventName: string, base?: string): Promise<ScanReport> {
  const directory = path.resolve(process.cwd(), settings.directory);
  const isPullRequest = eventName === "pull_request";
  const scope: ScanScope = isPullRequest ? settings.scope : "full";
  const roots = resolveCiProjectRoots(directory, settings.project);
  const reports: Array<{ projectRoot: string; report: ScanReport }> = [];
  for (const projectRoot of roots) {
    const config = loadConfigWithSource(projectRoot).config;
    const report = await scanProjectWithScope(projectRoot, {
      scope,
      base,
      minSeverity: "suggestion",
      categories: config.categories,
      respectInlineDisables: config.respectInlineDisables ?? true,
    });
    reports.push({ projectRoot, report });
  }
  return roots.length === 1 && roots[0] === directory ? reports[0].report : aggregateReports(directory, reports);
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

async function githubApi<T>(repo: string, endpoint: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is unavailable");
  const apiBase = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const response = await fetch(`${apiBase}/repos/${repo}${endpoint}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "react-luau-doctor",
      "Content-Type": "application/json",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

function repoRelativeDiagnosticPath(directory: string, diagnosticFile: string): string {
  const absoluteDirectory = path.resolve(directory);
  const repoRoot = findGitRoot(absoluteDirectory);
  const prefix = path.relative(repoRoot, absoluteDirectory).split(path.sep).join("/");
  return prefix && prefix !== "." ? path.posix.join(prefix, diagnosticFile) : diagnosticFile;
}

function githubFileUrl(repo: string, sha: string, diagnostic: Diagnostic, directory: string): string {
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const repoPath = repoRelativeDiagnosticPath(directory, diagnostic.file);
  const encoded = repoPath.split("/").map(encodeURIComponent).join("/");
  return `${server}/${repo}/blob/${sha}/${encoded}#L${diagnostic.location.line}`;
}

function renderSummaryComment(report: ScanReport, repo: string, sha: string, fixed: number, skipped: boolean, directory: string): string {
  if (skipped) {
    return `${SUMMARY_MARKER}\n## React-Luau Doctor\n\nNo eligible React-Luau files changed in this pull request, so the scan was skipped.\n`;
  }

  const lines = [
    SUMMARY_MARKER,
    "## React-Luau Doctor",
    "",
    `**${report.counts.error} errors · ${report.counts.warning} warnings · ${report.counts.suggestion} suggestions · Score ${report.score}/100**`,
    "",
    `${report.diagnostics.length} ${report.scope === "changed" ? "introduced finding" : "reported finding"}${report.diagnostics.length === 1 ? "" : "s"} · ${fixed} fixed`,
  ];

  const errors = report.diagnostics.filter((diagnostic) => diagnostic.severity === "error").slice(0, 20);
  if (errors.length > 0) {
    lines.push("", "### Errors");
    for (const diagnostic of errors) {
      lines.push(`- [\`${diagnostic.file}:${diagnostic.location.line}\`](${githubFileUrl(repo, sha, diagnostic, directory)}) **${diagnostic.rule}**: ${diagnostic.message}`);
    }
  }

  const warningsByFile = new Map<string, Diagnostic[]>();
  for (const diagnostic of report.diagnostics.filter((entry) => entry.severity === "warning").slice(0, 50)) {
    const entries = warningsByFile.get(diagnostic.file) ?? [];
    entries.push(diagnostic);
    warningsByFile.set(diagnostic.file, entries);
  }
  if (warningsByFile.size > 0) {
    lines.push("", "### Warnings");
    for (const [file, diagnostics] of warningsByFile) {
      lines.push(`- **${file}**`);
      for (const diagnostic of diagnostics) lines.push(`  - [line ${diagnostic.location.line}](${githubFileUrl(repo, sha, diagnostic, directory)}): ${diagnostic.message}`);
    }
  }

  if (report.diagnostics.length > errors.length + [...warningsByFile.values()].reduce((sum, entries) => sum + entries.length, 0)) {
    lines.push("", "Additional findings are available in the workflow logs.");
  }
  const runUrl = githubRunUrl();
  if (runUrl) lines.push("", `[View full workflow run](${runUrl})`);
  lines.push("", `<sub>Reviewed commit \`${sha.slice(0, 7)}\`</sub>`);
  return `${lines.join("\n")}\n`;
}

interface GitHubComment { id: number; body?: string; user?: { type?: string; login?: string } }

async function listComments(repo: string, endpoint: string): Promise<GitHubComment[]> {
  const comments: GitHubComment[] = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubApi<GitHubComment[]>(repo, `${endpoint}?per_page=100&page=${page}`);
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
}

function isDoctorComment(comment: GitHubComment, marker: string): boolean {
  return comment.user?.type === "Bot" && comment.body?.startsWith(marker) === true;
}

async function updateStickyComment(repo: string, pullNumber: number, body: string, createIfMissing = true): Promise<void> {
  const comments = await listComments(repo, `/issues/${pullNumber}/comments`);
  const previous = comments.find((comment) => isDoctorComment(comment, SUMMARY_MARKER));
  if (previous) await githubApi(repo, `/issues/comments/${previous.id}`, { method: "PATCH", body: { body } });
  else if (createIfMissing) await githubApi(repo, `/issues/${pullNumber}/comments`, { method: "POST", body: { body } });
}

function changedLineMap(directory: string, base: string): Map<string, LineRange[]> {
  return createGitScopePlan(directory, { scope: "lines", base }).changedLines;
}

function touchesChangedLine(diagnostic: Diagnostic, ranges: LineRange[]): boolean {
  return ranges.some((range) => diagnostic.location.line >= range.start && diagnostic.location.line <= range.end);
}

async function replaceReviewComments(repo: string, pullNumber: number, report: ScanReport, directory: string, base: string): Promise<void> {
  const lineMap = changedLineMap(directory, base);
  const comments = report.diagnostics
    .filter((diagnostic) => touchesChangedLine(diagnostic, lineMap.get(diagnostic.file) ?? []))
    .slice(0, MAX_REVIEW_COMMENTS)
    .map((diagnostic) => ({
      path: repoRelativeDiagnosticPath(directory, diagnostic.file),
      line: diagnostic.location.line,
      side: "RIGHT",
      body: `${REVIEW_MARKER}\n**React-Luau Doctor** · \`${diagnostic.rule}\` (${diagnostic.severity})\n\n${diagnostic.message}${diagnostic.help ? `\n\n${diagnostic.help}` : ""}`,
    }));

  const previous = await listComments(repo, `/pulls/${pullNumber}/comments`);
  if (comments.length > 0) {
    await githubApi(repo, `/pulls/${pullNumber}/reviews`, {
      method: "POST",
      body: { event: "COMMENT", body: "React-Luau Doctor review", comments },
    });
  }
  for (const comment of previous.filter((entry) => isDoctorComment(entry, REVIEW_MARKER))) {
    try {
      await githubApi(repo, `/pulls/comments/${comment.id}`, { method: "DELETE" });
    } catch (error) {
      process.stderr.write(`react-luau-doctor: could not remove an earlier review comment: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

async function publishCommitStatus(repo: string, sha: string, report: ScanReport, blocking: BlockingLevel): Promise<void> {
  const blocked = shouldBlock(report, blocking);
  await githubApi(repo, `/statuses/${sha}`, {
    method: "POST",
    body: {
      state: blocked ? "failure" : "success",
      context: "React-Luau Doctor",
      description: `Score ${report.score}/100 · ${report.counts.error} errors · ${report.counts.warning} warnings`,
      target_url: githubRunUrl() ?? undefined,
    },
  });
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
  const event = githubEvent();
  const isPullRequest = eventName === "pull_request" && event.pull_request !== undefined;
  const base = isPullRequest ? event.pull_request!.base.sha : undefined;
  const head = isPullRequest ? event.pull_request!.head.sha : process.env.GITHUB_SHA ?? "HEAD";
  const report = await scanForCi(settings, eventName, base);
  const fixed = isPullRequest && base
    ? (await Promise.all(resolveCiProjectRoots(path.resolve(settings.directory), settings.project).map(root => fixedIssueCount(root, base)))).reduce((sum, count) => sum + count, 0)
    : 0;
  const skipped = isPullRequest && report.scannedFiles === 0 && fixed === 0;
  const effectiveBlocking = isPullRequest ? settings.blocking : "none";

  process.stdout.write(`${renderTextReport(report, true, false, false, process.stdout.columns ?? 120)}\n`);
  const annotations = renderAnnotations(report);
  if (annotations) process.stdout.write(`${annotations}\n`);

  writeOutput("score", report.score);
  writeOutput("total-issues", report.diagnostics.length);
  writeOutput("fixed-issues", fixed);
  writeOutput("error-count", report.counts.error);
  writeOutput("warning-count", report.counts.warning);
  writeOutput("affected-files", affectedFiles(report));

  const repo = githubRepo(event);
  if (repo && isPullRequest) {
    const pullNumber = event.pull_request!.number;
    if (settings.comment) {
      try {
        await updateStickyComment(repo, pullNumber, renderSummaryComment(report, repo, head, fixed, skipped, settings.directory), !skipped);
      } catch (error) {
        process.stderr.write(`react-luau-doctor: could not update the sticky PR comment: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    if (settings.reviewComments && base) {
      try {
        await replaceReviewComments(repo, pullNumber, report, path.resolve(settings.directory), base);
      } catch (error) {
        process.stderr.write(`react-luau-doctor: could not update inline review comments: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }

  if (repo && settings.commitStatus) {
    try {
      await publishCommitStatus(repo, head, report, effectiveBlocking);
    } catch (error) {
      process.stderr.write(`react-luau-doctor: could not publish the commit status: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  if (shouldBlock(report, effectiveBlocking)) process.exitCode = 1;
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
