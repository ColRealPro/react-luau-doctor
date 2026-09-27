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
