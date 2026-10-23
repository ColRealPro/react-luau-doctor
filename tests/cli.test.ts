import { expect, test, onTestFinished, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitExecutable } from "../src/git";
import type { ScanReport } from "../src/types";

setDefaultTimeout(30_000);

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

const fixtures = path.resolve(import.meta.dir, "fixtures");

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd = process.cwd()): CliResult {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync(gitExecutable, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "React Luau Doctor Tests", GIT_AUTHOR_EMAIL: "doctor@example.invalid", GIT_COMMITTER_NAME: "React Luau Doctor Tests", GIT_COMMITTER_EMAIL: "doctor@example.invalid" },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
}

function createGitRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-cli-"));
  git(root, "init", "-b", "main");
  fs.writeFileSync(
    path.join(root, "Component.luau"),
    `local ReplicatedStorage = game:GetService("ReplicatedStorage")\nlocal React = require(ReplicatedStorage.Packages.React)\nlocal function Component(props)\n\treturn React.createElement("TextLabel", { Text = props.text })\nend\nreturn Component\n`,
  );
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  return root;
}

function enableBindingCandidate(root: string): void {
  fs.writeFileSync(path.join(root, "react-luau-doctor.config.json"), JSON.stringify({
    rules: { "react-luau/prefer-binding-over-state-candidate": "suggestion" },
  }));
}

test("category and no-warnings flags filter JSON diagnostics", () => {
  const category = run([path.join(fixtures, "bad-component.luau"), "--json", "--category", "Performance", "--blocking", "none"]);
  expect(category.status, category.stderr).toBe(0);
  const categoryReport = JSON.parse(category.stdout) as ScanReport;
  expect(categoryReport.diagnostics.length).toBeGreaterThan(0);
  expect(categoryReport.diagnostics.every(diagnostic => diagnostic.category === "Performance")).toBe(true);

  const errorsOnly = run([path.join(fixtures, "bad-component.luau"), "--json", "--no-warnings", "--blocking", "none"]);
  expect(errorsOnly.status, errorsOnly.stderr).toBe(0);
  const errorsOnlyReport = JSON.parse(errorsOnly.stdout) as ScanReport;
  expect(errorsOnlyReport.diagnostics.length).toBeGreaterThan(0);
  expect(errorsOnlyReport.diagnostics.every(diagnostic => diagnostic.severity === "error")).toBe(true);
});

test("--blocking controls the process exit gate", () => {
  const blocking = run([path.join(fixtures, "bad-component.luau"), "--no-score"]);
  const advisory = run([path.join(fixtures, "bad-component.luau"), "--blocking", "none", "--no-score"]);
  expect(blocking.status).toBe(1);
  expect(advisory.status).toBe(0);
});

test("--no-respect-inline-disables exposes suppressed diagnostics", () => {
  const file = path.join(fixtures, "inline-disables.luau");
  const normal = JSON.parse(run([file, "--json", "--blocking", "none"]).stdout) as ScanReport;
  const audit = JSON.parse(run([file, "--json", "--no-respect-inline-disables", "--blocking", "none"]).stdout) as ScanReport;
  const count = (report: ScanReport) => report.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/no-prop-mutation").length;
  expect(count(normal)).toBe(1);
  expect(count(audit)).toBe(3);
});

test("--diff scans only diagnostics introduced relative to git HEAD", () => {
  const root = createGitRepo();
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "Component.luau");
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace(
      '\treturn React.createElement("TextLabel", { Text = props.text })',
      '\tprops.text = "bad"\n\treturn React.createElement("TextLabel", { Text = props.text })',
    ),
  );

  const result = run([".", "--diff", "--json", "--blocking", "none"], root);
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout) as ScanReport;
  expect(report.scope).toBe("changed");
  expect(report.changedFiles).toEqual(["Component.luau"]);
  expect(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/no-prop-mutation")).toBe(true);
});

test("--diff respects project include and ignore patterns", () => {
  const root = createGitRepo();
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));

  const story = path.join(root, "Ignored.story.luau");
  fs.writeFileSync(
    story,
    `local ReplicatedStorage = game:GetService("ReplicatedStorage")
local React = require(ReplicatedStorage.Packages.React)
local function Story(props)
	return React.createElement("TextLabel", { Text = props.text })
end
return Story
`,
  );
  git(root, "add", ".");
  git(root, "commit", "-m", "add story");

  fs.writeFileSync(
    path.join(root, "react-luau-doctor.config.json"),
    `${JSON.stringify({ ignore: ["**/*.story.lua", "**/*.story.luau"] }, null, 2)}\n`,
  );
  fs.writeFileSync(
    story,
    fs.readFileSync(story, "utf8").replace(
      '\treturn React.createElement("TextLabel", { Text = props.text })',
      '\tprops.text = "bad"\n\treturn React.createElement("TextLabel", { Text = props.text })',
    ),
  );

  const result = run([".", "--diff", "HEAD", "--json", "--blocking", "none"], root);
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout) as ScanReport;
  expect(report.changedFiles).toEqual([]);
  expect(report.diagnostics.length).toBe(0);
});

