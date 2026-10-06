import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { WorkspaceSession, defaultEditorSettings } from "../src/lsp/session";
import type { AnalysisStatus } from "../src/lsp/editor-protocol";
import type { Diagnostic } from "../src/types";
import type { DeepRequest, WorkspaceFileRequest } from "../src/lsp/protocol";
import type { ReactFileAnalysisResult } from "../src/file-analysis";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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

class FakeWorker extends EventEmitter {
  readonly requests: Array<DeepRequest | WorkspaceFileRequest> = [];
  postMessage(request: DeepRequest | WorkspaceFileRequest): void {
    this.requests.push(request);
    this.emit("request", request);
  }
  async terminate(): Promise<number> { return 0; }
}

function finding(line: number): Diagnostic {
  return {
    id: "finding", rule: "react-luau/no-prop-mutation", category: "Correctness",
    severity: "error", message: "Props are immutable", file: "Component.luau",
    location: { line, column: 1, endLine: line, endColumn: 10 },
  };
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

test("sessions recover from worker failures without an old exit clearing the replacement", async (t) => {
  const workers: FakeWorker[] = [];
  const statuses: AnalysisStatus[] = [];
  const project = buildProjectModel(process.cwd(), []);
  const session = new WorkspaceSession(process.cwd(), {}, defaultEditorSettings, () => {}, () => {}, {
    onStatus: (status) => statuses.push(status),
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
  t.after(() => session.dispose());
  const uri = pathToFileURL(path.join(process.cwd(), "Component.luau")).href;
  const source = "local props = {}\nprops.text = 'value'\n";
  session.open(uri, path.join(process.cwd(), "Component.luau"), source, 1);
  const worker = workers[0]!;
  worker.emit("message", { id: worker.requests[0]!.id, project, diagnostics: [{ relativePath: "Component.luau", version: 1, diagnostics: [finding(2)] }] });
  worker.emit("error", new Error("worker failed"));
  assert.equal(statuses.at(-1)?.state, "error");
  session.updateConfig({}, defaultEditorSettings);
  const replacement = workers[1]!;
  worker.emit("exit", 1);
  assert.equal(statuses.at(-1)?.state, "analyzing");
  replacement.emit("message", { id: replacement.requests[0]!.id, project, diagnostics: [{ relativePath: "Component.luau", version: 1, diagnostics: [] }] });
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
  const started = new Promise<void>((resolve) => { startLive = resolve; });
  const result = new Promise<ReactFileAnalysisResult>((resolve) => { finishLive = resolve; });
  const session = new WorkspaceSession(process.cwd(), {}, { ...defaultEditorSettings, liveDebounceMs: 0 },
    (_uri, _version, diagnostics) => publications.push(diagnostics.length), () => {}, {
      createWorker: () => worker as unknown as Worker,
      onStatus: (status) => statuses.push(status),
      analyzeFile: async () => { startLive(); return result; },
    });
  t.after(() => session.dispose());
  const filename = path.join(process.cwd(), "Component.luau");
  const uri = pathToFileURL(filename).href;
  const source = "local props = {}\nprops.text = 'value'\n";
  session.open(uri, filename, source, 1);
  worker.emit("message", { id: worker.requests[0]!.id, project: buildProjectModel(process.cwd(), []), diagnostics: [] });
  session.change(uri, `${source}\n`, 2);
  await started;
  session.configurationError("Invalid configuration");
  const count = publications.length;
  finishLive({ relativePath: "Component.luau", isReactFile: true, scanned: true, diagnostics: [finding(2)] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(publications.length, count);
  assert.deepEqual(statuses.at(-1), { state: "error", message: "Invalid configuration" });
});

test("background output summarizes the batch and keeps per-file details at debug level", async (t) => {
  const worker = new FakeWorker();
  const output: Array<{ message: string; level: string }> = [];
  const project = buildProjectModel(process.cwd(), []);
  let complete!: () => void;
  const finished = new Promise<void>((resolve) => { complete = resolve; });
  const session = new WorkspaceSession(process.cwd(), {}, { ...defaultEditorSettings, workspaceScan: true },
    () => {}, (message, level) => {
      output.push({ message, level });
      if (message.startsWith("Background analysis finished in")) complete();
    }, { createWorker: () => worker as unknown as Worker });
  t.after(() => session.dispose());
  worker.on("request", (request: DeepRequest | WorkspaceFileRequest) => {
    if (!("kind" in request)) return;
    setImmediate(() => worker.emit("message", {
      kind: request.kind, id: request.id, absolutePath: request.absolutePath,
      source: "local props = {}\nprops.text = 'value'\n", diagnostics: [finding(2)],
    }));
  });
  session.start();
  worker.emit("message", {
    id: worker.requests[0]!.id, project, diagnostics: [],
    files: [path.join(process.cwd(), "A.luau"), path.join(process.cwd(), "B.luau")],
  });
  await finished;
  assert.ok(output.some((item) => item.level === "info" && item.message === "Queued unopened files for background analysis: 2"));
  assert.ok(output.some((item) => item.level === "info" && /Files processed: 2 \| Findings: 2$/.test(item.message)));
  assert.equal(output.filter((item) => item.level === "debug" && item.message.startsWith("Background analysis finished for")).length, 2);
});
