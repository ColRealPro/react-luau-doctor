import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  convertWorkflowTemplate,
  NoOperationTraceWriter,
  parseWorkflow,
} from "@actions/workflow-parser";
import { renderGitHubWorkflow } from "../src/ci";
import { gitExecutable } from "../src/git";
import packageJson from "../package.json";
import { renderSummaryComment } from "../src/ci/report";
import {
  GitHubClient,
  publishCheckRun,
  reconcileReviews,
  type Review,
  type ReviewAnalysis,
  type ReviewComment,
  type ReviewFinding,
} from "../src/ci/github";
import type { Diagnostic, ScanReport } from "../src/types";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

// Local mock servers do not need GitHub's spacing between mutative requests
process.env.DOCTOR_GITHUB_MUTATION_INTERVAL_MS = "0";

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd = process.cwd(), env: NodeJS.ProcessEnv = {}): Result {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(gitExecutable, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "React Luau Doctor Tests",
      GIT_AUTHOR_EMAIL: "doctor@example.invalid",
      GIT_COMMITTER_NAME: "React Luau Doctor Tests",
      GIT_COMMITTER_EMAIL: "doctor@example.invalid",
    },
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }

  return (result.stdout ?? "").trim();
}

function createRepo(source: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-ci-"));
  git(root, "init", "-b", "main");
  fs.writeFileSync(path.join(root, "Component.luau"), source);
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");

  return root;
}

const VALID_COMPONENT = `local React = require(script.Parent.React)\nlocal function Component(props)\n\treturn React.createElement("TextLabel", { Text = props.text })\nend\nreturn Component\n`;
const INVALID_COMPONENT = `local React = require(script.Parent.React)\nlocal function Component(props)\n\tprops.text = "bad"\n\treturn React.createElement("TextLabel", { Text = props.text })\nend\nreturn Component\n`;

function diagnostic(
  file = "Component.luau",
  line = 3,
  severity: Diagnostic["severity"] = "error",
  message = "Diagnostic message",
): Diagnostic {
  return {
    id: `${file}:${line}`,
    file,
    rule: "example-rule",
    category: "Correctness",
    severity,
    message,
    help: "Diagnostic help",
    location: { line, column: 1, endLine: line, endColumn: 2 },
  };
}

function report(diagnostics: Diagnostic[]): ScanReport {
  const counts = { error: 0, warning: 0, suggestion: 0 };

  for (const entry of diagnostics) {
    counts[entry.severity]++;
  }

  return {
    schemaVersion: 1,
    root: ".",
    scannedFiles: 2,
    score: 71,
    durationMs: 1,
    scope: "changed",
    counts,
    diagnostics,
  };
}

test("sticky truncation preserves totals, closes sections, and links to full findings", () => {
  const diagnostics = [
    diagnostic("a.luau", 1),
    diagnostic("a.luau", 2),
    diagnostic("b.luau", 3, "warning"),
    diagnostic("c.luau", 4, "suggestion"),
  ];
  const options = {
    baseBranch: "main",
    sha: "abcdef0",
    fixed: [],
    inlineCount: 20,
    url: () => "https://github.com/test/project",
    runUrl: "https://github.com/test/project/actions/runs/1",
  };
  const truncated = renderSummaryComment(report(diagnostics), { ...options, limit: 900 });
  assert.ok(truncated.length <= 900);
  assert.match(truncated, /4 new issues/);
  assert.ok(truncated.includes(options.runUrl));
  assert.equal(
    (truncated.match(/<details>/g) ?? []).length,
    (truncated.match(/<\/details>/g) ?? []).length,
  );
  assert.doesNotMatch(truncated, /<summary>[^\n]*<\/summary>\s*<\/details>/);
  const clean = renderSummaryComment(
    { ...report([]), score: 100 },
    { ...options, fixed: [diagnostic()] },
  );
  assert.match(clean, /found no new issues/);
  assert.doesNotMatch(clean, /0 errors|score 100\/100|\\color|\\textsf/);
  assert.match(clean, /1 fixed vs/);
  assert.ok(clean.includes(options.runUrl));
  assert.ok(!renderSummaryComment(report([]), options).includes(options.runUrl));
  assert.ok(
    renderSummaryComment(report([]), { ...options, incomplete: true }).includes(options.runUrl),
  );
});

interface MockGitHub {
  client: GitHubClient;
  reviews: Review[];
  comments: ReviewComment[];
  resolved: Set<number>;
}

