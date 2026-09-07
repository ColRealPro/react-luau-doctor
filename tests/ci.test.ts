import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderGitHubWorkflow } from "../src/ci";
import packageJson from "../package.json";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

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
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  return (result.stdout ?? "").trim();
}

function createRepo(source: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-ci-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "doctor@example.invalid");
  git(root, "config", "user.name", "React Luau Doctor Tests");
  fs.writeFileSync(path.join(root, "Component.luau"), source);
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  return root;
}

const VALID_COMPONENT = `local React = require(script.Parent.React)\nlocal function Component(props)\n\treturn React.createElement("TextLabel", { Text = props.text })\nend\nreturn Component\n`;
const INVALID_COMPONENT = `local React = require(script.Parent.React)\nlocal function Component(props)\n\tprops.text = "bad"\n\treturn React.createElement("TextLabel", { Text = props.text })\nend\nreturn Component\n`;

test("generated GitHub workflow includes required triggers, permissions, and a pinned npm package", () => {
  const workflow = renderGitHubWorkflow({
    provider: "github",
    blocking: "none",
    scope: "changed",
    comment: true,
    reviewComments: true,
    commitStatus: true,
    directory: ".",
    project: "*",
  });

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:\n    branches: \[main\]/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.match(workflow, /pull-requests: write/);
  assert.doesNotMatch(workflow, /issues: write/);
  assert.match(workflow, /statuses: write/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /bun-version: "1\.4\.0"/);
  assert.ok(workflow.includes(`bunx --bun ${packageJson.name}@${packageJson.version} ci run`));
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
});

test("generated GitHub workflow keeps contents read-only when inline review comments are disabled", () => {
  const workflow = renderGitHubWorkflow({
    provider: "github",
    blocking: "none",
    scope: "changed",
    comment: true,
    reviewComments: false,
    commitStatus: true,
    directory: ".",
    project: "*",
  });

  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /contents: write/);
});

test("ci install writes a version-pinned GitHub workflow", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-ci-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = run(["ci", "install", "--yes", "--cwd", root]);
  assert.equal(result.status, 0, result.stderr);
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/react-luau-doctor.yml"), "utf8");
  assert.match(workflow, /DOCTOR_BLOCKING: none/);
  assert.match(workflow, /DOCTOR_SCOPE: changed/);
  assert.match(workflow, /--comment/);
  assert.match(workflow, /--review-comments/);
  assert.match(workflow, /--commit-status/);
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
  ]);
  assert.equal(configured.status, 0, configured.stderr);
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/react-luau-doctor.yml"), "utf8");
  assert.match(workflow, /DOCTOR_BLOCKING: warning/);
  assert.match(workflow, /DOCTOR_SCOPE: lines/);
  assert.match(workflow, /--no-comment/);
  assert.match(workflow, /--no-review-comments/);
  assert.match(workflow, /--no-commit-status/);
});

test("ci upgrade refreshes the npm pin while preserving workflow configuration", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-ci-upgrade-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(run(["ci", "install", "--yes", "--cwd", root, "--blocking", "error", "--scope", "files"]).status, 0);
  const workflowPath = path.join(root, ".github/workflows/react-luau-doctor.yml");
  const installed = fs.readFileSync(workflowPath, "utf8");
  fs.writeFileSync(workflowPath, installed.replace(`${packageJson.name}@${packageJson.version}`, `${packageJson.name}@0.0.0`));

  const result = run(["ci", "upgrade", "--yes", "--cwd", root]);
  assert.equal(result.status, 0, result.stderr);
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assert.ok(workflow.includes(`${packageJson.name}@${packageJson.version}`));
  assert.match(workflow, /DOCTOR_BLOCKING: error/);
  assert.match(workflow, /DOCTOR_SCOPE: files/);
});

test("ci install can generate the GitLab gate-only scaffold", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-ci-gitlab-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = run(["ci", "install", "--yes", "--provider", "gitlab", "--cwd", root, "--blocking", "warning"]);
  assert.equal(result.status, 0, result.stderr);
  const workflow = fs.readFileSync(path.join(root, ".gitlab-ci.yml"), "utf8");
  assert.match(workflow, /oven\/bun:1\.4\.0/);
  assert.match(workflow, /DOCTOR_BLOCKING: "warning"/);
  assert.ok(workflow.includes(`${packageJson.name}@${packageJson.version}`));
});

