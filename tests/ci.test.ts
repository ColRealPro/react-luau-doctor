import { expect, test, onTestFinished } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  convertWorkflowTemplate,
  NoOperationTraceWriter,
  parseWorkflow,
} from "@actions/workflow-parser";
import { renderGitHubWorkflow } from "../src/ci";
import { gitExecutable } from "../src/git";
import packageJson from "../package.json";
import {
  GitHubClient,
  publishCheckRun,
  reconcileReviews,
  type Review,
  type ReviewAnalysis,
  type ReviewComment,
  type ReviewFinding,
} from "../src/ci/github";
import type { Diagnostic } from "../src/types";

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

interface MockGitHub {
  client: GitHubClient;
  reviews: Review[];
  comments: ReviewComment[];
  resolved: Set<number>;
}

function mockGitHub(): MockGitHub {
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
  onTestFinished(() => {
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

test("inline reviews retain original membership across reruns, shifted lines, partial and full fixes", async () => {
  const mock = mockGitHub();
  const first = diagnostic("Component.luau", 3, "error", "First message");
  const second = diagnostic("Component.luau", 6, "warning", "Second message");
  expect(await reconcile(mock, analysis([first, second]))).toBe(2);
  const originalIds = mock.comments.map((comment) => comment.id);
  await reconcile(mock, analysis([first, second]));
  expect(mock.comments.map((comment) => comment.id)).toEqual(originalIds);
  const shifted = { ...second, location: { ...second.location, line: 20, endLine: 20 } };
  await reconcile(mock, analysis([shifted]));
  expect(mock.comments.length).toBe(1);
  expect(mock.comments[0].id).toBe(originalIds[1]);
  expect(mock.reviews[0].body!).toMatch(/\*\*1 of these 2 issues fixed\*\* · 1 still remains in the PR/);
  await reconcile(mock, analysis([]));
  expect(mock.comments.length).toBe(0);
  expect(mock.reviews[0].body!).toMatch(/\*\*Both issues fixed in later commits\*\*/);
  expect(mock.reviews.length).toBe(1);
});

test("fixed human discussions stay intact and use actual thread resolution state", async () => {
  const mock = mockGitHub();
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
  expect(mock.comments.length).toBe(2);
  expect(mock.reviews[0].body!).toMatch(/\*\*This issue fixed in later commits\*\* · 1 discussion awaiting resolution/);
  expect(mock.reviews[0].body!).not.toMatch(/\\color|\\textsf/);
  mock.resolved.add(100);
  await reconcile(mock, analysis([]));
  expect(mock.comments.length).toBe(2);
  expect(mock.reviews[0].body!).not.toMatch(/awaiting resolution/);
});

test("analyzer changes re-verify earlier findings against the reviewed commit", async () => {
  const mock = mockGitHub();
  const first = diagnostic("Component.luau", 3, "error", "First message");
  const second = diagnostic("Component.luau", 6, "warning", "Second message");
  await reconcile(mock, analysis([first, second]));
  const updated = (historical: ReviewAnalysis["historical"], current: Diagnostic[] = []) => ({
    ...analysis(current),
    signature: "updated",
    historical,
  });
  await reconcile(mock, updated(async () => new Map()));
  expect(mock.reviews[0].body!).toMatch(/2 issues awaiting verification/);
  await reconcile(
    mock,
    updated(async () => new Map([["Component.luau", [finding(first)]]]), [first]),
  );
  expect(mock.reviews[0].body!).toMatch(/1 still remains in the PR · 1 issue no longer reported/);
  expect(mock.comments.length).toBe(1);
  await reconcile(
    mock,
    updated(async () => {
      throw new Error("verified reviews should not be rescanned");
    }),
  );
  expect(mock.reviews[0].body!).toMatch(/\*\*1 of these 2 issues fixed\*\* · 1 issue no longer reported/);
  expect(mock.comments.length).toBe(0);
});

test("inline reviews respect the configured limit and track reviews above the old cap", async () => {
  const mock = mockGitHub();
  const diagnostics = Array.from({ length: 60 }, (_, index) =>
    diagnostic("Component.luau", index + 1, "warning"),
  );
  const inline = () => true;
  expect(await reconcile(mock, analysis(diagnostics), inline, 50)).toBe(50);
  await reconcile(mock, analysis(diagnostics), inline, 50);
  expect(mock.reviews.length).toBe(1);
  expect(mock.comments.length).toBe(50);
});

test("check runs append annotations in batches before completing", async () => {
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
  onTestFinished(() => {
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
  expect(requests.map((request) => [
      request.method,
      request.path,
      request.body.output.annotations.length,
    ])).toEqual([
      ["POST", "/repos/test/project/check-runs", 50],
      ["PATCH", "/repos/test/project/check-runs/5", 50],
      ["PATCH", "/repos/test/project/check-runs/5", 20],
    ]);
  expect(requests[0].body.status).toBe("in_progress");
  expect(requests[2].body.status).toBe("completed");
  expect(requests[2].body.conclusion).toBe("neutral");
});

test("ci config rewrites gate, scope, and reporting settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-ci-config-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));

  expect(run(["ci", "install", "--yes", "--cwd", root]).status).toBe(0);
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
  expect(configured.status, configured.stderr).toBe(0);
  const reconfigured = run(["ci", "config", "--yes", "--cwd", root, "--max-annotations", "0"]);
  expect(reconfigured.status, reconfigured.stderr).toBe(0);
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/react-luau-doctor.yml"),
    "utf8",
  );
  expect(workflow).toMatch(/DOCTOR_BLOCKING: warning/);
  expect(workflow).toMatch(/DOCTOR_SCOPE: lines/);
  expect(workflow).toMatch(/--no-comment/);
  expect(workflow).toMatch(/--no-review-comments/);
  expect(workflow).toMatch(/--no-commit-status/);
  expect(workflow).toMatch(/--max-annotations 0/);
  expect(workflow).toMatch(/--max-review-comments 30/);
  const capped = run(["ci", "config", "--yes", "--cwd", root, "--max-review-comments", "51"]);
  expect(capped.status).not.toBe(0);
  expect(capped.stderr).toMatch(/--max-review-comments must be an integer from 0 to 50/);
});

test("ci upgrade refreshes the npm pin while preserving workflow configuration", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-ci-upgrade-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));

  expect(run(["ci", "install", "--yes", "--cwd", root, "--blocking", "error", "--scope", "files"])
      .status).toBe(0);
  const workflowPath = path.join(root, ".github/workflows/react-luau-doctor.yml");
  const installed = fs.readFileSync(workflowPath, "utf8");
  fs.writeFileSync(
    workflowPath,
    installed.replace(`${packageJson.name}@${packageJson.version}`, `${packageJson.name}@0.0.0`),
  );

  const result = run(["ci", "upgrade", "--yes", "--cwd", root]);
  expect(result.status, result.stderr).toBe(0);
  const workflow = fs.readFileSync(workflowPath, "utf8");
  expect(workflow.includes(`${packageJson.name}@${packageJson.version}`)).toBeTruthy();
  expect(workflow).toMatch(/DOCTOR_BLOCKING: error/);
  expect(workflow).toMatch(/DOCTOR_SCOPE: files/);
});

