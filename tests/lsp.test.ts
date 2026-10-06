import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
import { diagnosticHover } from "../src/lsp/hover";
import { SourcePositions, toLspDiagnostics } from "../src/lsp/positions";
import { buildProjectModel } from "../src/project-model";
import { scanPath } from "../src/scanner";
import { diagnosticCodeActions } from "../src/lsp/code-actions";
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
  assert.ok("newText" in edit);
  const lines = source.split(/(?<=\n)/);
  const offset = (position: typeof edit.range.start) =>
    lines.slice(0, position.line).join("").length + position.character;
  return (
    source.slice(0, offset(edit.range.start)) +
    edit.newText +
    source.slice(offset(edit.range.end))
  );
}

test("deep editor overlays agree with a normal Doctor scan", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-lsp-deep-"));

  const fixture = fs.readFileSync(
    path.resolve(import.meta.dir, "fixtures", "bad-component.luau"),
    "utf8",
  );

  const a = path.join(root, "A.luau");
  const b = path.join(root, "B.luau");
  fs.writeFileSync(a, fixture.replaceAll("React", "NotReact"));
  fs.writeFileSync(b, fixture.replaceAll("React", "NotReact"));

  t.after(() => {
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

  assert.deepEqual(
    normalize(deep.diagnostics.flatMap((item) => item.diagnostics)),
    normalize(normal.diagnostics),
  );
});

test("editor cache writes do not overwrite the CLI cache", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "doctor-cache-namespaces-"),
  );

  const previous = process.env.REACT_LUAU_DOCTOR_CACHE_DIR;
  process.env.REACT_LUAU_DOCTOR_CACHE_DIR = path.join(root, "cache");

  t.after(() => {
    if (previous === undefined) delete process.env.REACT_LUAU_DOCTOR_CACHE_DIR;
    else process.env.REACT_LUAU_DOCTOR_CACHE_DIR = previous;

    fs.rmSync(root, { recursive: true, force: true });
  });

  const filename = path.join(root, "File.luau");
  fs.writeFileSync(filename, "return 1\n");
  const candidates = [{ absolutePath: filename }];
  const project = buildProjectModel(root, candidates);
  saveProjectCache(prepareProjectCache(root, candidates), project);
  const cliBytes = fs.readFileSync(projectCachePath(root));

  saveProjectCache(
    prepareProjectCache(root, candidates, true, undefined, "lsp"),
    project,
  );

  assert.deepEqual(fs.readFileSync(projectCachePath(root)), cliBytes);
  assert.ok(fs.existsSync(projectCachePath(root, "lsp")));
});

test("deep refreshes recheck changed modules and transitive importers while retaining unrelated files", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "doctor-lsp-incremental-"),
  );
  t.after(() => {
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
  assert.equal(initial.affectedFiles?.length, 4);
  assert.ok(
    initial.diagnostics[0]!.diagnostics.some(
      (item) => item.rule === "react-luau/no-side-effects-in-render",
    ),
  );

  const edited = [...buffers, buffer("Mutator.luau", pure, 2)];
  const refresh = await analyzeDeepRequest({
    id: 2,
    root,
    config: {},
    buffers: edited,
    diagnose: true,
    diagnoseFiles: [filename("Mutator.luau")],
  });
  assert.deepEqual(
    refresh.affectedFiles?.map((file) => path.basename(file)).sort(),
    ["Bridge.luau", "Component.luau", "Mutator.luau"],
  );
  assert.deepEqual(
    refresh.diagnostics.map((item) => item.relativePath).sort(),
    ["Component.luau", "Mutator.luau"],
  );
  assert.equal(
    refresh.diagnostics[0]!.diagnostics.some(
      (item) => item.rule === "react-luau/no-side-effects-in-render",
    ),
    false,
  );
  const unchanged = await analyzeDeepRequest({
    id: 3,
    root,
    config: {},
    buffers: edited,
    diagnose: true,
    diagnoseFiles: [],
  });
  assert.deepEqual(unchanged.affectedFiles, []);
  assert.deepEqual(unchanged.diagnostics, []);
  fs.writeFileSync(filename("Mutator.luau"), pure);
  const saved = await analyzeDeepRequest({
    id: 4,
    root,
    config: {},
    buffers: edited,
    diagnose: true,
    diagnoseFiles: [],
  });
  assert.deepEqual(saved.affectedFiles, []);

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
  assert.deepEqual(commentRefresh.affectedFiles, [filename("Other.luau")]);
  assert.deepEqual(
    commentRefresh.diagnostics.map((item) => item.relativePath),
    ["Other.luau"],
  );

  const forced = await analyzeDeepRequest({
    id: 5,
    root,
    config: {},
    buffers: edited,
    diagnose: true,
    diagnoseFiles: [],
    fullScan: true,
  });
  assert.equal(forced.affectedFiles?.length, 4);
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
  assert.equal(feature.affectedFiles?.length, 4);
  const config = { rules: { "react-luau/no-prop-mutation": "off" as const } };
  const configured = await analyzeDeepRequest({
    id: 7,
    root,
    config,
    buffers: changedFeature,
    diagnose: true,
    diagnoseFiles: [],
  });
  assert.equal(configured.affectedFiles?.length, 4);
  assert.equal(
    configured.diagnostics
      .flatMap((item) => item.diagnostics)
      .some((item) => item.rule === "react-luau/no-prop-mutation"),
    false,
  );
});