function mockGitHub(t: { after: (fn: () => void) => void }): MockGitHub {
  const saved = { token: process.env.GITHUB_TOKEN, api: process.env.GITHUB_API_URL };
  const mock: MockGitHub = { client: null!, reviews: [], comments: [], resolved: new Set() };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const endpoint = url.pathname.replace("/repos/test/project", "");
      const body: any =
        request.method === "GET" || request.method === "DELETE" ? null : await request.json();

      if (endpoint === "/graphql") {
        const nodes = mock.comments
          .filter((comment) => !comment.in_reply_to_id)
          .map((comment) => ({
            isResolved: mock.resolved.has(comment.id),
            comments: { nodes: [{ databaseId: comment.id }] },
          }));

        return Response.json({
          data: {
            repository: {
              pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage: false } } },
            },
          },
        });
      }

      if (request.method === "GET") {
        if (endpoint === "/pulls/7") {
          return Response.json({ head: { sha: "head" }, base: { sha: "base" }, state: "open" });
        }

        if (endpoint === "/issues/7/comments") return Response.json([]);

        if (endpoint === "/pulls/7/comments") return Response.json(mock.comments);

        if (endpoint === "/pulls/7/reviews") return Response.json(mock.reviews);
      }

      if (request.method === "POST" && endpoint === "/pulls/7/reviews") {
        const id = mock.reviews.length + 1;
        mock.reviews.push({
          id,
          body: body.body,
          user: { type: "Bot" },
          commit_id: body.commit_id,
        });

        for (const comment of body.comments) {
          mock.comments.push({
            id: mock.comments.length + 100,
            pull_request_review_id: id,
            path: comment.path,
            line: comment.line,
            original_line: comment.line,
            commit_id: body.commit_id,
            body: comment.body,
            user: { type: "Bot" },
          });
        }

        return Response.json({ id });
      }

      if (request.method === "PUT" && endpoint.startsWith("/pulls/7/reviews/")) {
        mock.reviews.find((review) => review.id === Number(endpoint.split("/").at(-1)))!.body =
          body.body;

        return Response.json({ id: 1 });
      }

      if (request.method === "DELETE" && endpoint.startsWith("/pulls/comments/")) {
        mock.comments = mock.comments.filter(
          (comment) => comment.id !== Number(endpoint.split("/").at(-1)),
        );

        return new Response(null, { status: 204 });
      }

      return Response.json({ message: `Unhandled ${request.method} ${endpoint}` }, { status: 404 });
    },
  });
  process.env.GITHUB_TOKEN = "local-test-token";
  process.env.GITHUB_API_URL = server.url.toString();
  mock.client = new GitHubClient("test/project", 7, {
    head: "head",
    base: "base",
    runId: "10",
    attempt: "1",
  });
  t.after(() => {
    server.stop(true);

    if (saved.token === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved.token;

    if (saved.api === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved.api;
  });

  return mock;
}

function finding(entry: Diagnostic, anchor = String(entry.location.line)): ReviewFinding {
  return {
    file: entry.file,
    rule: entry.rule,
    severity: entry.severity,
    message: entry.message,
    line: entry.location.line,
    column: entry.location.column,
    diagnosticId: entry.id,
    anchor,
    status: "active",
  };
}

function analysis(diagnostics: Diagnostic[], verified = ["Component.luau"]): ReviewAnalysis {
  return {
    signature: "config",
    complete: true,
    current: diagnostics.map((entry) => finding(entry)),
    introduced: diagnostics.map((entry) => ({ finding: finding(entry), diagnostic: entry })),
    verifiedFiles: new Set(verified),
    eligible: () => true,
    canonicalFile: (file) => file,
  };
}

async function reconcile(
  mock: MockGitHub,
  current: ReviewAnalysis,
  canInline = (_entry: Diagnostic) => true,
  limit = 20,
): Promise<number> {
  return reconcileReviews(
    mock.client,
    { reviews: structuredClone(mock.reviews), comments: structuredClone(mock.comments) },
    current,
    canInline,
    limit,
  );
}

test("inline reviews retain original membership across reruns, shifted lines, partial and full fixes", async (t) => {
  const mock = mockGitHub(t);
  const first = diagnostic("Component.luau", 3, "error", "First message");
  const second = diagnostic("Component.luau", 6, "warning", "Second message");
  assert.equal(await reconcile(mock, analysis([first, second])), 2);
  const originalIds = mock.comments.map((comment) => comment.id);
  await reconcile(mock, analysis([first, second]));
  assert.deepEqual(
    mock.comments.map((comment) => comment.id),
    originalIds,
  );
  const shifted = { ...second, location: { ...second.location, line: 20, endLine: 20 } };
  await reconcile(mock, analysis([shifted]));
  assert.equal(mock.comments.length, 1);
  assert.equal(mock.comments[0].id, originalIds[1]);
  assert.match(
    mock.reviews[0].body!,
    /\*\*1 of these 2 issues fixed\*\* · 1 still remains in the PR/,
  );
  await reconcile(mock, analysis([]));
  assert.equal(mock.comments.length, 0);
  assert.match(mock.reviews[0].body!, /\*\*Both issues fixed in later commits\*\*/);
  assert.equal(mock.reviews.length, 1);
});

test("fixed human discussions stay intact and use actual thread resolution state", async (t) => {
  const mock = mockGitHub(t);
  await reconcile(mock, analysis([diagnostic()]));
  mock.comments.push({
    id: 200,
    pull_request_review_id: 2,
    path: "Component.luau",
    body: "Please explain",
    user: { type: "User" },
    in_reply_to_id: 100,
  });
  await reconcile(mock, analysis([]));
  assert.equal(mock.comments.length, 2);
  assert.match(
    mock.reviews[0].body!,
    /\*\*This issue fixed in later commits\*\* · 1 discussion awaiting resolution/,
  );
  assert.doesNotMatch(mock.reviews[0].body!, /\\color|\\textsf/);
  mock.resolved.add(100);
  await reconcile(mock, analysis([]));
  assert.equal(mock.comments.length, 2);
  assert.doesNotMatch(mock.reviews[0].body!, /awaiting resolution/);
});

test("inline selection prioritizes severity and alternates files", async (t) => {
  const mock = mockGitHub(t);
  const diagnostics = [
    diagnostic("a.luau", 5, "suggestion"),
    diagnostic("b.luau", 4, "warning"),
    diagnostic("a.luau", 1),
    diagnostic("a.luau", 3),
    diagnostic("b.luau", 2),
  ];
  await reconcile(mock, analysis(diagnostics, ["a.luau", "b.luau"]));
  assert.deepEqual(
    mock.comments.map((comment) => comment.line),
    [1, 2, 3, 4, 5],
  );
});

test("inline reviews respect the configured limit and track reviews above the old cap", async (t) => {
  const mock = mockGitHub(t);
  const diagnostics = Array.from({ length: 60 }, (_, index) =>
    diagnostic("Component.luau", index + 1, "warning"),
  );
  const inline = () => true;
  assert.equal(await reconcile(mock, analysis(diagnostics), inline, 50), 50);
  await reconcile(mock, analysis(diagnostics), inline, 50);
  assert.equal(mock.reviews.length, 1);
  assert.equal(mock.comments.length, 50);
});

test("check runs append annotations in batches before completing", async (t) => {
  const requests: Array<{ method: string; path: string; body: any }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: await request.json(),
      });

      return Response.json({ id: 5 });
    },
  });
  const saved = { token: process.env.GITHUB_TOKEN, api: process.env.GITHUB_API_URL };
  process.env.GITHUB_TOKEN = "local-test-token";
  process.env.GITHUB_API_URL = server.url.toString();
  t.after(() => {
    server.stop(true);

    if (saved.token === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved.token;

    if (saved.api === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved.api;
  });
  const annotations = Array.from({ length: 120 }, (_, index) => ({
    path: "Component.luau",
    start_line: index + 1,
    end_line: index + 1,
    annotation_level: "warning" as const,
    title: "example-rule",
    message: "Diagnostic message",
  }));
  await publishCheckRun(
    new GitHubClient("test/project", 0, { head: "head", base: "", runId: "", attempt: "1" }),
    "head",
    { conclusion: "neutral", title: "Findings", summary: "Summary", annotations },
  );
  assert.deepEqual(
    requests.map((request) => [
      request.method,
      request.path,
      request.body.output.annotations.length,
    ]),
    [
      ["POST", "/repos/test/project/check-runs", 50],
      ["PATCH", "/repos/test/project/check-runs/5", 50],
      ["PATCH", "/repos/test/project/check-runs/5", 20],
    ],
  );
  assert.equal(requests[0].body.status, "in_progress");
  assert.equal(requests[2].body.status, "completed");
  assert.equal(requests[2].body.conclusion, "neutral");
});