test("ci run reports introduced findings and writes GitHub step outputs without network surfaces", (t) => {
  const root = createRepo(VALID_COMPONENT);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "Component.luau"), INVALID_COMPONENT);
  const eventPath = path.join(root, "event.json");
  const outputPath = path.join(root, "outputs.txt");
  fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 1, base: { sha: base, ref: "main" }, head: { sha: base, ref: "feature" } } }));

  const result = run([
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
  ], root, {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: outputPath,
  });

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
  fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 1, base: { sha: base, ref: "main" }, head: { sha: base, ref: "feature" } } }));

  const result = run([
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
  ], root, {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: outputPath,
  });

  assert.equal(result.status, 0, result.stderr);
  const outputs = fs.readFileSync(outputPath, "utf8");
  assert.match(outputs, /total-issues=0/);
  assert.match(outputs, /fixed-issues=1/);
});

async function runWithApi(
  root: string,
  base: string,
  api: string,
  blocking = "error",
  eventFields: Record<string, unknown> = {},
): Promise<Result> {
  const eventPath = path.join(root, "event.json");
  fs.writeFileSync(eventPath, JSON.stringify({
    ...eventFields,
    pull_request: { number: 7, base: { sha: base, ref: "main" }, head: { sha: git(root, "rev-parse", "HEAD"), ref: "feature" } },
  }));
  const child = Bun.spawn([process.execPath, cli, "ci", "run", "--blocking", blocking], {
    cwd: root,
    env: {
      ...process.env,
      GITHUB_TOKEN: "local-test-token",
      GITHUB_API_URL: api,
      GITHUB_REPOSITORY: "test/project",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: path.join(root, "outputs.txt"),
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, status };
}

test("PR reporting creates only new comments, deletes stale comments, archives empty reviews, counts fixes, and publishes gate status", async (t) => {
  const root = createRepo(VALID_COMPONENT);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = git(root, "rev-parse", "HEAD");
  const requests: Array<{ method: string; path: string; body: any }> = [];
  let sticky: any[] = [];
  let reviewComments: any[] = [];
  const reviews = new Map<number, { body: string }>();
  reviews.set(99, { body: "React-Luau Doctor review" });
  let nextReviewId = 100;
  let nextCommentId = 1000;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    const body: any = request.method === "GET" || request.method === "DELETE" ? null : await request.json().catch(() => null);
    requests.push({ method: request.method, path: url.pathname, body });

    if (request.method === "GET" && url.pathname.endsWith("/issues/7/comments")) return Response.json(sticky);
    if (request.method === "GET" && url.pathname.endsWith("/pulls/7/comments")) return Response.json(reviewComments);
    if (request.method === "GET" && url.pathname.endsWith("/pulls/7/reviews")) {
      return Response.json([...reviews].map(([id, review]) => ({ id, body: review.body, user: { type: "Bot" } })));
    }
    if (url.pathname.endsWith("/issues/7/comments") && request.method === "POST") {
      sticky = [{ id: 10, body: body.body, user: { type: "Bot" } }];
      return Response.json(sticky[0]);
    }
    if (url.pathname.endsWith("/issues/comments/10") && request.method === "PATCH") {
      sticky = [{ id: 10, body: body.body, user: { type: "Bot" } }];
      return Response.json(sticky[0]);
    }
    if (url.pathname.endsWith("/pulls/7/reviews") && request.method === "POST") {
      const reviewId = nextReviewId++;
      reviews.set(reviewId, { body: body.body });
      reviewComments.push(...body.comments.map((comment: any) => ({
        id: nextCommentId++,
        pull_request_review_id: reviewId,
        path: comment.path,
        position: 1,
        body: comment.body,
        user: { type: "Bot" },
      })));
      return Response.json({ id: reviewId, body: body.body });
    }
    if (url.pathname.includes("/pulls/comments/") && request.method === "DELETE") {
      const id = Number(url.pathname.split("/").at(-1));
      reviewComments = reviewComments.filter((comment) => comment.id !== id);
      return new Response(null, { status: 204 });
    }
    const reviewMatch = url.pathname.match(/\/pulls\/7\/reviews\/(\d+)$/);
    if (reviewMatch && request.method === "PUT") {
      const reviewId = Number(reviewMatch[1]);
      reviews.set(reviewId, { body: body.body });
      return Response.json({ id: reviewId, body: body.body });
    }
    return Response.json({ id: 1 });
  } });
  t.after(() => server.stop(true));

  fs.writeFileSync(path.join(root, "Component.luau"), INVALID_COMPONENT);
  let result = await runWithApi(root, base, server.url.toString());
  assert.equal(result.status, 1, result.stderr);
  assert.ok(requests.some(r => r.method === "POST" && r.path.endsWith("/reviews") && r.body.comments[0].line === 3));
  assert.ok(requests.some(r => r.path.includes("/statuses/") && r.body.state === "failure"));
  assert.equal(reviewComments.length, 1);
  assert.match(reviews.get(99)?.body ?? "", /no longer current/);

  requests.length = 0;
  result = await runWithApi(root, base, server.url.toString());
  assert.equal(result.status, 1, result.stderr);
  assert.equal(requests.filter(r => r.path.endsWith("/reviews") && r.method === "POST").length, 0);
  assert.equal(reviewComments.length, 1);

  git(root, "add", "Component.luau");
  git(root, "commit", "-m", "first issue");
  const previousHead = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "Second.luau"), INVALID_COMPONENT);
  git(root, "add", "Second.luau");
  git(root, "commit", "-m", "second issue");
  requests.length = 0;
  result = await runWithApi(root, base, server.url.toString(), "error", { action: "synchronize", before: previousHead });
  assert.equal(result.status, 1, result.stderr);
  const incrementalReview = requests.find(r => r.path.endsWith("/reviews") && r.method === "POST");
  assert.equal(incrementalReview?.body.comments.length, 1);
  assert.equal(incrementalReview?.body.comments[0].path, "Second.luau");
  assert.equal(reviewComments.length, 2);

  fs.writeFileSync(path.join(root, "Component.luau"), VALID_COMPONENT);
  fs.unlinkSync(path.join(root, "Second.luau"));
  requests.length = 0;
  result = await runWithApi(root, base, server.url.toString());
  assert.equal(result.status, 0, result.stderr);
  assert.ok(requests.some(r => r.method === "PATCH" && r.path.endsWith("/issues/comments/10")));
  assert.equal(requests.filter(r => r.method === "DELETE" && r.path.includes("/pulls/comments/")).length, 2);
  const archivedReviews = requests.filter(r => r.method === "PUT" && /\/pulls\/7\/reviews\/\d+$/.test(r.path));
  assert.equal(archivedReviews.length, 2);
  assert.ok(archivedReviews.every(r => r.body.body.includes("no longer current")));
  assert.equal(reviewComments.length, 0);
  assert.ok(requests.some(r => r.path.includes("/statuses/") && r.body.state === "success"));

  git(root, "add", "-A");
  git(root, "commit", "-m", "fix issues");
  fs.writeFileSync(path.join(root, "Component.luau"), INVALID_COMPONENT);
  git(root, "add", "Component.luau"); git(root, "commit", "-m", "existing issue");
  const brokenBase = git(root, "rev-parse", "HEAD");
  fs.unlinkSync(path.join(root, "Component.luau"));
  requests.length = 0;
  result = await runWithApi(root, brokenBase, server.url.toString());
  assert.equal(result.status, 0, result.stderr);
  assert.ok(requests.some(r => r.method === "PATCH" && r.body.body.includes("1 fixed")));
  assert.match(fs.readFileSync(path.join(root, "outputs.txt"), "utf8"), /fixed-issues=1/);
});

