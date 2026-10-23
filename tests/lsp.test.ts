import type { TextEdit } from "vscode-languageserver";
import { expect, test, onTestFinished } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  MessageType,
  type CodeAction,
  type InitializeParams,
  type InitializeResult,
  type PublishDiagnosticsParams,
  type TextDocumentEdit,
  type LogMessageParams,
} from "vscode-languageserver/node";
import {
  prepareProjectCache,
  projectCachePath,
  saveProjectCache,
} from "../src/cache";
import { analyzeDeepRequest } from "../src/lsp/deep-worker";
import { SourcePositions, toLspDiagnostics } from "../src/lsp/positions";
import { buildProjectModel } from "../src/project-model";
import { scanPath } from "../src/scanner";
import { dedent, lint } from "./helpers/rule-tester";
import { diagnosticCodeActions } from "../src/lsp/code-actions";
import { disableProjectRuleEdit } from "../src/lsp/project-config";
import { WorkspaceSession, defaultEditorSettings } from "../src/lsp/session";
import {
  rescanRequest,
  explainFindingRequest,
  statusNotification,
  type AnalysisStatus,
} from "../src/lsp/editor-protocol";
import { ExplanationTerminal } from "../editors/vscode/src/explanation-terminal";
import { renderWhyDiagnostic } from "../src/why";
import { createInlineSuppressionChecker } from "../src/inline-disables";
import type { Diagnostic } from "../src/types";
import type { DeepRequest, WorkspaceFileRequest } from "../src/lsp/protocol";
import type { ReactFileAnalysisResult } from "../src/file-analysis";

class FakeWorker extends EventEmitter {
  readonly requests: Array<DeepRequest | WorkspaceFileRequest> = [];
  postMessage(request: DeepRequest | WorkspaceFileRequest): void {
    this.requests.push(request);
    this.emit("request", request);
  }
  async terminate(): Promise<number> {
    return 0;
  }
}

function finding(line: number): Diagnostic {
  return {
    id: "finding",
    rule: "react-luau/no-prop-mutation",
    category: "Correctness",
    severity: "error",
    message: "Props are immutable",
    file: "Component.luau",
    location: { line, column: 1, endLine: line, endColumn: 10 },
  };
}

function applyAction(source: string, action: CodeAction): string {
  const edit = (action.edit!.documentChanges![0] as TextDocumentEdit).edits[0]!;
  expect("newText" in edit).toBeTruthy();
  const lines = source.split(/(?<=\n)/);
  const offset = (position: typeof edit.range.start) =>
    lines.slice(0, position.line).join("").length + position.character;
  return (
    source.slice(0, offset(edit.range.start)) +
    (edit as TextEdit).newText +
    source.slice(offset(edit.range.end))
  );
}

test("disabling a project rule preserves the existing config", () => {
  const rule = "react-luau/no-prop-mutation";
  const source = JSON.stringify({
    ignore: ["vendor"],
    rules: { [rule]: "warning" },
  });
  const edit = disableProjectRuleEdit(
    "file:///project/react-luau-doctor.config.json",
    source,
    null,
    rule,
    false,
  );
  expect(JSON.parse(applyAction(source, { title: "Disable", edit }))).toEqual({
      ignore: ["vendor"],
      rules: { [rule]: "off" },
    });
});

test("deep editor overlays agree with a normal Doctor scan", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-lsp-deep-"));

  const fixture = fs.readFileSync(
    path.resolve(import.meta.dir, "fixtures", "bad-component.luau"),
    "utf8",
  );

  const a = path.join(root, "A.luau");
  const b = path.join(root, "B.luau");
  fs.writeFileSync(a, fixture.replaceAll("React", "NotReact"));
  fs.writeFileSync(b, fixture.replaceAll("React", "NotReact"));

  onTestFinished(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(projectCachePath(root, "lsp"), { force: true });
  });

  const buffers = [
    { absolutePath: a, relativePath: "A.luau", source: fixture, version: 4 },
    {
      absolutePath: b,
      relativePath: "B.luau",
      source: fixture.replace("setCount(count + 1)", "setCount(count + 2)"),
      version: 7,
    },
  ];

  const deep = await analyzeDeepRequest({
    id: 1,
    root,
    config: {},
    buffers,
    diagnose: true,
  });

  const normal = await scanPath(root, {
    files: buffers,
    parallel: false,
    cache: false,
  });

  const normalize = (findings: typeof normal.diagnostics) =>
    findings
      .map((item) => ({
        file: item.file,
        rule: item.rule,
        severity: item.severity,
        message: item.message,
        location: item.location,
        highlights: item.highlights,
      }))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );

  expect(normalize(deep.diagnostics.flatMap((item) => item.diagnostics))).toEqual(normalize(normal.diagnostics));
});