test("ci install writes a version-pinned GitHub workflow", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-ci-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = run(["ci", "install", "--yes", "--cwd", root]);
  assert.equal(result.status, 0, result.stderr);
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/react-luau-doctor.yml"),
    "utf8",
  );
  assert.match(workflow, /DOCTOR_BLOCKING: none/);
  assert.match(workflow, /DOCTOR_SCOPE: changed/);
  assert.match(workflow, /--comment/);
  assert.match(workflow, /--review-comments/);
  assert.match(workflow, /--commit-status/);
  assert.match(workflow, /checks: write/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /contents: write|pull_request_target/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.ok(workflow.includes(`${packageJson.name}@${packageJson.version}`));
});

test("ci config rewrites gate, scope, and reporting settings", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-ci-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(run(["ci", "install", "--yes", "--cwd", root]).status, 0);
  const configured = run([
    "ci",
    "config",
    "--yes",
    "--cwd",
    root,
    "--blocking",
    "warning",
    "--scope",
    "lines",
    "--no-comment",
    "--no-review-comments",
    "--no-commit-status",
    "--max-annotations",
    "100",
    "--max-review-comments",
    "30",
  ]);
  assert.equal(configured.status, 0, configured.stderr);
  const reconfigured = run(["ci", "config", "--yes", "--cwd", root, "--max-annotations", "0"]);
  assert.equal(reconfigured.status, 0, reconfigured.stderr);
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/react-luau-doctor.yml"),
    "utf8",
  );
  assert.match(workflow, /DOCTOR_BLOCKING: warning/);
  assert.match(workflow, /DOCTOR_SCOPE: lines/);
  assert.match(workflow, /--no-comment/);
  assert.match(workflow, /--no-review-comments/);
  assert.match(workflow, /--no-commit-status/);
  assert.match(workflow, /--max-annotations 0/);
  assert.match(workflow, /--max-review-comments 30/);
  const capped = run(["ci", "config", "--yes", "--cwd", root, "--max-review-comments", "51"]);
  assert.notEqual(capped.status, 0);
  assert.match(capped.stderr, /--max-review-comments must be an integer from 0 to 50/);
});