test("reintroduced findings replace stale outdated Doctor comments", async (t) => {
  const root = createRepo(VALID_COMPONENT);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = git(root, "rev-parse", "HEAD");
  const requests: Array<{ method: string; path: string; body: any }> = [];
  let reviewComments: any[] = [];
  const reviews = new Map<number, { body: string }>();
  let nextReviewId = 200;
  let nextCommentId = 2000;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    const body: any = request.method === "GET" || request.method === "DELETE" ? null : await request.json().catch(() => null);
    requests.push({ method: request.method, path: url.pathname, body });
    if (request.method === "GET" && url.pathname.endsWith("/issues/7/comments")) return Response.json([]);
    if (request.method === "GET" && url.pathname.endsWith("/pulls/7/comments")) return Response.json(reviewComments);
    if (request.method === "GET" && url.pathname.endsWith("/pulls/7/reviews")) {
      return Response.json([...reviews].map(([id, review]) => ({ id, body: review.body, user: { type: "Bot" } })));
    }
    if (url.pathname.endsWith("/pulls/7/reviews") && request.method === "POST") {
      const reviewId = nextReviewId++;
      reviews.set(reviewId, { body: body.body });
      reviewComments.push(...body.comments.map((comment: any) => ({
        id: nextCommentId++,
        pull_request_review_id: reviewId,
        path: comment.path,
        position: 1,
        body: comment.body,
        user: { type: "Bot" },
      })));
      return Response.json({ id: reviewId });
    }
    if (url.pathname.includes("/pulls/comments/") && request.method === "DELETE") {
      const id = Number(url.pathname.split("/").at(-1));
      reviewComments = reviewComments.filter((comment) => comment.id !== id);
      return new Response(null, { status: 204 });
    }
    const reviewMatch = url.pathname.match(/\/pulls\/7\/reviews\/(\d+)$/);
    if (reviewMatch && request.method === "PUT") {
      const reviewId = Number(reviewMatch[1]);
      reviews.set(reviewId, { body: body.body });
      return Response.json({ id: reviewId, body: body.body });
    }
    return Response.json({ id: 1 });
  } });
  t.after(() => server.stop(true));

  fs.writeFileSync(path.join(root, "Component.luau"), INVALID_COMPONENT);
  let result = await runWithApi(root, base, server.url.toString());
  assert.equal(result.status, 1, result.stderr);
  assert.equal(reviewComments.length, 1);
  const originalReviewId = reviewComments[0].pull_request_review_id;

  git(root, "add", "Component.luau");
  git(root, "commit", "-m", "introduce issue");
  fs.writeFileSync(path.join(root, "Component.luau"), VALID_COMPONENT);
  git(root, "add", "Component.luau");
  git(root, "commit", "-m", "fix issue");
  const fixedHead = git(root, "rev-parse", "HEAD");
  reviewComments[0].position = null;

  fs.writeFileSync(path.join(root, "Component.luau"), INVALID_COMPONENT);
  git(root, "add", "Component.luau");
  git(root, "commit", "-m", "reintroduce issue");
  requests.length = 0;
  result = await runWithApi(root, base, server.url.toString(), "error", { action: "synchronize", before: fixedHead });
  assert.equal(result.status, 1, result.stderr);
  const review = requests.find(r => r.path.endsWith("/reviews") && r.method === "POST");
  assert.equal(review?.body.comments.length, 1);
  assert.ok(requests.some(r => r.method === "DELETE" && r.path.includes("/pulls/comments/")));
  assert.ok(requests.some(r => r.method === "PUT" && r.path.endsWith(`/pulls/7/reviews/${originalReviewId}`)));
  assert.equal(reviewComments.length, 1);
  assert.notEqual(reviewComments[0].pull_request_review_id, originalReviewId);
  assert.match(reviews.get(originalReviewId)?.body ?? "", /no longer current/);

  requests.length = 0;
  result = await runWithApi(root, base, server.url.toString(), "error", { action: "synchronize", before: fixedHead });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(requests.filter(r => r.path.endsWith("/reviews") && r.method === "POST").length, 0);
  assert.equal(requests.filter(r => r.method === "DELETE" && r.path.includes("/pulls/comments/")).length, 0);
});