test("editor cache writes do not overwrite the CLI cache", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "doctor-cache-namespaces-"),
  );

  const previous = process.env.REACT_LUAU_DOCTOR_CACHE_DIR;
  process.env.REACT_LUAU_DOCTOR_CACHE_DIR = path.join(root, "cache");

  onTestFinished(() => {
    if (previous === undefined) delete process.env.REACT_LUAU_DOCTOR_CACHE_DIR;
    else process.env.REACT_LUAU_DOCTOR_CACHE_DIR = previous;

    fs.rmSync(root, { recursive: true, force: true });
  });

  const filename = path.join(root, "File.luau");
  fs.writeFileSync(filename, "return 1\n");
  const candidates = [{ absolutePath: filename }];
  const project = buildProjectModel(root, candidates);
  saveProjectCache(await prepareProjectCache(root, candidates), project);
  const cliBytes = fs.readFileSync(projectCachePath(root));

  saveProjectCache(
    await prepareProjectCache(root, candidates, true, undefined, "lsp"),
    project,
  );

  expect(fs.readFileSync(projectCachePath(root))).toEqual(cliBytes);
  expect(fs.existsSync(projectCachePath(root, "lsp"))).toBeTruthy();
});

test("deep refreshes recheck changed modules and transitive importers while retaining unrelated files", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "doctor-lsp-incremental-"),
  );
  onTestFinished(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(projectCachePath(root, "lsp"), { force: true });
  });
  const filename = (name: string) => path.join(root, name);
  const effectful =
    "local external = {}\nreturn function() external.value = 1 end\n";
  const pure = "return function() return 1 end\n";
  const component =
    "local React = require(script.Parent.React)\nlocal run = require(script.Parent.Bridge)\nlocal function Component()\nrun()\nreturn React.createElement('Frame')\nend\nreturn Component\n";
  const other =
    "local React = require(script.Parent.React)\nlocal function Other(props)\nprops.value = 1\nreturn React.createElement('Frame')\nend\nreturn Other\n";
  const sources = {
    "Mutator.luau": effectful,
    "Bridge.luau":
      "local run = require(script.Parent.Mutator)\nreturn function() return run() end\n",
    "Component.luau": component,
    "Other.luau": other,
  };
  for (const [name, source] of Object.entries(sources))
    fs.writeFileSync(filename(name), source);
  const buffer = (name: string, source: string, version: number) => ({
    absolutePath: filename(name),
    relativePath: name,
    source,
    version,
  });
  const buffers = [
    buffer("Component.luau", component, 1),
    buffer("Other.luau", other, 1),
  ];
  const initial = await analyzeDeepRequest({
    id: 1,
    root,
    config: {},
    buffers,
    diagnose: true,
  });
  expect(initial.affectedFiles?.length).toBe(4);
  expect(initial.diagnostics[0]!.diagnostics.some(
      (item) => item.rule === "react-luau/no-side-effects-in-render",
    )).toBeTruthy();

  const edited = [...buffers, buffer("Mutator.luau", pure, 2)];
  const refresh = await analyzeDeepRequest({
    id: 2,
    root,
    config: {},
    buffers: edited,
    diagnose: true,
    diagnoseFiles: [filename("Mutator.luau")],
  });
  expect(refresh.affectedFiles?.map((file) => path.basename(file)).sort()).toEqual(["Bridge.luau", "Component.luau", "Mutator.luau"]);
  expect(refresh.diagnostics.map((item) => item.relativePath).sort()).toEqual(["Component.luau", "Mutator.luau"]);
  expect(refresh.diagnostics[0]!.diagnostics.some(
      (item) => item.rule === "react-luau/no-side-effects-in-render",
    )).toBe(false);
  const unchanged = await analyzeDeepRequest({
    id: 3,
    root,
    config: {},
    buffers: edited,
    diagnose: true,
    diagnoseFiles: [],
  });
  expect(unchanged.affectedFiles).toEqual([]);
  expect(unchanged.diagnostics).toEqual([]);
  fs.writeFileSync(filename("Mutator.luau"), pure);
  const saved = await analyzeDeepRequest({
    id: 4,
    root,
    config: {},
    buffers: edited,
    diagnose: true,
    diagnoseFiles: [],
  });
  expect(saved.affectedFiles).toEqual([]);

  const commented = edited.map((item) =>
    item.relativePath === "Other.luau"
      ? {
          ...item,
          version: 2,
          source: `${other}-- Export documentation\n--[=[More documentation]=]\n`,
        }
      : item,
  );
  const commentRefresh = await analyzeDeepRequest({
    id: 40,
    root,
    config: {},
    buffers: commented,
    diagnose: true,
    diagnoseFiles: [],
  });
  expect(commentRefresh.affectedFiles).toEqual([filename("Other.luau")]);
  expect(commentRefresh.diagnostics.map((item) => item.relativePath)).toEqual(["Other.luau"]);

  const forced = await analyzeDeepRequest({
    id: 5,
    root,
    config: {},
    buffers: edited,
    diagnose: true,
    diagnoseFiles: [],
    fullScan: true,
  });
  expect(forced.affectedFiles?.length).toBe(4);
  const changedFeature = edited.map((item) =>
    item.relativePath === "Other.luau"
      ? {
          ...item,
          version: 2,
          source: other.replace("return Other", "return React.memo(Other)"),
        }
      : item,
  );
  const feature = await analyzeDeepRequest({
    id: 6,
    root,
    config: {},
    buffers: changedFeature,
    diagnose: true,
    diagnoseFiles: [],
  });
  expect(feature.affectedFiles?.length).toBe(4);
  const config = { rules: { "react-luau/no-prop-mutation": "off" as const } };
  const configured = await analyzeDeepRequest({
    id: 7,
    root,
    config,
    buffers: changedFeature,
    diagnose: true,
    diagnoseFiles: [],
  });
  expect(configured.affectedFiles?.length).toBe(4);
  expect(configured.diagnostics
      .flatMap((item) => item.diagnostics)
      .some((item) => item.rule === "react-luau/no-prop-mutation")).toBe(false);
});