test("ci upgrade refreshes the npm pin while preserving workflow configuration", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-ci-upgrade-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(
    run(["ci", "install", "--yes", "--cwd", root, "--blocking", "error", "--scope", "files"])
      .status,
    0,
  );
  const workflowPath = path.join(root, ".github/workflows/react-luau-doctor.yml");
  const installed = fs.readFileSync(workflowPath, "utf8");
  fs.writeFileSync(
    workflowPath,
    installed.replace(`${packageJson.name}@${packageJson.version}`, `${packageJson.name}@0.0.0`),
  );

  const result = run(["ci", "upgrade", "--yes", "--cwd", root]);
  assert.equal(result.status, 0, result.stderr);
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assert.ok(workflow.includes(`${packageJson.name}@${packageJson.version}`));
  assert.match(workflow, /DOCTOR_BLOCKING: error/);
  assert.match(workflow, /DOCTOR_SCOPE: files/);
});

test("GitLab scaffold supports detached merge-request scans and blocking", (t) => {
  const root = createRepo(VALID_COMPONENT);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = run([
    "ci",
    "install",
    "--yes",
    "--provider",
    "gitlab",
    "--cwd",
    root,
    "--blocking",
    "warning",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const workflow = fs.readFileSync(path.join(root, ".gitlab-ci.yml"), "utf8");
  assert.match(workflow, /oven\/bun:1\.4\.0/);
  assert.match(workflow, /DOCTOR_BLOCKING: "warning"/);
  assert.ok(workflow.includes(`${packageJson.name}@${packageJson.version}`));

  const parsed = Bun.YAML.parse(workflow) as {
    "react-luau-doctor": {
      variables: Record<string, string>;
      before_script: string[];
      script: string[];
    };
  };
  const job = parsed["react-luau-doctor"];
  assert.match(job.before_script[0]!, /apt-get install .* git$/);
  assert.equal(
    job.script[0],
    `bunx --bun ${packageJson.name}@${packageJson.version} "$DOCTOR_DIRECTORY" --scope "$DOCTOR_SCOPE" --blocking "$DOCTOR_BLOCKING" --no-color`,
  );

  const args = [
    job.variables.DOCTOR_DIRECTORY!,
    "--scope",
    job.variables.DOCTOR_SCOPE!,
    "--blocking",
    job.variables.DOCTOR_BLOCKING!,
    "--no-color",
  ];
  const env = {
    GITLAB_CI: "true",
    CI_DEFAULT_BRANCH: "main",
    CI_MERGE_REQUEST_DIFF_BASE_SHA: git(root, "rev-parse", "HEAD"),
    GITHUB_BASE_REF: "",
  };
  git(root, "checkout", "--detach");
  git(root, "branch", "-D", "main");
  const clean = run(args, root, env);
  assert.equal(clean.status, 0, clean.stderr);

  fs.writeFileSync(path.join(root, "Component.luau"), INVALID_COMPONENT);
  git(root, "add", "Component.luau");
  git(root, "commit", "-m", "introduce finding");
  const blocking = run(args, root, env);
  assert.equal(blocking.status, 1, blocking.stderr);
  assert.match(blocking.stdout, /no-prop-mutation/);

  const nonblocking = run([...args, "--blocking", "none"], root, env);
  assert.equal(nonblocking.status, 0, nonblocking.stderr);
  assert.match(nonblocking.stdout, /no-prop-mutation/);

  const missingBase = run(args, root, { ...env, CI_MERGE_REQUEST_DIFF_BASE_SHA: "0".repeat(40) });
  assert.notEqual(missingBase.status, 0);
  assert.match(missingBase.stderr, /Could not resolve git base ref/);
});

test("ci run reports introduced findings and writes GitHub step outputs without network surfaces", (t) => {
  const root = createRepo(VALID_COMPONENT);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "Component.luau"), INVALID_COMPONENT);
  const eventPath = path.join(root, "event.json");
  const outputPath = path.join(root, "outputs.txt");
  fs.writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: {
        number: 1,
        base: { sha: base, ref: "main" },
        head: { sha: base, ref: "feature" },
      },
    }),
  );

  const result = run(
    [
      "ci",
      "run",
      "--directory",
      ".",
      "--scope",
      "changed",
      "--blocking",
      "none",
      "--no-comment",
      "--no-review-comments",
      "--no-commit-status",
    ],
    root,
    {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputPath,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no-prop-mutation/);
  const outputs = fs.readFileSync(outputPath, "utf8");
  assert.match(outputs, /total-issues=1/);
  assert.match(outputs, /error-count=1/);
  assert.match(outputs, /fixed-issues=0/);
  assert.match(outputs, /affected-files=1/);
});