test("GitHub Enterprise review management stays on the REST API base", async (t) => {
  const root = createRepo(VALID_COMPONENT);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = git(root, "rev-parse", "HEAD");
  const requests: string[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    requests.push(url.pathname);
    if (request.method === "GET") return Response.json([]);
    return Response.json({ id: 1 });
  } });
  t.after(() => server.stop(true));

  const apiBase = new URL("api/v3", server.url).toString();
  const result = await runWithApi(root, base, apiBase);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(requests.some(pathname => pathname.includes("/api/v3/repos/test/project/pulls/7/comments")));
  assert.equal(requests.some(pathname => pathname.includes("graphql")), false);
});

test("read-only fork token failures preserve diagnostics and the blocking gate", async (t) => {
  const root = createRepo(VALID_COMPONENT);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "Component.luau"), INVALID_COMPONENT);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return Response.json({ message: "Resource not accessible by integration" }, { status: 403 }); } });
  t.after(() => server.stop(true));
  const result = await runWithApi(root, base, server.url.toString());
  assert.equal(result.status, 1);
  assert.match(result.stdout, /no-prop-mutation/);
  assert.match(result.stderr, /could not update the sticky PR comment/);
  assert.match(result.stderr, /could not update inline review comments/);
  assert.match(result.stderr, /could not publish the commit status/);
  assert.match(fs.readFileSync(path.join(root, "outputs.txt"), "utf8"), /error-count=1/);
});

