import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { convertWorkflowTemplate, NoOperationTraceWriter, parseWorkflow } from "@actions/workflow-parser";
import { renderGitHubWorkflow } from "../src/ci";
import { gitExecutable } from "../src/git";
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
  const result = spawnSync(gitExecutable, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "React Luau Doctor Tests", GIT_AUTHOR_EMAIL: "doctor@example.invalid", GIT_COMMITTER_NAME: "React Luau Doctor Tests", GIT_COMMITTER_EMAIL: "doctor@example.invalid" },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
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
): Promise<Result> {
  const eventPath = path.join(root, "event.json");
  fs.writeFileSync(eventPath, JSON.stringify({
    pull_request: { number: 7, base: { sha: base, ref: "main" }, head: { sha: git(root, "rev-parse", "HEAD"), ref: "feature" } },
  }));
  const child = Bun.spawn([process.execPath, cli, "ci", "run", "--blocking", "error"], {
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

test("PR reporting posts a summary, inline review, and blocking status", async (t) => {
  const root = createRepo(VALID_COMPONENT);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "Component.luau"), INVALID_COMPONENT);

  const requests: Array<{ method: string; path: string; body: any }> = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    const body: any = request.method === "GET" ? null : await request.json().catch(() => null);
    requests.push({ method: request.method, path: url.pathname, body });
    if (request.method === "GET") return Response.json([]);
    return Response.json({ id: 1 });
  } });
  t.after(() => server.stop(true));

  const result = await runWithApi(root, base, server.url.toString());
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /no-prop-mutation/);
  assert.ok(requests.some((request) => request.method === "POST" && request.path.endsWith("/issues/7/comments")));
  const review = requests.find((request) => request.method === "POST" && request.path.endsWith("/pulls/7/reviews"));
  assert.equal(review?.body?.comments?.[0]?.line, 3);
  assert.ok(requests.some((request) => request.path.includes("/statuses/") && request.body?.state === "failure"));
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
    directory: ".",
    project: "*",
  });
  const parsed = parseWorkflow({ name: "react-luau-doctor.yml", content: workflow }, new NoOperationTraceWriter());
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
  const command = script.replace(/^bunx --bun \S+ ci run/, `"${process.execPath.replaceAll("\\", "/")}" capture.ts`);
  assert.notEqual(command, script);
  fs.writeFileSync(path.join(root, "capture.ts"), "console.log(JSON.stringify(Bun.argv.slice(2)));\n");
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