test("rules list JSON and rules configuration commands operate on project config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-rules-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));

  const disabled = run(["rules", "disable", "exhaustive-deps", "--cwd", root]);
  expect(disabled.status, disabled.stderr).toBe(0);
  const listed = run(["rules", "list", "--configured", "--json", "--cwd", root]);
  expect(listed.status, listed.stderr).toBe(0);
  const rows = JSON.parse(listed.stdout) as Array<{ id: string; severity: string; defaultSeverity: string; category: string; description: string }>;
  expect(rows.map(({ id, severity }) => ({ id, severity }))).toEqual([{
    id: "react-luau/exhaustive-deps",
    severity: "off",
  }]);
});

test("max-duration can return an explicit partial report", () => {
  const result = run([fixtures, "--json", "--max-duration", "0.000001", "--blocking", "none"]);
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout) as ScanReport;
  expect(report.partial).toBe(true);
  expect((report.skippedFiles ?? []).length > 0).toBe(true);
});

test("why preserves full-project context for project-aware diagnostics and explains the finding", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-why-project-context-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useObservedValue.luau"), `local React = require(script.Parent.React)
local RunService = game:GetService("RunService")
local function useObservedValue()
  local value, setValue = React.useState(0)
  React.useEffect(function()
    local connection = RunService.RenderStepped:Connect(setValue)
    return function() connection:Disconnect() end
  end, {})
  return value
end
return useObservedValue
`);

  fs.writeFileSync(path.join(root, "StructuralThing.luau"), `local React = require(script.Parent.React)
local function StructuralThing(props)
  return React.createElement("Frame", nil, {
    child = props.rotation > 0 and React.createElement("Frame") or nil,
  })
end
return StructuralThing
`);

  fs.writeFileSync(path.join(root, "Consumer.luau"), `local React = require(script.Parent.React)
local useObservedValue = require(script.Parent.useObservedValue)
local StructuralThing = require(script.Parent.StructuralThing)
local function Consumer()
  local value = useObservedValue()
  return React.createElement("Frame", { Rotation = value }, {
    child = React.createElement(StructuralThing, { rotation = value }),
  })
end
return Consumer
`);

  enableBindingCandidate(root);

  const scan = run([".", "--json", "--blocking", "none"], root);
  expect(scan.status, scan.stderr).toBe(0);
  const report = JSON.parse(scan.stdout) as ScanReport;
  const candidate = report.diagnostics.find((diagnostic) => diagnostic.rule === "react-luau/prefer-binding-over-state-candidate");
  expect(candidate).toBeTruthy();
  expect(candidate!.file).toBe("Consumer.luau");

  const why = run(["why", `Consumer.luau:${candidate!.location.line}`, "--cwd", root], root);
  expect(why.status, why.stderr).toBe(0);
  expect(why.stdout).toMatch(/react-luau\/prefer-binding-over-state-candidate/);
  expect(why.stdout).toMatch(/>\s+5\s+\|\s+local value = useObservedValue/);
});

test("why reports suppressed diagnostics with the same detailed explanation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-why-suppressed-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local function Component(props)
  -- react-luau-doctor-disable-next-line react-luau/no-prop-mutation
  props.value = 1
  return React.createElement("Frame")
end
return Component
`);

  const why = run(["why", "Component.luau:4", "--cwd", root], root);
  expect(why.status, why.stderr).toBe(0);
  expect(why.stdout).toMatch(/hidden by an inline react-luau-doctor suppression/);
  expect(why.stdout).toMatch(/> 4 \|   props\.value = 1\n/);
  expect(why.stdout).toMatch(/react-luau\/no-prop-mutation/);
});

test("subdirectory scans use the config from the command working directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-subdir-config-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "src", "ui", "Components", "Feature");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(root, "react-luau-doctor.config.json"), JSON.stringify({
    rules: { "react-luau/no-prop-mutation": "off" },
  }));
  fs.writeFileSync(path.join(directory, "Component.luau"), `local React = require(script.Parent.React)
local function Component(props)
  props.value = 2
  return React.createElement("TextLabel", { Text = tostring(props.value) })
end
return Component
`);

  const result = run(["src/ui/Components/Feature", "--json", "--blocking", "none", "--no-cache"], root);
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout) as ScanReport;
  expect(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/no-prop-mutation")).toBe(false);
});

test("subdirectory scans report paths relative to the command working directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-subdir-paths-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "src", "ui", "Components", "Feature");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "Component.luau"), `local React = require(script.Parent.React)
local function Component(props)
  props.value = 2
  return React.createElement("TextLabel", { Text = tostring(props.value) })
end
return Component
`);

  const result = run(["src/ui/Components/Feature", "--json", "--blocking", "none", "--no-cache"], root);
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout) as ScanReport;
  const diagnostic = report.diagnostics.find((entry) => entry.rule === "react-luau/no-prop-mutation");
  expect(diagnostic).toBeTruthy();
  expect(diagnostic!.file).toBe("src/ui/Components/Feature/Component.luau");
  expect(report.root).toBe(root);
});