test("GitHub reporting retries REST rate limits using Retry-After", async (t) => {
  const root = createRepo(VALID_COMPONENT);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = git(root, "rev-parse", "HEAD");
  let summaryRequests = 0;
  let reviewCommentRequests = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/issues/7/comments")) {
      summaryRequests += 1;
      if (summaryRequests === 1) {
        return Response.json({ message: "secondary rate limit" }, { status: 429, headers: { "Retry-After": "0" } });
      }
      return Response.json([]);
    }
    if (request.method === "GET" && url.pathname.endsWith("/pulls/7/comments")) {
      reviewCommentRequests += 1;
      if (reviewCommentRequests === 1) {
        return Response.json({ message: "secondary rate limit" }, { status: 429, headers: { "Retry-After": "0" } });
      }
      return Response.json([]);
    }
    if (request.method === "GET" && url.pathname.endsWith("/pulls/7/reviews")) return Response.json([]);
    return Response.json({ id: 1 });
  } });
  t.after(() => server.stop(true));

  const result = await runWithApi(root, base, server.url.toString());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(summaryRequests, 2);
  assert.equal(reviewCommentRequests, 2);
  assert.equal((result.stderr.match(/GitHub API 429; retrying in 0 seconds/g) ?? []).length, 2);
});

test("generated workflow passes directory values as data, including shell metacharacters", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-workflow-shell-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workflow = renderGitHubWorkflow({
    provider: "github",
    blocking: "none",
    scope: "changed",
    comment: false,
    reviewComments: false,
    commitStatus: false,
    directory: ".",
    project: "*",
  });
  const script = workflow.split("        run: >-\n")[1].trim().split("\n").map(line => line.trim()).join(" ");
  fs.writeFileSync(path.join(root, "bunx"), '#!/bin/bash\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  const value = 'a"; touch INJECTED; # $(touch INJECTED)';
  const result = spawnSync("bash", ["-e", "-c", script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      DOCTOR_DIRECTORY: value,
      DOCTOR_PROJECT: "*",
      DOCTOR_SCOPE: "changed",
      DOCTOR_BLOCKING: "none",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split("\n").includes(value));
  assert.equal(fs.existsSync(path.join(root, "INJECTED")), false);
});

test("summary lookup paginates and does not modify user-authored markers", async (t) => {
  const root = createRepo(VALID_COMPONENT);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "Component.luau"), INVALID_COMPONENT);
  const mutations: string[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET") {
      if (url.pathname.includes("/issues/")) return Response.json(url.searchParams.get("page") === "1"
        ? Array.from({ length: 100 }, (_, i) => ({ id: i, body: "<!-- react-luau-doctor:summary -->", user: { type: "User" } }))
        : [{ id: 101, body: "<!-- react-luau-doctor:summary -->", user: { type: "Bot" } }]);
      return Response.json([{ id: 200, body: "<!-- react-luau-doctor:review -->", user: { type: "User" } }]);
    }
    mutations.push(`${request.method} ${url.pathname}`);
    return Response.json({ id: 1 });
  } });
  t.after(() => server.stop(true));
  const result = await runWithApi(root, base, server.url.toString());
  assert.equal(result.status, 1);
  assert.ok(mutations.includes("PATCH /repos/test/project/issues/comments/101"));
  assert.ok(mutations.every(m => !m.startsWith("DELETE")));
  assert.equal(mutations.filter(m => m.startsWith("PATCH")).length, 1);
});