test("GitLab scaffold supports detached merge-request scans and blocking", () => {
  const root = createRepo(VALID_COMPONENT);
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));

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
  expect(result.status, result.stderr).toBe(0);
  const workflow = fs.readFileSync(path.join(root, ".gitlab-ci.yml"), "utf8");
  expect(workflow).toMatch(/oven\/bun:1\.4\.0/);
  expect(workflow).toMatch(/DOCTOR_BLOCKING: "warning"/);
  expect(workflow.includes(`${packageJson.name}@${packageJson.version}`)).toBeTruthy();

  const parsed = Bun.YAML.parse(workflow) as {
    "react-luau-doctor": {
      variables: Record<string, string>;
      before_script: string[];
      script: string[];
    };
  };
  const job = parsed["react-luau-doctor"];
  expect(job.before_script[0]!).toMatch(/apt-get install .* git$/);
  expect(job.script[0]).toBe(`bunx --bun ${packageJson.name}@${packageJson.version} "$DOCTOR_DIRECTORY" --scope "$DOCTOR_SCOPE" --blocking "$DOCTOR_BLOCKING" --no-color`);

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
  expect(clean.status, clean.stderr).toBe(0);

  fs.writeFileSync(path.join(root, "Component.luau"), INVALID_COMPONENT);
  git(root, "add", "Component.luau");
  git(root, "commit", "-m", "introduce finding");
  const blocking = run(args, root, env);
  expect(blocking.status, blocking.stderr).toBe(1);
  expect(blocking.stdout).toMatch(/no-prop-mutation/);

  const nonblocking = run([...args, "--blocking", "none"], root, env);
  expect(nonblocking.status, nonblocking.stderr).toBe(0);
  expect(nonblocking.stdout).toMatch(/no-prop-mutation/);

  const missingBase = run(args, root, { ...env, CI_MERGE_REQUEST_DIFF_BASE_SHA: "0".repeat(40) });
  expect(missingBase.status).not.toBe(0);
  expect(missingBase.stderr).toMatch(/Could not resolve git base ref/);
});