test("ci run reports fixed issues for pull requests", (t) => {
  const root = createRepo(INVALID_COMPONENT);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "Component.luau"), VALID_COMPONENT);
  const eventPath = path.join(root, "event.json");
  const outputPath = path.join(root, "outputs.txt");
  fs.writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: {
        number: 1,
        base: { sha: base, ref: "main" },
        head: { sha: base, ref: "feature" },
      },
    }),
  );

  const result = run(
    [
      "ci",
      "run",
      "--directory",
      ".",
      "--scope",
      "changed",
      "--blocking",
      "none",
      "--no-comment",
      "--no-review-comments",
      "--no-commit-status",
    ],
    root,
    {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputPath,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const outputs = fs.readFileSync(outputPath, "utf8");
  assert.match(outputs, /total-issues=0/);
  assert.match(outputs, /fixed-issues=1/);
});

async function runWithApi(
  root: string,
  base: string,
  api: string,
  options: {
    args?: string[];
    env?: NodeJS.ProcessEnv;
    event?: { action: string; before?: string };
  } = {},
): Promise<Result> {
  const eventPath = path.join(root, "event.json");
  fs.writeFileSync(
    eventPath,
    JSON.stringify({
      ...options.event,
      pull_request: {
        number: 7,
        base: { sha: base, ref: "main" },
        head: { sha: git(root, "rev-parse", "HEAD"), ref: "feature" },
      },
    }),
  );
  const child = Bun.spawn(
    [process.execPath, cli, "ci", "run", "--blocking", "error", ...(options.args ?? [])],
    {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_TOKEN: "local-test-token",
        GITHUB_API_URL: api,
        GITHUB_REPOSITORY: "test/project",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: path.join(root, "outputs.txt"),
        ...options.env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { stdout, stderr, status };
}

test("PR reporting keeps summaries PR-wide and new inline reviews scoped to the latest push", async (t) => {
  const root = createRepo(VALID_COMPONENT);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "Component.luau"), INVALID_COMPONENT);
  git(root, "add", "Component.luau");
  git(root, "commit", "-m", "introduce finding");

  const requests: Array<{ method: string; path: string; body: any }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const body: any = request.method === "GET" ? null : await request.json().catch(() => null);
      requests.push({ method: request.method, path: url.pathname, body });

      if (request.method === "GET" && url.pathname.endsWith("/pulls/7")) {
        return Response.json({
          head: { sha: git(root, "rev-parse", "HEAD") },
          base: { sha: base },
          state: "open",
        });
      }

      if (request.method === "GET") return Response.json([]);

      if (url.pathname === "/graphql") {
        return Response.json({
          data: {
            repository: {
              pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } },
            },
          },
        });
      }

      return Response.json({ id: 1 });
    },
  });
  t.after(() => server.stop(true));

  const result = await runWithApi(root, base, server.url.toString(), { event: { action: "opened" } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /no-prop-mutation/);
  assert.ok(
    requests.some(
      (request) => request.method === "POST" && request.path.endsWith("/issues/7/comments"),
    ),
  );
  const review = requests.find(
    (request) => request.method === "POST" && request.path.endsWith("/pulls/7/reviews"),
  );
  assert.equal(review?.body?.comments?.[0]?.line, 3);
  assert.ok(
    requests.some(
      (request) => request.path.includes("/statuses/") && request.body?.state === "failure",
    ),
  );

  const synchronize = async (before: string): Promise<Result> => {
    requests.length = 0;
    return runWithApi(root, base, server.url.toString(), {
      event: { action: "synchronize", before },
    });
  };
  const reviewRequests = () =>
    requests.filter(
      (request) => request.method === "POST" && request.path.endsWith("/pulls/7/reviews"),
    );

  let before = git(root, "rev-parse", "HEAD");
  git(root, "commit", "--allow-empty", "-m", "update CI");
  assert.equal((await synchronize(before)).status, 1);
  assert.equal(reviewRequests().length, 0);

  before = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "Component.luau"), `\n${INVALID_COMPONENT}`);
  git(root, "add", "Component.luau");
  git(root, "commit", "-m", "edit without new findings");
  assert.equal((await synchronize(before)).status, 1);
  assert.equal(reviewRequests().length, 0);

  before = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "NewComponent.luau"), INVALID_COMPONENT);
  git(root, "add", "NewComponent.luau");
  git(root, "commit", "-m", "introduce another finding");
  assert.equal((await synchronize(before)).status, 1);
  assert.equal(reviewRequests().length, 1);
  assert.deepEqual(
    reviewRequests()[0]?.body.comments.map((comment: any) => comment.path),
    ["NewComponent.luau"],
  );
  assert.match(fs.readFileSync(path.join(root, "outputs.txt"), "utf8"), /total-issues=2/);

  const unavailable = await synchronize("0".repeat(40));
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.stderr, /new inline comments were skipped/);
  assert.equal(reviewRequests().length, 0);
});

