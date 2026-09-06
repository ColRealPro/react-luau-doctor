import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { projectCachePath } from "../src/cache";
import { scanPath } from "../src/scanner";

function withCacheDirectory<T>(cacheDirectory: string, callback: () => Promise<T>): Promise<T> {
  const previous = process.env.REACT_LUAU_DOCTOR_CACHE_DIR;
  process.env.REACT_LUAU_DOCTOR_CACHE_DIR = cacheDirectory;
  return callback().finally(() => {
    if (previous === undefined) delete process.env.REACT_LUAU_DOCTOR_CACHE_DIR;
    else process.env.REACT_LUAU_DOCTOR_CACHE_DIR = previous;
  });
}

function writeReactFile(filename: string, body: string): void {
  fs.writeFileSync(filename, `local React = require(script.Parent.React)\n${body}\n`);
}

test("persistent analysis cache lives outside the scanned project and reuses full reports", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-cache-project-"));
  const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-cache-store-"));
  writeReactFile(
    path.join(root, "Component.luau"),
    `local function Component(props)\n  props.value = 1\n  return React.createElement("Frame")\nend\nreturn Component`,
  );

  await withCacheDirectory(cacheDirectory, async () => {
    const first = await scanPath(root);
    const second = await scanPath(root);
    const normalize = (diagnostics: typeof first.diagnostics) => diagnostics.map((diagnostic) => ({
      id: diagnostic.id,
      file: diagnostic.file,
      rule: diagnostic.rule,
      severity: diagnostic.severity,
      message: diagnostic.message,
      location: diagnostic.location,
    }));
    assert.deepEqual(normalize(second.diagnostics), normalize(first.diagnostics));
    assert.equal(second.scannedFiles, first.scannedFiles);

    const filename = projectCachePath(root);
    assert.equal(filename.startsWith(path.resolve(cacheDirectory)), true);
    assert.equal(filename.startsWith(path.resolve(root)), false);
    assert.equal(fs.existsSync(filename), true);
  });
});

test("incremental cache rescans changed files while preserving unaffected diagnostics", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-cache-incremental-"));
  const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-cache-store-"));
  const firstFile = path.join(root, "First.luau");
  const secondFile = path.join(root, "Second.luau");

  writeReactFile(
    firstFile,
    `local function First(props)\n  props.value = 1\n  return React.createElement("Frame")\nend\nreturn First`,
  );
  writeReactFile(
    secondFile,
    `local function Second()\n  return React.createElement("Frame")\nend\nreturn Second`,
  );

  await withCacheDirectory(cacheDirectory, async () => {
    const initial = await scanPath(root);
    assert.equal(initial.diagnostics.some((diagnostic) => diagnostic.file === "First.luau"), true);

    writeReactFile(
      secondFile,
      `local function Second(props)\n  props.other = 2\n  return React.createElement("Frame")\nend\nreturn Second`,
    );

    const incremental = await scanPath(root);
    const uncached = await scanPath(root, { cache: false });
    const normalize = (diagnostics: typeof incremental.diagnostics) => diagnostics.map((diagnostic) => ({
      file: diagnostic.file,
      rule: diagnostic.rule,
      line: diagnostic.location.line,
      message: diagnostic.message,
      severity: diagnostic.severity,
    }));
    assert.deepEqual(normalize(incremental.diagnostics), normalize(uncached.diagnostics));
    assert.equal(incremental.diagnostics.some((diagnostic) => diagnostic.file === "Second.luau"), true);
  });
});

test("incremental cache invalidates transitive importers when source effects change", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-cache-effects-"));
  const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-cache-store-"));
  const mutator = path.join(root, "Mutator.luau");
  const component = path.join(root, "Component.luau");

  fs.writeFileSync(
    mutator,
    `local external = {}\nlocal function mutate()\n  external.value = 1\nend\nreturn mutate\n`,
  );
  fs.writeFileSync(
    component,
    `local React = require(script.Parent.React)\nlocal mutate = require(script.Parent.Mutator)\nlocal function Component()\n  mutate()\n  return React.createElement("Frame")\nend\nreturn Component\n`,
  );

  await withCacheDirectory(cacheDirectory, async () => {
    const initial = await scanPath(root);
    assert.equal(
      initial.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/no-side-effects-in-render"),
      true,
    );

    fs.writeFileSync(mutator, `local function mutate()\n  return 1\nend\nreturn mutate\n`);
    const incremental = await scanPath(root);
    const uncached = await scanPath(root, { cache: false });
    assert.equal(
      incremental.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/no-side-effects-in-render"),
      false,
    );
    assert.deepEqual(
      incremental.diagnostics.map((diagnostic) => `${diagnostic.file}:${diagnostic.rule}:${diagnostic.location.line}`),
      uncached.diagnostics.map((diagnostic) => `${diagnostic.file}:${diagnostic.rule}:${diagnostic.location.line}`),
    );
  });
});