test("ci run reports introduced findings and writes GitHub step outputs without network surfaces", () => {
  const root = createRepo(VALID_COMPONENT);
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
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

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/no-prop-mutation/);
  const outputs = fs.readFileSync(outputPath, "utf8");
  expect(outputs).toMatch(/total-issues=1/);
  expect(outputs).toMatch(/error-count=1/);
  expect(outputs).toMatch(/fixed-issues=0/);
  expect(outputs).toMatch(/affected-files=1/);
});

test("ci run reports fixed issues for pull requests", () => {
  const root = createRepo(INVALID_COMPONENT);
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
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

  expect(result.status, result.stderr).toBe(0);
  const outputs = fs.readFileSync(outputPath, "utf8");
  expect(outputs).toMatch(/total-issues=0/);
  expect(outputs).toMatch(/fixed-issues=1/);
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

test("PR reporting keeps summaries PR-wide and new inline reviews scoped to the latest push", async () => {
  const root = createRepo(VALID_COMPONENT);
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
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
  onTestFinished(() => server.stop(true));

  const result = await runWithApi(root, base, server.url.toString(), { event: { action: "opened" } });
  expect(result.status, result.stderr).toBe(1);
  expect(result.stdout).toMatch(/no-prop-mutation/);
  expect(requests.some(
      (request) => request.method === "POST" && request.path.endsWith("/issues/7/comments"),
    )).toBeTruthy();
  const review = requests.find(
    (request) => request.method === "POST" && request.path.endsWith("/pulls/7/reviews"),
  );
  expect(review?.body?.comments?.[0]?.line).toBe(3);
  expect(requests.some(
      (request) => request.path.includes("/statuses/") && request.body?.state === "failure",
    )).toBeTruthy();

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
  expect((await synchronize(before)).status).toBe(1);
  expect(reviewRequests().length).toBe(0);

  before = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "Component.luau"), `\n${INVALID_COMPONENT}`);
  git(root, "add", "Component.luau");
  git(root, "commit", "-m", "edit without new findings");
  expect((await synchronize(before)).status).toBe(1);
  expect(reviewRequests().length).toBe(0);

  before = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "NewComponent.luau"), INVALID_COMPONENT);
  git(root, "add", "NewComponent.luau");
  git(root, "commit", "-m", "introduce another finding");
  expect((await synchronize(before)).status).toBe(1);
  expect(reviewRequests().length).toBe(1);
  expect(reviewRequests()[0]?.body.comments.map((comment: any) => comment.path)).toEqual(["NewComponent.luau"]);
  expect(fs.readFileSync(path.join(root, "outputs.txt"), "utf8")).toMatch(/total-issues=2/);

  const unavailable = await synchronize("0".repeat(40));
  expect(unavailable.status).toBe(1);
  expect(unavailable.stderr).toMatch(/new inline comments were skipped/);
  expect(reviewRequests().length).toBe(0);
}, 30_000);

test("PR reviews verify fixes made alongside configuration changes", async () => {
  const root = createRepo(VALID_COMPONENT);
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "Component.luau"), INVALID_COMPONENT);
  git(root, "add", "Component.luau");
  git(root, "commit", "-m", "introduce finding");

  const reviews: Review[] = [];
  const comments: ReviewComment[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const body: any = request.method === "GET" ? null : await request.json().catch(() => null);

      if (request.method === "GET" && url.pathname.endsWith("/pulls/7")) {
        return Response.json({
          head: { sha: git(root, "rev-parse", "HEAD") },
          base: { sha: base },
          state: "open",
        });
      }

      if (request.method === "GET" && url.pathname.endsWith("/pulls/7/reviews")) {
        return Response.json(reviews);
      }

      if (request.method === "GET" && url.pathname.endsWith("/pulls/7/comments")) {
        return Response.json(comments);
      }

      if (request.method === "GET") return Response.json([]);

      if (url.pathname === "/graphql") {
        const nodes = comments.map((comment) => ({
          isResolved: false,
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

      if (request.method === "POST" && url.pathname.endsWith("/pulls/7/reviews")) {
        const id = reviews.length + 1;
        reviews.push({ id, body: body.body, user: { type: "Bot" }, commit_id: body.commit_id });

        for (const comment of body.comments) {
          comments.push({
            id: comments.length + 100,
            pull_request_review_id: id,
            path: comment.path,
            line: comment.line,
            original_line: comment.line,
            commit_id: body.commit_id,
            body: comment.body,
            user: { type: "Bot" },
          });
        }
      }

      if (request.method === "PUT" && url.pathname.includes("/pulls/7/reviews/")) {
        reviews.find((review) => review.id === Number(url.pathname.split("/").at(-1)))!.body =
          body.body;
      }

      if (request.method === "DELETE" && url.pathname.includes("/pulls/comments/")) {
        const id = Number(url.pathname.split("/").at(-1));
        comments.splice(
          comments.findIndex((comment) => comment.id === id),
          1,
        );

        return new Response(null, { status: 204 });
      }

      return Response.json({ id: 1 });
    },
  });
  onTestFinished(() => server.stop(true));

  await runWithApi(root, base, server.url.toString(), { event: { action: "opened" } });
  expect(comments.length).toBe(1);

  const before = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "Component.luau"), VALID_COMPONENT);
  fs.writeFileSync(
    path.join(root, "react-luau-doctor.config.json"),
    JSON.stringify({ rules: { "react-luau/effect-needs-cleanup": "off" } }),
  );
  git(root, "add", ".");
  git(root, "commit", "-m", "fix finding and update config");
  const result = await runWithApi(root, base, server.url.toString(), {
    event: { action: "synchronize", before },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(reviews[0].body!).toMatch(/\*\*This issue fixed in later commits\*\*/);
  expect(reviews[0].body!).not.toMatch(/awaiting verification/);
  expect(comments.length).toBe(0);
}, 30_000);