test("suppressed syntax failures cannot produce clean CI results, success statuses, or review cleanup", async (t) => {
  const root = createRepo(VALID_COMPONENT);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(
    path.join(root, "Component.luau"),
    'local React = require(script.Parent.React)\nreturn React.createElement("Frame", {',
  );
  fs.writeFileSync(
    path.join(root, "react-luau-doctor.config.json"),
    JSON.stringify({ rules: { "react-luau/parse-error": "off" } }),
  );
  const requests: Array<{ method: string; path: string; body: any }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const body: any = request.method === "GET" ? null : await request.json().catch(() => null);
      requests.push({ method: request.method, path: url.pathname, body });

      if (request.method === "GET" && url.pathname.endsWith("/pulls/7")) {
        return Response.json({ head: { sha: base }, base: { sha: base }, state: "open" });
      }

      if (request.method === "GET") return Response.json([]);

      return Response.json({ id: 1 });
    },
  });
  t.after(() => server.stop(true));
  const result = await runWithApi(root, base, server.url.toString(), {
    args: ["--blocking", "none"],
  });
  assert.equal(result.status, 1, result.stderr);
  const summary = requests.find(
    (request) => request.path.endsWith("/issues/7/comments") && request.method === "POST",
  );
  assert.match(summary?.body.body, /analysis incomplete/);
  assert.doesNotMatch(summary?.body.body, /found no new issues|🎉|100\/100|Excellent/);
  assert.ok(
    requests.some(
      (request) => request.path.includes("/statuses/") && request.body.state === "error",
    ),
  );
  assert.ok(
    !requests.some(
      (request) =>
        request.method === "DELETE" ||
        (request.path.endsWith("/reviews") && request.method === "POST"),
    ),
  );
  assert.match(fs.readFileSync(path.join(root, "outputs.txt"), "utf8"), /analysis-complete=false/);
});