test("byte columns map to UTF-16 editor positions", () => {
  const positions = new SourcePositions("a😀漢e\r\nβ😀z");
  assert.deepEqual(positions.position(1, 6), { line: 0, character: 3 });
  assert.deepEqual(positions.position(2, 7), { line: 1, character: 3 });
});

test("each unstable memo prop gets its own editor range", async () => {
  const filename = path.resolve(
    import.meta.dir,
    "fixtures",
    "performance-issues.luau",
  );

  const report = await scanPath(filename);

  const finding = report.diagnostics.find(
    (item) => item.rule === "react-luau/rerender-unstable-memo-props",
  );

  assert.ok(finding);

  const editor = toLspDiagnostics(fs.readFileSync(filename, "utf8"), [finding]);

  assert.deepEqual(
    editor.map(({ range }) => range.start.line),
    [36, 37],
  );

  const hover = diagnosticHover(editor, editor[0]!.range.start);

  assert.ok(
    hover && typeof hover.contents === "object" && "value" in hover.contents,
  );

  assert.match(hover.contents.value, /React-Luau Doctor.*How to fix.*Example/s);
});

test("explanation terminals wait for open, reuse the panel, and discard obsolete requests", async () => {
  const writes: string[] = [];
  const terminal = new ExplanationTerminal((text) => writes.push(text));
  let finishOld!: (text: string) => void;
  terminal.explain((columns) => {
    assert.equal(columns, 80);
    return new Promise((resolve) => {
      finishOld = resolve;
    });
  });
  assert.equal(writes.length, 0);
  terminal.open({ columns: 80 });
  terminal.explain(async () => "New finding\nWhy this fired\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  finishOld("Old finding");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 1);
  assert.match(writes[0]!, /New finding\r\nWhy this fired\r\n$/);
  assert.ok(writes[0]!.startsWith("\x1b[0m\x1b[2J\x1b[3J\x1b[H"));
  terminal.explain(async () => null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(writes.at(-1)!, /finding has changed/);
  terminal.explain(async () => "Closed finding");
  terminal.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 2);
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
    assert.ok(suppression);
    assert.equal(
      (suppression.edit!.documentChanges![0] as TextDocumentEdit).textDocument
        .version,
      7,
    );
    const updated = applyAction(source, suppression);
    assert.equal(
      createInlineSuppressionChecker(updated)(
        diagnostic.rule,
        preceding ? line : line + 1,
      ),
      true,
    );
    assert.match(updated, /\t-- react-luau-doctor-disable-next-line/);
    assert.equal(updated.replaceAll("\r\n", "").includes("\n"), false);
    if (preceding) {
      assert.match(
        updated,
        /no-random-key, react-luau\/no-prop-mutation -- intentional/,
      );
      assert.equal(
        createInlineSuppressionChecker(updated)(
          "react-luau/no-random-key",
          line,
        ),
        true,
      );
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
    assert.equal(
      actions.some((action) => action.edit),
      false,
    );
    assert.equal(actions[0]?.command?.command, "reactLuauDoctor.explainRule");
  }
  const diagnostics = toLspDiagnostics("local value = 1\nreturn value\n", [
    finding(1),
  ]);
  assert.deepEqual(
    await diagnosticCodeActions(
      "file:///Component.luau",
      1,
      "local value = 1\nreturn value\n",
      diagnostics,
      { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
    ),
    [],
  );
});

test("sessions reject stale actions and recover from worker failures without an old exit clearing the replacement", async (t) => {
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
  t.after(() => session.dispose());
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
  assert.ok(actions.some((action) => action.edit));
  const params = actions.find((action) => action.command)?.command
    ?.arguments?.[0];
  assert.deepEqual(params, { uri, version: 1, findingId: "finding" });
  assert.equal(
    session.explainFinding(params),
    renderWhyDiagnostic(source, finding(2), true),
  );
  assert.equal(
    session.explainFinding({ ...params, findingId: "missing" }),
    null,
  );
  session.change(uri, `${source}\n`, 2);
  assert.deepEqual(await session.codeActions(uri, range), []);
  assert.equal(session.explainFinding(params), null);
  worker.emit("error", new Error("worker failed"));
  assert.equal(statuses.at(-1)?.state, "error");
  session.updateConfig({}, defaultEditorSettings);
  const replacement = workers[1]!;
  worker.emit("exit", 1);
  assert.equal(statuses.at(-1)?.state, "analyzing");
  replacement.emit("message", {
    id: replacement.requests[0]!.id,
    project,
    diagnostics: [
      { relativePath: "Component.luau", version: 2, diagnostics: [] },
    ],
  });
  assert.equal(statuses.at(-1)?.state, "idle");
  session.updateConfig({}, { ...defaultEditorSettings, enable: false });
  assert.equal(statuses.at(-1)?.state, "disabled");
});

test("configuration errors stay visible and pause diagnostics even when live work finishes later", async (t) => {
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
  t.after(() => session.dispose());
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
  assert.equal(publications.length, count);
  assert.deepEqual(statuses.at(-1), {
    state: "error",
    message: "Invalid configuration",
  });
});

const bundledServer =
  process.env.REACT_LUAU_DOCTOR_LSP_SERVER ??
  path.resolve(import.meta.dir, "../editors/vscode/server/server.js");

test("background output summarizes the batch and keeps per-file details at debug level", async (t) => {
  const worker = new FakeWorker();
  const output: Array<{ message: string; level: string }> = [];
  const statuses: AnalysisStatus[] = [];
  const project = buildProjectModel(process.cwd(), []);
  let complete!: () => void;
  const finished = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const session = new WorkspaceSession(
    process.cwd(),
    {},
    { ...defaultEditorSettings, workspaceScan: true },
    () => {},
    (message, level) => {
      output.push({ message, level });
      if (message.startsWith("Background analysis finished in")) complete();
    },
    {
      createWorker: () => worker as unknown as Worker,
      onStatus: (status) => statuses.push(status),
    },
  );
  t.after(() => session.dispose());
  worker.on("request", (request: DeepRequest | WorkspaceFileRequest) => {
    if (!("kind" in request)) return;
    setImmediate(() =>
      worker.emit("message", {
        kind: request.kind,
        id: request.id,
        absolutePath: request.absolutePath,
        source: "local props = {}\nprops.text = 'value'\n",
        diagnostics: [finding(2)],
      }),
    );
  });
  session.start();
  worker.emit("message", {
    id: worker.requests[0]!.id,
    project,
    diagnostics: [],
    files: [
      path.join(process.cwd(), "A.luau"),
      path.join(process.cwd(), "B.luau"),
    ],
  });
  assert.equal(worker.requests.length, 2);
  assert.equal("kind" in worker.requests[1]!, true);
  assert.deepEqual(statuses.at(-1)?.progress, { completed: 0, total: 2 });
  await finished;
  assert.ok(
    statuses.some(
      (status) =>
        status.state === "background" &&
        status.progress?.completed === 1 &&
        status.progress.total === 2,
    ),
  );
  assert.equal(statuses.at(-1)?.state, "idle");
  assert.ok(
    output.some(
      (item) =>
        item.level === "info" &&
        item.message === "Queued unopened files for background analysis: 2",
    ),
  );
  assert.ok(
    output.some(
      (item) =>
        item.level === "info" &&
        /Files processed: 2 \| Findings: 2$/.test(item.message),
    ),
  );
  assert.equal(
    output.filter(
      (item) =>
        item.level === "debug" &&
        item.message.startsWith("Background analysis finished for"),
    ).length,
    2,
  );
});

test("background scanning keeps one file in flight and yields to open-file analysis", (t) => {
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
  t.after(() => session.dispose());
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
  assert.equal(background.kind, "workspace-file");
  assert.equal(worker.requests.length, 2);

  const filename = path.join(process.cwd(), "Component.luau");
  session.open(pathToFileURL(filename).href, filename, "return 1\n", 1);
  const foreground = worker.requests[2] as DeepRequest;
  assert.equal(foreground.diagnose, true);
  assert.equal(foreground.buffers.length, 1);
  assert.equal(statuses.at(-1)?.state, "analyzing");
  worker.emit("message", {
    kind: "workspace-file",
    id: background.id,
    absolutePath: background.absolutePath,
    diagnostics: [],
  });
  assert.equal(worker.requests.length, 3);
  worker.emit("message", {
    id: foreground.id,
    project,
    files,
    affectedFiles: [],
    diagnostics: [
      { relativePath: "Component.luau", version: 1, diagnostics: [] },
    ],
  });
  assert.equal(worker.requests.length, 3);
  assert.equal(statuses.at(-1)?.state, "background");
});

test("editing a checked file keeps unaffected background results and ignores duplicate save notifications", async (t) => {
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
  t.after(() => session.dispose());
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
  assert.ok(retained.diagnostics.length);

  session.open(uri, filename, "local props = {}\nprops.text = 'value'\n", 1);
  const opened = worker.requests.at(-1) as DeepRequest;
  assert.deepEqual(opened.diagnoseFiles, [filename]);
  assert.equal(opened.fullScan, false);
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
  assert.equal(saved.fullScan, false);
  assert.deepEqual(saved.diagnoseFiles, [filename]);
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
  assert.equal(worker.requests.length, count);
  assert.deepEqual(
    publications.filter((item) => item.uri === otherUri),
    [retained],
  );
});

test("incremental refreshes invalidate cached importers and preserve discarded invalidations", (t) => {
  const worker = new FakeWorker();
  const session = new WorkspaceSession(
    process.cwd(),
    {},
    { ...defaultEditorSettings, workspaceScan: true },
    () => {},
    () => {},
    { createWorker: () => worker as unknown as Worker },
  );
  t.after(() => session.dispose());
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
  assert.equal(worker.requests.length, count + 1);
  const reopened = worker.requests.at(-1) as DeepRequest;
  assert.deepEqual(reopened.diagnoseFiles, [component]);
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
  assert.deepEqual(obsolete.diagnoseFiles, []);
  session.watchedFilesChanged([{ uri: pathToFileURL(other).href, type: 2 }]);
  worker.emit("message", {
    id: obsolete.id,
    project,
    files,
    affectedFiles: [component, other],
    diagnostics: [],
  });
  const replacement = worker.requests.at(-1) as DeepRequest;
  assert.notEqual(replacement.id, obsolete.id);
  assert.deepEqual(replacement.diagnoseFiles, [component]);
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

test(
  "Node server recovers from invalid config and supports diagnostics, explanations, suppressions, and rescanning",
  {
    skip: !fs.existsSync(bundledServer) || !Bun.which("node"),
  },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-lsp-protocol-"));
    const filename = path.join(root, "Component.luau");
    const uri = pathToFileURL(filename).href;
    const configPath = path.join(root, "react-luau-doctor.config.json");
    const source =
      "local React = require(script.Parent.React)\nlocal function Component(props)\n\tprops.text = 'changed'\n\treturn React.createElement('TextLabel', { Text = props.text })\nend\nreturn Component\n";
    fs.writeFileSync(filename, source.replace("'changed'", "'saved'"));
    fs.writeFileSync(configPath, "{");
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
    connection.onNotification(
      "window/logMessage",
      (value: LogMessageParams) => {
        output.push(value);
        notifications.emit("update");
      },
    );
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
    t.after(() => {
      connection.dispose();
      child.kill();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(projectCachePath(root, "lsp"), { force: true });
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
    const initialized = await Promise.race([
      connection.sendRequest<InitializeResult>("initialize", {
        processId: null,
        rootUri: pathToFileURL(root).href,
        capabilities: {},
      }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Initialization timed out: ${stderr}`)),
          10000,
        );
        timer.unref();
      }),
    ]);
    assert.equal(initialized.capabilities.hoverProvider, true);
    assert.ok(initialized.capabilities.codeActionProvider);
    assert.equal(initialized.serverInfo?.name, "React-Luau Doctor");
    await connection.sendNotification("initialized", {});
    await waitFor(() => statuses.some((status) => status.state === "error"));
    assert.ok(
      output.some(
        (item) =>
          item.type === MessageType.Info &&
          item.message === `Project root: ${root}`,
      ),
    );
    assert.ok(
      output.some(
        (item) =>
          item.type === MessageType.Info &&
          /language server \| Node v/.test(item.message),
      ),
    );
    assert.ok(
      output.some(
        (item) =>
          item.type === MessageType.Error &&
          item.message.startsWith("Configuration failed:"),
      ),
    );
    assert.equal(
      output.some((item) => item.message.startsWith("Ready for open files")),
      false,
    );
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
    await waitFor(() =>
      output.some((item) =>
        item.message.startsWith("Project analysis finished"),
      ),
    );
    assert.ok(
      output.some(
        (item) =>
          item.type === MessageType.Info &&
          item.message === `Loaded project config: ${configPath}`,
      ),
    );
    assert.ok(
      output.some(
        (item) =>
          item.type === MessageType.Info &&
          /Open files checked: 1 \| Errors: 1 \| Warnings: 0 \| Suggestions: 0$/.test(
            item.message,
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
    assert.ok(
      actions.some(
        (action) => action.command?.command === "reactLuauDoctor.explainRule",
      ),
    );
    const explainParams = actions.find((action) => action.command)?.command
      ?.arguments?.[0];
    const explanation = await connection.sendRequest<string>(
      explainFindingRequest,
      { ...explainParams, columns: 80 },
    );
    assert.match(explanation, /react-luau\/no-prop-mutation/);
    assert.match(explanation, /Why this fired/);
    assert.match(explanation, /How to fix/);
    assert.match(explanation, /CURRENT/);
    assert.match(explanation, /SUGGESTED/);
    assert.match(explanation, /changed/);
    assert.doesNotMatch(explanation, /saved/);
    const updated = applyAction(
      source,
      actions.find((action) => action.edit)!,
    );
    await connection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: updated }],
    });
    assert.equal(
      await connection.sendRequest(explainFindingRequest, explainParams),
      null,
    );
    assert.equal(await connection.sendRequest(rescanRequest), true);
    assert.ok(
      output.some(
        (item) =>
          item.type === MessageType.Info &&
          item.message === "Project rescan requested",
      ),
    );
    await waitFor(() =>
      diagnostics.some(
        (item) =>
          item.version === 2 &&
          item.diagnostics.every(
            (diagnostic) => diagnostic.code !== "react-luau/no-prop-mutation",
          ),
      ),
    );
    assert.ok(statuses.some((status) => status.state === "analyzing"));
    await connection.sendNotification("workspace/didChangeConfiguration", {
      settings: { reactLuauDoctor: { enable: false } },
    });
    await waitFor(() => statuses.at(-1)?.state === "disabled");
    assert.ok(
      output.some(
        (item) =>
          item.type === MessageType.Info &&
          item.message.startsWith("Diagnostics disabled"),
      ),
    );
    await connection.sendRequest("shutdown");
    assert.ok(
      output.some(
        (item) =>
          item.type === MessageType.Info &&
          item.message === "Shutting down language server",
      ),
    );
    await connection.sendNotification("exit");
  },
);