test("open-file filters are opt-in and react to setting and config changes", async () => {
  const worker = new FakeWorker();
  const publications: Array<{ uri: string; count: number }> = [];
  const live: string[] = [];
  const config = { include: ["src/**"], ignore: ["src/ignored/**"] };
  const settings = { ...defaultEditorSettings, liveDebounceMs: 0 };
  const session = new WorkspaceSession(
    process.cwd(),
    config,
    settings,
    (uri, _version, diagnostics) =>
      publications.push({ uri, count: diagnostics.length }),
    () => {},
    {
      createWorker: () => worker as unknown as Worker,
      analyzeFile: async (input) => {
        live.push(input.relativePath);
        return {
          relativePath: input.relativePath,
          isReactFile: true,
          scanned: true,
          diagnostics: [],
        };
      },
    },
  );
  onTestFinished(() => session.dispose());
  const filename = (relative: string) => path.join(process.cwd(), relative);
  const uri = (relative: string) => pathToFileURL(filename(relative)).href;
  const source = "local props = {}\nprops.value = 1\n";
  const ignored = "src/ignored/Component.luau";
  const outside = "outside/Component.luau";
  const included = "src/Component.luau";
  const respond = () => {
    const request = worker.requests.at(-1) as DeepRequest;
    worker.emit("message", {
      id: request.id,
      project: buildProjectModel(process.cwd(), []),
      diagnostics: request.buffers.map((buffer) => ({
        relativePath: buffer.relativePath,
        version: buffer.version,
        diagnostics: [finding(2)],
      })),
    });
    return request;
  };
  session.open(uri(ignored), filename(ignored), source, 1);
  respond();
  expect(publications.at(-1)?.count).toBe(1);

  session.change(uri(ignored), source, 2);
  session.save(uri(ignored));
  const filtered = { ...settings, respectFileFilters: true };
  session.updateConfig(config, filtered);
  respond();
  const count = worker.requests.length;
  expect(publications.at(-1)?.count).toBe(0);
  session.change(uri(ignored), `${source}\n`, 3);
  session.save(uri(ignored));
  session.open(uri(outside), filename(outside), source, 1);
  expect(worker.requests.length).toBe(count);
  session.open(uri(included), filename(included), source, 1);
  expect(respond().buffers.map((buffer) => buffer.relativePath)).toEqual([included]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(live).toEqual([]);

  session.updateConfig({ include: config.include }, filtered);
  const allowed = respond().buffers;
  expect(allowed.map((buffer) => buffer.relativePath).sort()).toEqual([ignored, included].sort());
  expect(allowed.find((buffer) => buffer.relativePath === ignored)?.source).toBe(`${source}\n`);
  session.updateConfig(config, settings);
  expect(respond()
      .buffers.map((buffer) => buffer.relativePath)
      .sort()).toEqual([ignored, outside, included].sort());
});

test("byte columns map to UTF-16 editor positions", () => {
  const positions = new SourcePositions("a😀漢e\r\nβ😀z");
  expect(positions.position(1, 6)).toEqual({ line: 0, character: 3 });
  expect(positions.position(2, 7)).toEqual({ line: 1, character: 3 });
});

test("each unstable memo prop gets its own editor range", async () => {
  const source = dedent`
    local React = require(script.Parent.React)
    local Child = React.memo(function() return React.createElement("Frame") end)
    local function Component(props)
      return React.createElement(Child, {
        config = {},
        onClick = function() print(props.value) end,
      })
    end
    return Component
  `;
  const report = await lint(source);
  const finding = report.diagnostics.find(item => item.rule === "react-luau/rerender-unstable-memo-props");
  expect(finding).toBeDefined();
  const editor = toLspDiagnostics(source, [finding!]);
  expect(editor.map(({ range }) => range)).toEqual([
    { start: { line: 4, character: 4 }, end: { line: 4, character: 10 } },
    { start: { line: 5, character: 4 }, end: { line: 5, character: 11 } },
  ]);
});

test("explanation terminals wait for open, reuse the panel, and discard obsolete requests", async () => {
  const writes: string[] = [];
  const terminal = new ExplanationTerminal((text) => writes.push(text));
  let finishOld!: (text: string) => void;
  terminal.explain((columns) => {
    expect(columns).toBe(80);
    return new Promise((resolve) => {
      finishOld = resolve;
    });
  });
  expect(writes.length).toBe(0);
  terminal.open({ columns: 80 });
  terminal.explain(async () => "New finding\nWhy this fired\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  finishOld("Old finding");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(writes.length).toBe(1);
  expect(writes[0]!).toMatch(/New finding\r\nWhy this fired\r\n$/);
  expect(writes[0]!.startsWith("\x1b[0m\x1b[2J\x1b[3J\x1b[H")).toBeTruthy();
  terminal.explain(async () => null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(writes.at(-1)!).toMatch(/finding has changed/);
  terminal.explain(async () => "Closed finding");
  terminal.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(writes.length).toBe(2);
});

test("suppression actions use the finding's origin and preserve indentation, CRLF, and existing directives", async () => {
  for (const preceding of [
    "",
    "\t-- react-luau-doctor-disable-next-line no-random-key -- intentional\r\n",
  ]) {
    const source = `local props = {}\r\n${preceding}\tprops.text = 'value'\r\n`;
    const line = preceding ? 3 : 2;
    const diagnostic = finding(line);
    diagnostic.editorRanges = [
      { location: { line: 1, column: 1, endLine: 1, endColumn: 6 } },
    ];
    const diagnostics = toLspDiagnostics(source, [diagnostic]);
    const actions = await diagnosticCodeActions(
      "file:///Component.luau",
      7,
      source,
      diagnostics,
      diagnostics[0]!.range,
    );
    const suppression = actions.find((action) => action.edit)!;
    expect(suppression).toBeTruthy();
    expect((suppression.edit!.documentChanges![0] as TextDocumentEdit).textDocument
        .version).toBe(7);
    const updated = applyAction(source, suppression);
    expect(createInlineSuppressionChecker(updated)(
        diagnostic.rule,
        preceding ? line : line + 1,
      )).toBe(true);
    expect(updated).toMatch(/\t-- react-luau-doctor-disable-next-line/);
    expect(updated.replaceAll("\r\n", "").includes("\n")).toBe(false);
    if (preceding) {
      expect(updated).toMatch(/no-random-key, react-luau\/no-prop-mutation -- intentional/);
      expect(createInlineSuppressionChecker(updated)(
          "react-luau/no-random-key",
          line,
        )).toBe(true);
    }
  }
});

test("quick fixes avoid disabled suppressions, multiline tokens, incomplete source, and unrelated ranges", async () => {
  for (const [source, line, respect] of [
    ["local value = 1\n", 1, false],
    ["local value = [[\ncontents\n]]\n", 2, true],
    ["--[[\ncontents\n]]\nreturn 1\n", 2, true],
    ["local value = (\n", 1, true],
  ] as const) {
    const diagnostics = toLspDiagnostics(source, [finding(line)]);
    const actions = await diagnosticCodeActions(
      "file:///Component.luau",
      1,
      source,
      diagnostics,
      diagnostics[0]!.range,
      respect,
    );
    expect(actions.some((action) => action.edit)).toBe(false);
    expect(actions[0]?.command?.command).toBe("reactLuauDoctor.explainRule");
  }
  const diagnostics = toLspDiagnostics("local value = 1\nreturn value\n", [
    finding(1),
  ]);
  expect(await diagnosticCodeActions(
      "file:///Component.luau",
      1,
      "local value = 1\nreturn value\n",
      diagnostics,
      { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
    )).toEqual([]);
});

test("sessions reject stale actions and recover from worker failures without an old exit clearing the replacement", async () => {
  const workers: FakeWorker[] = [];
  const statuses: AnalysisStatus[] = [];
  const project = buildProjectModel(process.cwd(), []);
  const session = new WorkspaceSession(
    process.cwd(),
    {},
    defaultEditorSettings,
    () => {},
    () => {},
    {
      onStatus: (status) => statuses.push(status),
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    },
  );
  onTestFinished(() => session.dispose());
  const uri = pathToFileURL(path.join(process.cwd(), "Component.luau")).href;
  const source = "local props = {}\nprops.text = 'value'\n";
  session.open(uri, path.join(process.cwd(), "Component.luau"), source, 1);
  const worker = workers[0]!;
  worker.emit("message", {
    id: worker.requests[0]!.id,
    project,
    diagnostics: [
      { relativePath: "Component.luau", version: 1, diagnostics: [finding(2)] },
    ],
  });
  const range = toLspDiagnostics(source, [finding(2)])[0]!.range;
  const actions = await session.codeActions(uri, range);
  expect(actions.some((action) => action.edit)).toBeTruthy();
  const params = actions.find((action) => action.command)?.command
    ?.arguments?.[0];
  expect(params).toEqual({ uri, version: 1, findingId: "finding" });
  expect(session.explainFinding(params)).toBe(renderWhyDiagnostic(source, finding(2), true));
  expect(session.explainFinding({ ...params, findingId: "missing" })).toBe(null);
  session.change(uri, `${source}\n`, 2);
  expect(await session.codeActions(uri, range)).toEqual([]);
  expect(session.explainFinding(params)).toBe(null);
  worker.emit("error", new Error("worker failed"));
  expect(statuses.at(-1)?.state).toBe("error");
  session.updateConfig({}, defaultEditorSettings);
  const replacement = workers[1]!;
  worker.emit("exit", 1);
  expect(statuses.at(-1)?.state).toBe("analyzing");
  replacement.emit("message", {
    id: replacement.requests[0]!.id,
    project,
    diagnostics: [
      { relativePath: "Component.luau", version: 2, diagnostics: [] },
    ],
  });
  expect(statuses.at(-1)?.state).toBe("idle");
  session.updateConfig({}, { ...defaultEditorSettings, enable: false });
  expect(statuses.at(-1)?.state).toBe("disabled");
});

test("configuration errors stay visible and pause diagnostics even when live work finishes later", async () => {
  const worker = new FakeWorker();
  const statuses: AnalysisStatus[] = [];
  const publications: number[] = [];
  let startLive!: () => void;
  let finishLive!: (result: ReactFileAnalysisResult) => void;
  const started = new Promise<void>((resolve) => {
    startLive = resolve;
  });
  const result = new Promise<ReactFileAnalysisResult>((resolve) => {
    finishLive = resolve;
  });
  const session = new WorkspaceSession(
    process.cwd(),
    {},
    { ...defaultEditorSettings, liveDebounceMs: 0 },
    (_uri, _version, diagnostics) => publications.push(diagnostics.length),
    () => {},
    {
      createWorker: () => worker as unknown as Worker,
      onStatus: (status) => statuses.push(status),
      analyzeFile: async () => {
        startLive();
        return result;
      },
    },
  );
  onTestFinished(() => session.dispose());
  const filename = path.join(process.cwd(), "Component.luau");
  const uri = pathToFileURL(filename).href;
  const source = "local props = {}\nprops.text = 'value'\n";
  session.open(uri, filename, source, 1);
  worker.emit("message", {
    id: worker.requests[0]!.id,
    project: buildProjectModel(process.cwd(), []),
    diagnostics: [],
  });
  session.change(uri, `${source}\n`, 2);
  await started;
  session.configurationError("Invalid configuration");
  const count = publications.length;
  finishLive({
    relativePath: "Component.luau",
    isReactFile: true,
    scanned: true,
    diagnostics: [finding(2)],
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(publications.length).toBe(count);
  expect(statuses.at(-1)).toEqual({
    state: "error",
    message: "Invalid configuration",
  });
});

const bundledServer =
  process.env.REACT_LUAU_DOCTOR_LSP_SERVER ??
  path.resolve(import.meta.dir, "../editors/vscode/server/server.js");

test("background scanning keeps one file in flight and yields to open-file analysis", () => {
  const worker = new FakeWorker();
  const statuses: AnalysisStatus[] = [];
  const session = new WorkspaceSession(
    process.cwd(),
    {},
    { ...defaultEditorSettings, workspaceScan: true },
    () => {},
    () => {},
    {
      createWorker: () => worker as unknown as Worker,
      onStatus: (status) => statuses.push(status),
    },
  );
  onTestFinished(() => session.dispose());
  const project = buildProjectModel(process.cwd(), []);
  const files = ["A.luau", "B.luau"].map((name) =>
    path.join(process.cwd(), name),
  );
  session.start();
  worker.emit("message", {
    id: worker.requests[0]!.id,
    project,
    diagnostics: [],
    files,
  });
  const background = worker.requests[1] as WorkspaceFileRequest;
  expect(background.kind).toBe("workspace-file");
  expect(worker.requests.length).toBe(2);

  const filename = path.join(process.cwd(), "Component.luau");
  session.open(pathToFileURL(filename).href, filename, "return 1\n", 1);
  const foreground = worker.requests[2] as DeepRequest;
  expect(foreground.diagnose).toBe(true);
  expect(foreground.buffers.length).toBe(1);
  expect(statuses.at(-1)?.state).toBe("analyzing");
  worker.emit("message", {
    kind: "workspace-file",
    id: background.id,
    absolutePath: background.absolutePath,
    diagnostics: [],
  });
  expect(worker.requests.length).toBe(3);
  worker.emit("message", {
    id: foreground.id,
    project,
    files,
    affectedFiles: [],
    diagnostics: [
      { relativePath: "Component.luau", version: 1, diagnostics: [] },
    ],
  });
  expect(worker.requests.length).toBe(3);
  expect(statuses.at(-1)?.state).toBe("background");
});

test("editing a checked file keeps unaffected background results and ignores duplicate save notifications", async () => {
  const worker = new FakeWorker();
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const publications: Array<{
    uri: string;
    diagnostics: import("vscode-languageserver/node").Diagnostic[];
  }> = [];
  const session = new WorkspaceSession(
    process.cwd(),
    {},
    { ...defaultEditorSettings, workspaceScan: true },
    (uri, _version, diagnostics) => publications.push({ uri, diagnostics }),
    (message) => {
      if (message.startsWith("Background analysis finished in")) finish();
    },
    {
      createWorker: () => worker as unknown as Worker,
    },
  );
  onTestFinished(() => session.dispose());
  const project = buildProjectModel(process.cwd(), []);
  const filename = path.join(process.cwd(), "Component.luau");
  const uri = pathToFileURL(filename).href;
  const other = path.join(process.cwd(), "Other.luau");
  const otherUri = pathToFileURL(other).href;
  worker.on("request", (request: DeepRequest | WorkspaceFileRequest) => {
    if (!("kind" in request)) return;
    setImmediate(() =>
      worker.emit("message", {
        kind: request.kind,
        id: request.id,
        absolutePath: request.absolutePath,
        source: "props.text = 'value'\n",
        diagnostics: [finding(1)],
      }),
    );
  });
  session.start();
  worker.emit("message", {
    id: worker.requests[0]!.id,
    project,
    diagnostics: [],
    files: [other],
  });
  await finished;
  const retained = publications.find((item) => item.uri === otherUri)!;
  expect(retained.diagnostics.length).toBeTruthy();

  session.open(uri, filename, "local props = {}\nprops.text = 'value'\n", 1);
  const opened = worker.requests.at(-1) as DeepRequest;
  expect(opened.diagnoseFiles).toEqual([filename]);
  expect(opened.fullScan).toBe(false);
  worker.emit("message", {
    id: opened.id,
    project,
    files: [filename, other],
    affectedFiles: [],
    diagnostics: [
      { relativePath: "Component.luau", version: 1, diagnostics: [finding(2)] },
    ],
  });
  session.change(uri, "local props = {}\nprops.text = 'new'\n", 2);
  session.save(uri);
  const saved = worker.requests.at(-1) as DeepRequest;
  expect(saved.fullScan).toBe(false);
  expect(saved.diagnoseFiles).toEqual([filename]);
  const count = worker.requests.length;
  session.watchedFilesChanged([{ uri, type: 2 }]);
  worker.emit("message", {
    id: saved.id,
    project,
    files: [filename, other],
    affectedFiles: [filename],
    diagnostics: [
      { relativePath: "Component.luau", version: 2, diagnostics: [finding(2)] },
    ],
  });
  expect(worker.requests.length).toBe(count);
  expect(publications.filter((item) => item.uri === otherUri)).toEqual([retained]);
});

test("incremental refreshes invalidate cached importers and preserve discarded invalidations", () => {
  const worker = new FakeWorker();
  const session = new WorkspaceSession(
    process.cwd(),
    {},
    { ...defaultEditorSettings, workspaceScan: true },
    () => {},
    () => {},
    { createWorker: () => worker as unknown as Worker },
  );
  onTestFinished(() => session.dispose());
  const project = buildProjectModel(process.cwd(), []);
  const component = path.join(process.cwd(), "Component.luau");
  const dependency = path.join(process.cwd(), "Dependency.luau");
  const other = path.join(process.cwd(), "Other.luau");
  const componentUri = pathToFileURL(component).href;
  const files = [component, dependency, other];
  session.open(componentUri, component, "return 1\n", 1);
  const initial = worker.requests.at(-1) as DeepRequest;
  worker.emit("message", {
    id: initial.id,
    project,
    files,
    affectedFiles: files,
    diagnostics: [
      { relativePath: "Component.luau", version: 1, diagnostics: [] },
    ],
  });
  session.close(componentUri);
  session.open(pathToFileURL(dependency).href, dependency, "return 2\n", 1);
  const changed = worker.requests.at(-1) as DeepRequest;
  worker.emit("message", {
    id: changed.id,
    project,
    files,
    affectedFiles: [dependency, component],
    diagnostics: [
      { relativePath: "Dependency.luau", version: 1, diagnostics: [] },
    ],
  });
  const count = worker.requests.length;
  session.open(componentUri, component, "return 1\n", 2);
  expect(worker.requests.length).toBe(count + 1);
  const reopened = worker.requests.at(-1) as DeepRequest;
  expect(reopened.diagnoseFiles).toEqual([component]);
  worker.emit("message", {
    id: reopened.id,
    project,
    files,
    affectedFiles: [],
    diagnostics: [
      { relativePath: "Component.luau", version: 2, diagnostics: [] },
    ],
  });

  session.watchedFilesChanged([{ uri: pathToFileURL(other).href, type: 2 }]);
  const obsolete = worker.requests.at(-1) as DeepRequest;
  expect(obsolete.diagnoseFiles).toEqual([]);
  session.watchedFilesChanged([{ uri: pathToFileURL(other).href, type: 2 }]);
  worker.emit("message", {
    id: obsolete.id,
    project,
    files,
    affectedFiles: [component, other],
    diagnostics: [],
  });
  const replacement = worker.requests.at(-1) as DeepRequest;
  expect(replacement.id).not.toBe(obsolete.id);
  expect(replacement.diagnoseFiles).toEqual([component]);
  worker.emit("message", {
    id: replacement.id,
    project,
    files,
    affectedFiles: [],
    diagnostics: [
      { relativePath: "Component.luau", version: 2, diagnostics: [] },
    ],
  });
});

function startProtocolServer() {
  const child = spawn(Bun.which("node")!, [bundledServer, "--stdio"], {
    stdio: "pipe",
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key.toLowerCase() !== "path",
        ),
      ),
      PATH: "",
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
  const notifications = new EventEmitter();
  const diagnostics: PublishDiagnosticsParams[] = [];
  const statuses: AnalysisStatus[] = [];
  const output: LogMessageParams[] = [];
  connection.onNotification("window/logMessage", (value: LogMessageParams) => {
    output.push(value);
    notifications.emit("update");
  });
  connection.onNotification(
    "textDocument/publishDiagnostics",
    (value: PublishDiagnosticsParams) => {
      diagnostics.push(value);
      notifications.emit("update");
    },
  );
  connection.onNotification(statusNotification, (value: AnalysisStatus) => {
    statuses.push(value);
    notifications.emit("update");
  });
  connection.listen();
  onTestFinished(() => {
    connection.dispose();
    child.kill();
  });

  const waitFor = async (condition: () => boolean) => {
    if (condition()) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`LSP response timed out: ${stderr}`));
      }, 10000);
      const check = () => {
        if (condition()) {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        notifications.off("update", check);
      };
      notifications.on("update", check);
    });
  };
  const initialize = (params: InitializeParams) =>
    Promise.race([
      connection.sendRequest<InitializeResult>("initialize", params),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Initialization timed out: ${stderr}`)),
          10000,
        );
        timer.unref();
      }),
    ]);
  return { connection, diagnostics, statuses, output, waitFor, initialize };
}

test.skipIf(!fs.existsSync(bundledServer) || !Bun.which("node"))("Node server isolates workspace folders and moves open buffers when folders change", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-lsp-folders-"));
    const a = path.join(root, "project");
    const b = path.join(root, "project-extra");
    const nested = path.join(a, "nested");
    const source =
      "local React = require(script.Parent.React)\nlocal function Component(props)\nprops.text = 'saved'\nreturn React.createElement('TextLabel', { Text = props.text })\nend\nreturn Component\n";
    const configPath = (folder: string) =>
      path.join(folder, "react-luau-doctor.config.json");
    const folder = (directory: string) => ({
      uri: pathToFileURL(directory).href,
      name: path.basename(directory),
    });
    const fileUri = (directory: string) =>
      pathToFileURL(path.join(directory, "Component.luau")).href;
    for (const directory of [a, b, nested]) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "Component.luau"), source);
      fs.writeFileSync(
        configPath(directory),
        JSON.stringify({
          rules: {
            "react-luau/no-prop-mutation": directory === a ? "off" : "warning",
          },
        }),
      );
    }
    const { connection, diagnostics, statuses, output, waitFor, initialize } =
      startProtocolServer();
    onTestFinished(() => {
      fs.rmSync(root, { recursive: true, force: true });
      for (const directory of [a, b, nested])
        fs.rmSync(projectCachePath(directory, "lsp"), { force: true });
    });
    const initialized = await initialize({
      processId: null,
      rootUri: null,
      capabilities: { workspace: { workspaceFolders: true } },
      workspaceFolders: [folder(a), folder(b)],
    });
    expect(initialized.capabilities.workspace?.workspaceFolders).toEqual({
      supported: true,
      changeNotifications: true,
    });
    await connection.sendNotification("initialized", {});
    const latest = (directory: string) =>
      diagnostics.findLast((item) => item.uri === fileUri(directory));
    const mutation = (directory: string) =>
      latest(directory)?.diagnostics.find(
        (item) => item.code === "react-luau/no-prop-mutation",
      );
    const open = (directory: string) =>
      connection.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: fileUri(directory),
          languageId: "luau",
          version: 1,
          text: source,
        },
      });
    await open(a);
    await open(b);
    await open(nested);
    await waitFor(
      () =>
        latest(a)?.version === 1 &&
        latest(nested)?.version === 1 &&
        mutation(b)?.severity === 2,
    );
    expect(mutation(a)).toBe(undefined);
    expect(mutation(nested)).toBe(undefined);
    await waitFor(() =>
      [a, b].every(
        (directory) =>
          statuses.findLast(
            (status) => status.rootUri === folder(directory).uri,
          )?.state === "idle",
      ),
    );

    const bPublications = diagnostics.filter(
      (item) => item.uri === fileUri(b),
    ).length;
    fs.writeFileSync(
      configPath(a),
      JSON.stringify({ rules: { "react-luau/no-prop-mutation": "error" } }),
    );
    await connection.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: pathToFileURL(configPath(a)).href, type: 2 }],
    });
    await waitFor(
      () => mutation(a)?.severity === 1 && mutation(nested)?.severity === 1,
    );
    expect(diagnostics.filter((item) => item.uri === fileUri(b)).length).toBe(bPublications);

    const unsaved = source.replace("'saved'", "'unsaved'");
    await connection.sendNotification("textDocument/didChange", {
      textDocument: { uri: fileUri(nested), version: 2 },
      contentChanges: [{ text: unsaved }],
    });
    await connection.sendNotification("workspace/didChangeWorkspaceFolders", {
      event: { added: [folder(nested)], removed: [] },
    });
    await waitFor(
      () => latest(nested)?.version === 2 && mutation(nested)?.severity === 2,
    );
    const actions = await connection.sendRequest<CodeAction[]>(
      "textDocument/codeAction",
      {
        textDocument: { uri: fileUri(nested) },
        range: mutation(nested)!.range,
        context: { diagnostics: [mutation(nested)!] },
      },
    );
    const explain = actions.find((action) => action.command)?.command
      ?.arguments?.[0];
    expect(await connection.sendRequest<string>(explainFindingRequest, explain)).toMatch(/unsaved/);
    await waitFor(
      () =>
        statuses.findLast((status) => status.rootUri === folder(nested).uri)
          ?.state === "idle",
    );
    await connection.sendNotification("workspace/didChangeWorkspaceFolders", {
      event: { added: [], removed: [folder(nested)] },
    });
    await waitFor(
      () => latest(nested)?.version === 2 && mutation(nested)?.severity === 1,
    );

    const logs = output.length;
    const statusCount = statuses.length;
    expect(await connection.sendRequest<boolean>(rescanRequest, { uri: fileUri(b) })).toBe(true);
    await waitFor(() =>
      statuses
        .slice(statusCount)
        .some(
          (status) =>
            status.rootUri === folder(b).uri && status.state === "idle",
        ),
    );
    expect(output
        .slice(logs)
        .some((item) =>
          item.message.startsWith(`[${a}] Starting project analysis`),
        )).toBe(false);
    await connection.sendNotification("workspace/didChangeWorkspaceFolders", {
      event: { added: [], removed: [folder(b)] },
    });
    await waitFor(() => latest(b)?.diagnostics.length === 0);
    await connection.sendNotification("textDocument/didChange", {
      textDocument: { uri: fileUri(b), version: 2 },
      contentChanges: [{ text: unsaved }],
    });
    await connection.sendNotification("workspace/didChangeWorkspaceFolders", {
      event: { added: [folder(b)], removed: [] },
    });
    await waitFor(
      () => latest(b)?.version === 2 && mutation(b)?.severity === 2,
    );
    await connection.sendRequest("shutdown");
    await connection.sendNotification("exit");
  },
);

test.skipIf(!fs.existsSync(bundledServer) || !Bun.which("node"))("Node server recovers from invalid config and supports diagnostics, explanations, suppressions, and rescanning", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-lsp-protocol-"));
    const filename = path.join(root, "Component.luau");
    const uri = pathToFileURL(filename).href;
    const configPath = path.join(root, "react-luau-doctor.config.json");
    const source =
      "local React = require(script.Parent.React)\nlocal function Component(props)\n\tprops.text = 'changed'\n\treturn React.createElement('TextLabel', { Text = props.text })\nend\nreturn Component\n";
    fs.writeFileSync(filename, source.replace("'changed'", "'saved'"));
    fs.writeFileSync(configPath, "{");
    const { connection, diagnostics, statuses, output, waitFor, initialize } =
      startProtocolServer();
    onTestFinished(() => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(projectCachePath(root, "lsp"), { force: true });
    });
    const initialized = await initialize({
      processId: null,
      rootUri: pathToFileURL(root).href,
      capabilities: {},
    });
    expect(initialized.capabilities.hoverProvider).toBe(true);
    expect(initialized.capabilities.codeActionProvider).toBeTruthy();

    await connection.sendNotification("initialized", {});
    await waitFor(() => statuses.some((status) => status.state === "error"));

    expect(output.some(
        (item) =>
          item.type === MessageType.Error &&
          item.message.startsWith("Configuration failed:"),
      )).toBeTruthy();

    await connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "luau", version: 1, text: source },
    });
    fs.writeFileSync(configPath, "{}");
    await connection.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: pathToFileURL(configPath).href, type: 2 }],
    });
    await waitFor(() =>
      diagnostics.some(
        (item) =>
          item.version === 1 &&
          item.diagnostics.some(
            (diagnostic) => diagnostic.code === "react-luau/no-prop-mutation",
          ),
      ),
    );

    const diagnostic = diagnostics
      .at(-1)!
      .diagnostics.find((item) => item.code === "react-luau/no-prop-mutation")!;
    const actions = await connection.sendRequest<CodeAction[]>(
      "textDocument/codeAction",
      {
        textDocument: { uri },
        range: diagnostic.range,
        context: { diagnostics: [diagnostic], only: ["quickfix"] },
      },
    );
    expect(actions.some(
        (action) => action.command?.command === "reactLuauDoctor.explainRule",
      )).toBeTruthy();
    expect(actions.find((action) => action.data?.kind === "disableProjectRule")
        ?.edit).toBeTruthy();
    const explainParams = actions.find((action) => action.command)?.command
      ?.arguments?.[0];
    const explanation = await connection.sendRequest<string>(
      explainFindingRequest,
      { ...explainParams, columns: 80 },
    );
    expect(explanation).toMatch(/react-luau\/no-prop-mutation/);

    expect(explanation).toMatch(/changed/);
    expect(explanation).not.toMatch(/saved/);
    const updated = applyAction(
      source,
      actions.find((action) => action.edit)!,
    );
    await connection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: updated }],
    });
    expect(await connection.sendRequest<string | null>(explainFindingRequest, explainParams)).toBe(null);
    expect(await connection.sendRequest<boolean>(rescanRequest)).toBe(true);

    await waitFor(() =>
      diagnostics.some(
        (item) =>
          item.version === 2 &&
          item.diagnostics.every(
            (diagnostic) => diagnostic.code !== "react-luau/no-prop-mutation",
          ),
      ),
    );
    expect(statuses.some((status) => status.state === "analyzing")).toBeTruthy();
    await connection.sendNotification("workspace/didChangeConfiguration", {
      settings: { reactLuauDoctor: { enable: false } },
    });
    await waitFor(() => statuses.at(-1)?.state === "disabled");

    await connection.sendRequest("shutdown");

    await connection.sendNotification("exit");
  },
);
