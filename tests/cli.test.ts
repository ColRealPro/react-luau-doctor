import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ScanReport } from "../src/types";

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
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
}

function createGitRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-cli-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "doctor@example.invalid");
  git(root, "config", "user.name", "React Luau Doctor Tests");
  fs.writeFileSync(
    path.join(root, "Component.luau"),
    `local ReplicatedStorage = game:GetService("ReplicatedStorage")\nlocal React = require(ReplicatedStorage.Packages.React)\nlocal function Component(props)\n\treturn React.createElement("TextLabel", { Text = props.text })\nend\nreturn Component\n`,
  );
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  return root;
}

test("default output is compact while --verbose shows per-file help text", () => {
  const compact = run([path.join(fixtures, "bad-component.luau"), "--blocking", "none"]);
  const verbose = run([path.join(fixtures, "bad-component.luau"), "--verbose", "--blocking", "none"]);
  assert.equal(compact.status, 0);
  assert.equal(verbose.status, 0);
  assert.match(compact.stdout, /Top rules:/);
  assert.equal(compact.stdout.includes("Call hooks at the top level"), false);
  assert.equal(verbose.stdout.includes("Call the hook unconditionally at the top level"), true);
});

test("JSON compact, score-only, category, and no-warnings modes are machine-readable", () => {
  const compactJson = run([path.join(fixtures, "bad-component.luau"), "--json", "--json-compact", "--blocking", "none"]);
  assert.equal(compactJson.status, 0);
  assert.equal(compactJson.stdout.trim().split(/\r?\n/).length, 1);
  const parsed = JSON.parse(compactJson.stdout) as ScanReport;
  assert.equal(parsed.diagnostics.length > 0, true);

  const score = run([path.join(fixtures, "bad-component.luau"), "--score", "--blocking", "none"]);
  assert.equal(score.status, 0);
  assert.match(score.stdout.trim(), /^\d+$/);

  const category = run([path.join(fixtures, "bad-component.luau"), "--json", "--category", "Performance", "--blocking", "none"]);
  const categoryReport = JSON.parse(category.stdout) as ScanReport;
  assert.equal(categoryReport.diagnostics.every((diagnostic) => diagnostic.category === "Performance"), true);

  const errorsOnly = run([path.join(fixtures, "bad-component.luau"), "--json", "--no-warnings", "--blocking", "none"]);
  const errorsOnlyReport = JSON.parse(errorsOnly.stdout) as ScanReport;
  assert.equal(errorsOnlyReport.counts.warning, 0);
  assert.equal(errorsOnlyReport.counts.suggestion, 0);
});

test("--blocking controls the process exit gate", () => {
  const blocking = run([path.join(fixtures, "bad-component.luau"), "--no-score"]);
  const advisory = run([path.join(fixtures, "bad-component.luau"), "--blocking", "none", "--no-score"]);
  assert.equal(blocking.status, 1);
  assert.equal(advisory.status, 0);
});

test("--output-dir and --annotations emit alternate report formats", (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-output-"));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const report = run([path.join(fixtures, "bad-component.luau"), "--output-dir", output, "--blocking", "none"]);
  assert.equal(report.status, 0);
  assert.equal(fs.existsSync(path.join(output, "report.json")), true);
  assert.equal(fs.existsSync(path.join(output, "diagnostics.json")), true);
  assert.equal(fs.existsSync(path.join(output, "summary.json")), true);

  const annotations = run([path.join(fixtures, "bad-component.luau"), "--annotations", "--blocking", "none"]);
  assert.equal(annotations.status, 0);
  assert.match(annotations.stdout, /::error file=/);
});

test("--no-respect-inline-disables exposes suppressed diagnostics", () => {
  const file = path.join(fixtures, "inline-disables.luau");
  const normal = JSON.parse(run([file, "--json", "--blocking", "none"]).stdout) as ScanReport;
  const audit = JSON.parse(run([file, "--json", "--no-respect-inline-disables", "--blocking", "none"]).stdout) as ScanReport;
  const count = (report: ScanReport) => report.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/no-prop-mutation").length;
  assert.equal(count(normal), 1);
  assert.equal(count(audit), 3);
});

test("--diff scans only diagnostics introduced relative to git HEAD", (t) => {
  const root = createGitRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "Component.luau");
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace(
      '\treturn React.createElement("TextLabel", { Text = props.text })',
      '\tprops.text = "bad"\n\treturn React.createElement("TextLabel", { Text = props.text })',
    ),
  );

  const result = run([".", "--diff", "--json", "--blocking", "none"], root);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as ScanReport;
  assert.equal(report.scope, "changed");
  assert.deepEqual(report.changedFiles, ["Component.luau"]);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/no-prop-mutation"), true);
});