test("suppressed syntax failures cannot produce clean CI results, success statuses, or review cleanup", async () => {
  const root = createRepo(VALID_COMPONENT);
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
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
  onTestFinished(() => server.stop(true));
  const result = await runWithApi(root, base, server.url.toString(), {
    args: ["--blocking", "none"],
  });
  expect(result.status, result.stderr).toBe(1);
  const summary = requests.find(
    (request) => request.path.endsWith("/issues/7/comments") && request.method === "POST",
  );
  expect(summary?.body.body).toMatch(/analysis incomplete/);
  expect(summary?.body.body).not.toMatch(/found no new issues|🎉|100\/100|Excellent/);
  expect(requests.some(
      (request) => request.path.includes("/statuses/") && request.body.state === "error",
    )).toBeTruthy();
  expect(!requests.some(
      (request) =>
        request.method === "DELETE" ||
        (request.path.endsWith("/reviews") && request.method === "POST"),
    )).toBeTruthy();
  expect(fs.readFileSync(path.join(root, "outputs.txt"), "utf8")).toMatch(/analysis-complete=false/);
});

test("push check run annotations use repository paths for nested scan directories", async () => {
  const root = createRepo(VALID_COMPONENT);
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
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
  onTestFinished(() => server.stop(true));
  const result = await runWithApi(root, "", server.url.toString(), {
    args: ["--directory", "game"],
    env: { GITHUB_EVENT_NAME: "push", GITHUB_SHA: git(root, "rev-parse", "HEAD") },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(checkRuns[0]?.output.annotations.map((annotation: any) => annotation.path)).toEqual(["game/Component.luau"]);
});

test("read-only fork token failures preserve diagnostics and the blocking gate", async () => {
  const root = createRepo(VALID_COMPONENT);
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "Component.luau"), INVALID_COMPONENT);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
    },
  });
  onTestFinished(() => server.stop(true));
  const result = await runWithApi(root, base, server.url.toString());
  expect(result.status).toBe(1);
  expect(result.stdout).toMatch(/no-prop-mutation/);
  expect(result.stderr).toMatch(/could not update the sticky PR comment/);
  expect(result.stderr).toMatch(/could not update inline review comments/);
  expect(result.stderr).toMatch(/could not publish the commit status/);
  expect(result.stderr).toMatch(/could not publish check run annotations/);
  expect(result.stdout).toMatch(/^::error file=Component\.luau/m);
  expect(fs.readFileSync(path.join(root, "outputs.txt"), "utf8")).toMatch(/error-count=1/);
});

test("generated workflow passes directory values as data, including shell metacharacters", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-workflow-shell-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
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
  expect(parsed.value).toBeTruthy();
  const template = await convertWorkflowTemplate(parsed.context, parsed.value!);
  expect(parsed.context.errors.count, JSON.stringify(parsed.context.errors.getErrors())).toBe(0);
  const job = template.jobs[0];
  expect(job.type).toBe("job");

  if (job.type !== "job") return;

  const runStep = job.steps.find((step) => "run" in step);
  expect(runStep && "run" in runStep).toBeTruthy();
  const script = runStep!.run.assertString("run").value;
  expect(script.includes('--directory "$DOCTOR_DIRECTORY"')).toBeTruthy();
  expect(script.includes('--project "$DOCTOR_PROJECT"')).toBeTruthy();
  const command = script.replace(
    /^bunx --bun \S+ ci run/,
    `"${process.execPath.replaceAll("\\", "/")}" capture.ts`,
  );
  expect(command).not.toBe(script);
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
  expect(result.status, result.stderr).toBe(0);
  const args = JSON.parse(result.stdout.trim()) as string[];
  expect(args[args.indexOf("--directory") + 1]).toBe(value);
  expect(fs.existsSync(path.join(root, "INJECTED"))).toBe(false);
});