test("push check run annotations use repository paths for nested scan directories", async (t) => {
  const root = createRepo(VALID_COMPONENT);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "game"));
  fs.writeFileSync(path.join(root, "game", "Component.luau"), INVALID_COMPONENT);
  git(root, "add", ".");
  git(root, "commit", "-m", "nested");
  const checkRuns: any[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/check-runs")) {
        checkRuns.push(await request.json());
      }

      return Response.json({ id: 1 });
    },
  });
  t.after(() => server.stop(true));
  const result = await runWithApi(root, "", server.url.toString(), {
    args: ["--directory", "game"],
    env: { GITHUB_EVENT_NAME: "push", GITHUB_SHA: git(root, "rev-parse", "HEAD") },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    checkRuns[0]?.output.annotations.map((annotation: any) => annotation.path),
    ["game/Component.luau"],
  );
});

test("read-only fork token failures preserve diagnostics and the blocking gate", async (t) => {
  const root = createRepo(VALID_COMPONENT);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "Component.luau"), INVALID_COMPONENT);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
    },
  });
  t.after(() => server.stop(true));
  const result = await runWithApi(root, base, server.url.toString());
  assert.equal(result.status, 1);
  assert.match(result.stdout, /no-prop-mutation/);
  assert.match(result.stderr, /could not update the sticky PR comment/);
  assert.match(result.stderr, /could not update inline review comments/);
  assert.match(result.stderr, /could not publish the commit status/);
  assert.match(result.stderr, /could not publish check run annotations/);
  assert.match(result.stdout, /^::error file=Component\.luau/m);
  assert.match(fs.readFileSync(path.join(root, "outputs.txt"), "utf8"), /error-count=1/);
});

test("generated workflow passes directory values as data, including shell metacharacters", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-workflow-shell-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workflow = renderGitHubWorkflow({
    provider: "github",
    blocking: "none",
    scope: "changed",
    comment: false,
    reviewComments: false,
    commitStatus: false,
    maxAnnotations: 10,
    maxReviewComments: 50,
    directory: ".",
    project: "*",
  });
  const parsed = parseWorkflow(
    { name: "react-luau-doctor.yml", content: workflow },
    new NoOperationTraceWriter(),
  );
  assert.ok(parsed.value);
  const template = await convertWorkflowTemplate(parsed.context, parsed.value);
  assert.equal(parsed.context.errors.count, 0, JSON.stringify(parsed.context.errors.getErrors()));
  const job = template.jobs[0];
  assert.equal(job.type, "job");

  if (job.type !== "job") return;

  const runStep = job.steps.find((step) => "run" in step);
  assert.ok(runStep && "run" in runStep);
  const script = runStep.run.assertString("run").value;
  assert.ok(script.includes('--directory "$DOCTOR_DIRECTORY"'));
  assert.ok(script.includes('--project "$DOCTOR_PROJECT"'));
  const command = script.replace(
    /^bunx --bun \S+ ci run/,
    `"${process.execPath.replaceAll("\\", "/")}" capture.ts`,
  );
  assert.notEqual(command, script);
  fs.writeFileSync(
    path.join(root, "capture.ts"),
    "console.log(JSON.stringify(Bun.argv.slice(2)));\n",
  );
  const shellScript = path.join(root, "workflow.sh");
  fs.writeFileSync(shellScript, command);
  const value = 'a"; touch INJECTED; # $(touch INJECTED)';
  const result = spawnSync(process.execPath, [shellScript], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      DOCTOR_DIRECTORY: value,
      DOCTOR_PROJECT: "*",
      DOCTOR_SCOPE: "changed",
      DOCTOR_BLOCKING: "none",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(result.stdout.trim()) as string[];
  assert.equal(args[args.indexOf("--directory") + 1], value);
  assert.equal(fs.existsSync(path.join(root, "INJECTED")), false);
});