test("--diff respects project include and ignore patterns", (t) => {
  const root = createGitRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

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
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as ScanReport;
  assert.deepEqual(report.changedFiles, []);
  assert.equal(report.diagnostics.length, 0);
});

test("rules list JSON and rules configuration commands operate on project config", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-rules-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const disabled = run(["rules", "disable", "exhaustive-deps", "--cwd", root]);
  assert.equal(disabled.status, 0, disabled.stderr);
  const listed = run(["rules", "list", "--configured", "--json", "--cwd", root]);
  assert.equal(listed.status, 0, listed.stderr);
  const rows = JSON.parse(listed.stdout) as Array<{ id: string; severity: string }>;
  assert.deepEqual(rows, [{
    id: "react-luau/exhaustive-deps",
    severity: "off",
    defaultSeverity: "warning",
    category: "Hooks",
    description: "React hook dependency tables should include captured reactive render values.",
  }]);
});

test("max-duration can return an explicit partial report", () => {
  const result = run([fixtures, "--json", "--max-duration", "0.000001", "--blocking", "none"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as ScanReport;
  assert.equal(report.partial, true);
  assert.equal((report.skippedFiles ?? []).length > 0, true);
});

test("why preserves full-project context for project-aware diagnostics and explains the finding", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-why-project-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useObservedValue.luau"), `local React = require(script.Parent.React)
local function useObservedValue(signal)
  local value, setValue = React.useState(0)
  React.useEffect(function()
    local connection = signal:Connect(setValue)
    return function() connection:Disconnect() end
  end, { signal })
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
local function Consumer(props)
  local value = useObservedValue(props.changed)
  return React.createElement(StructuralThing, { rotation = value })
end
return Consumer
`);

  const scan = run([".", "--json", "--blocking", "none"], root);
  assert.equal(scan.status, 0, scan.stderr);
  const report = JSON.parse(scan.stdout) as ScanReport;
  const candidate = report.diagnostics.find((diagnostic) => diagnostic.rule === "react-luau/prefer-binding-over-state-candidate");
  assert.ok(candidate);
  assert.equal(candidate.file, "Consumer.luau");

  const why = run(["why", `Consumer.luau:${candidate.location.line}`, "--cwd", root], root);
  assert.equal(why.status, 0, why.stderr);
  assert.match(why.stdout, /react-luau\/prefer-binding-over-state-candidate/);
  assert.match(why.stdout, /Why this fired/);
  assert.match(why.stdout, /A Binding can update visual values without rerendering the component/);
  assert.match(why.stdout, /What the rule checks/);
  assert.match(why.stdout, /Confidence/);
  assert.match(why.stdout, /How to fix/);
  assert.match(why.stdout, /When the current approach may be intentional/);
  assert.match(why.stdout, />\s+5\s+\|\s+local value = useObservedValue/);
});

test("why underlines precise evidence ranges instead of whole multiline containers", () => {
  const result = run(["why", "performance-issues.luau:37", "--cwd", fixtures], fixtures);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /react-luau\/rerender-unstable-memo-props/);
  assert.match(result.stdout, />\s+37\s+\|\s+native =/);
  assert.match(result.stdout, />\s+38\s+\|\s+onClick = function/);
  assert.doesNotMatch(result.stdout, />\s+39\s+\|/);
  assert.match(result.stdout, /\^{6}/);
  assert.match(result.stdout, /\^{7}/);
});

test("why renders readable suggested-change previews for rules with fix examples", () => {
  const result = run(["why", "performance-issues.luau:37", "--cwd", fixtures], fixtures);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Example pattern/);
  assert.match(result.stdout, /CURRENT/);
  assert.match(result.stdout, /SUGGESTED/);
  assert.match(result.stdout, /React\.useCallback/);
});

test("why normalizes file-level tab indentation in multiline suggested changes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-why-preview-tabs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Store.luau"), `local Store = {}
function Store:GetReactState(selector) return nil end
function Store:GetReactBinding(selector) return nil end
return Store
`);
  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local Store = require(script.Parent.Store)
local function Component()
	local visible = Store:GetReactState(function(raw)
		return raw.visible
	end)
	return React.createElement("Frame", { Visible = visible })
end
return Component
`);

  const result = run(["why", "Component.luau:4", "--cwd", root, "--no-color"], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CURRENT\n  Store:GetReactState\(function\(raw\)\n      return raw\.visible\n  end\)/);
  assert.match(result.stdout, /SUGGESTED\n  Store:GetReactBinding\(function\(raw\)\n      return raw\.visible\n  end\)/);
  assert.doesNotMatch(result.stdout, /\n          return raw\.visible/);
});

