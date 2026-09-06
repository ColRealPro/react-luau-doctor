import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanProjectWithScope } from "../src/scope";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function createRepo(source: string): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-git-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "doctor@example.invalid");
  git(root, "config", "user.name", "React Luau Doctor Tests");
  const file = path.join(root, "Component.luau");
  fs.writeFileSync(file, source);
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  return { root, file };
}

const cleanSource = `local ReplicatedStorage = game:GetService("ReplicatedStorage")
local React = require(ReplicatedStorage.Packages.React)

local function Component(props)
\treturn React.createElement("TextLabel", { Text = props.text })
end

return Component
`;

const brokenSource = `local ReplicatedStorage = game:GetService("ReplicatedStorage")
local React = require(ReplicatedStorage.Packages.React)

local function Component(props)
\tprops.text = "mutated"
\treturn React.createElement("TextLabel", { Text = props.text })
end

return Component
`;

test("changed scope reports diagnostics introduced relative to the git base", async (t) => {
  const { root, file } = createRepo(cleanSource);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(file, brokenSource);

  const report = await scanProjectWithScope(root, { scope: "changed" });
  assert.equal(report.scope, "changed");
  assert.equal(report.changedFiles?.includes("Component.luau"), true);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/no-prop-mutation"), true);
});

test("changed scope does not re-report a pre-existing diagnostic after an unrelated edit", async (t) => {
  const { root, file } = createRepo(brokenSource);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(file, brokenSource.replace('return React.createElement("TextLabel", { Text = props.text })', 'return React.createElement("TextLabel", { Name = "Changed", Text = props.text })'));

  const report = await scanProjectWithScope(root, { scope: "changed" });
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/no-prop-mutation"), false);
});

test("lines scope only reports diagnostics whose source span touches changed lines", async (t) => {
  const { root, file } = createRepo(brokenSource);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const next = brokenSource.replace(
    '\treturn React.createElement("TextLabel", { Text = props.text })',
    '\tprops.other = "new"\n\treturn React.createElement("TextLabel", { Text = props.text })',
  );
  fs.writeFileSync(file, next);

  const report = await scanProjectWithScope(root, { scope: "lines" });
  const propMutations = report.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/no-prop-mutation");
  assert.equal(propMutations.length, 1);
  assert.equal(propMutations[0].location.line, 6);
});

test("lines scope considers secondary evidence highlights for aggregated diagnostics", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-highlight-lines-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "doctor@example.invalid");
  git(root, "config", "user.name", "React Luau Doctor Tests");

  fs.writeFileSync(path.join(root, "MemoChild.luau"), `local React = require(script.Parent.React)
local MemoChild = React.memo(function(props)
  return React.createElement("Frame")
end)
return MemoChild
`);
  const component = path.join(root, "Component.luau");
  const baseline = `local React = require(script.Parent.React)
local MemoChild = require(script.Parent.MemoChild)
local function Component()
  return React.createElement(MemoChild, {
    onClick = function() print("click") end,
    onHover = function() print("hover") end,
  })
end
return Component
`;
  fs.writeFileSync(component, baseline);
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");

  fs.writeFileSync(component, baseline.replace("    onHover =", "      onHover ="));
  const report = await scanProjectWithScope(root, { scope: "lines" });
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rerender-unstable-memo-props"), true);
});

test("staged scope analyzes index content instead of later worktree edits", async (t) => {
  const { root, file } = createRepo(cleanSource);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(file, brokenSource);
  git(root, "add", "Component.luau");
  fs.writeFileSync(file, cleanSource);

  const report = await scanProjectWithScope(root, { scope: "files", staged: true });
  assert.equal(report.scope, "staged");
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/no-prop-mutation"), true);
});

test("changed scope preserves the baseline identity of renamed files", async (t) => {
  const { root } = createRepo(brokenSource);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const renamed = path.join(root, "RenamedComponent.luau");
  git(root, "mv", "Component.luau", "RenamedComponent.luau");
  fs.writeFileSync(
    renamed,
    brokenSource.replace(
      'return React.createElement("TextLabel", { Text = props.text })',
      'return React.createElement("TextLabel", { Name = "Renamed", Text = props.text })',
    ),
  );

  const report = await scanProjectWithScope(root, { scope: "changed" });
  assert.deepEqual(report.changedFiles, ["RenamedComponent.luau"]);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/no-prop-mutation"), false);
});

test("changed scope batch-loads baseline files whose paths contain spaces", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-space-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "doctor@example.invalid");
  git(root, "config", "user.name", "React Luau Doctor Tests");
  const file = path.join(root, "Component With Space.luau");
  fs.writeFileSync(file, cleanSource);
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  fs.writeFileSync(file, brokenSource);

  const report = await scanProjectWithScope(root, { scope: "changed", cache: false });
  assert.deepEqual(report.changedFiles, ["Component With Space.luau"]);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/no-prop-mutation"), true);
});