test("why reports suppressed diagnostics with the same detailed explanation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-why-suppressed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local function Component(props)
  -- react-luau-doctor-disable-next-line react-luau/no-prop-mutation
  props.value = 1
  return React.createElement("Frame")
end
return Component
`);

  const why = run(["why", "Component.luau:4", "--cwd", root], root);
  assert.equal(why.status, 0, why.stderr);
  assert.match(why.stdout, /hidden by an inline react-luau-doctor suppression/);
  assert.match(why.stdout, /react-luau\/no-prop-mutation/);
  assert.match(why.stdout, /Why this fired/);
  assert.match(why.stdout, /How to fix/);
});

test("subdirectory scans use the config from the command working directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-subdir-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "src", "interface", "Components", "Tasks");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(root, "react-luau-doctor.config.json"), JSON.stringify({
    rules: { "react-luau/no-prop-mutation": "off" },
  }));
  fs.writeFileSync(path.join(directory, "Countdown.luau"), `local React = require(script.Parent.React)
local function Countdown(props)
  props.value = 2
  return React.createElement("TextLabel", { Text = tostring(props.value) })
end
return Countdown
`);

  const result = run(["src/interface/Components/Tasks", "--json", "--blocking", "none", "--no-cache"], root);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as ScanReport;
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/no-prop-mutation"), false);
});

test("subdirectory scans report paths relative to the command working directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-subdir-paths-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "src", "interface", "Components", "Tasks");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "Countdown.luau"), `local React = require(script.Parent.React)
local function Countdown(props)
  props.value = 2
  return React.createElement("TextLabel", { Text = tostring(props.value) })
end
return Countdown
`);

  const result = run(["src/interface/Components/Tasks", "--json", "--blocking", "none", "--no-cache"], root);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as ScanReport;
  const diagnostic = report.diagnostics.find((entry) => entry.rule === "react-luau/no-prop-mutation");
  assert.ok(diagnostic);
  assert.equal(diagnostic.file, "src/interface/Components/Tasks/Countdown.luau");
  assert.equal(report.root, root);
});

test("rules explain shows a before/after repair instead of a catalog row", () => {
  const result = run(["rules", "explain", "no-prop-mutation", "--no-color"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /What this checks/);
  assert.match(result.stdout, /CURRENT[\s\S]*props.value = normalize\(props.value\)/);
  assert.match(result.stdout, /SUGGESTED[\s\S]*local value = normalize\(props.value\)/);
  assert.match(result.stdout, /Treat props as immutable/);
  assert.doesNotMatch(result.stdout, /\x1b\[/);
});

test("every rule has a structured repair example and valid suggested Luau syntax", async () => {
  const { rules } = await import("../src/rules");
  const { parseLuau } = await import("../src/parser");
  for (const rule of rules) {
    const result = run(["rules", "explain", rule.id, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const explanation = JSON.parse(result.stdout);
    assert.equal(explanation.id, rule.id);
    assert.ok(explanation.example.before.length > 0, rule.id);
    assert.ok(explanation.example.after.length > 0, rule.id);
    assert.notEqual(explanation.example.before, explanation.example.after, rule.id);
    assert.ok(explanation.example.note.length > 0, rule.id);
    assert.equal(explanation.example.kind, "pattern");
    const tree = await parseLuau(explanation.example.after);
    assert.equal(tree.rootNode.hasError, false, `Invalid suggested syntax: ${rule.id}`);
  }
});

test("rules explain preserves configured severity alongside its example", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-explain-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "react-luau-doctor.config.json"), JSON.stringify({ rules: { "react-luau/no-prop-mutation": "off" } }));
  const result = run(["rules", "explain", "no-prop-mutation", "--json"], root);
  assert.equal(result.status, 0, result.stderr);
  const explanation = JSON.parse(result.stdout);
  assert.equal(explanation.severity, "off");
  assert.equal(explanation.defaultSeverity, "error");
  assert.ok(explanation.example.after.includes("local value"));
});
