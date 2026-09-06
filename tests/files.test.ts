import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverLuauFiles, isSelectedLuauPath } from "../src/files";
import { scanPath } from "../src/scanner";

function tempProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-"));
  fs.mkdirSync(path.join(root, "src", "Nested"), { recursive: true });
  fs.mkdirSync(path.join(root, "Packages"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "Root.luau"), "return true\n");
  fs.writeFileSync(path.join(root, "src", "Nested", "Child.lua"), "return true\n");
  fs.writeFileSync(path.join(root, "Packages", "Ignored.luau"), "return true\n");
  return root;
}

test("globstar include matches zero or more nested directories", () => {
  const root = tempProject();
  try {
    const files = discoverLuauFiles(root, { include: ["src/**/*.lua", "src/**/*.luau"] })
      .map((file) => path.relative(root, file).split(path.sep).join("/"));
    assert.deepEqual(files, ["src/Nested/Child.lua", "src/Root.luau"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("path selection applies file globs and ignored directory prefixes", () => {
  const config = { ignore: ["**/*.story.luau", "src/Hidden/"], include: ["src/**/*.luau"] };
  assert.equal(isSelectedLuauPath("src/Component.luau", config), true);
  assert.equal(isSelectedLuauPath("src/Nested/Component.luau", config), true);
  assert.equal(isSelectedLuauPath("src/Nested/Component.story.luau", config), false);
  assert.equal(isSelectedLuauPath("src/Hidden/Component.luau", config), false);
  assert.equal(isSelectedLuauPath("Packages/Dependency.luau", {}), false);
  assert.equal(isSelectedLuauPath("test/Component.luau", config), false);
});

test("scanner accepts a single Luau file target", async () => {
  const root = tempProject();
  try {
    const file = path.join(root, "src", "Root.luau");
    const report = await scanPath(file);
    assert.equal(report.scannedFiles, 1);
    assert.equal(report.diagnostics.length, 0);
    assert.equal(report.diagnostics.every((diagnostic) => diagnostic.file === "Root.luau"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scanner rejects unknown configured rule ids", async () => {
  const root = tempProject();
  try {
    await assert.rejects(
      () => scanPath(root, { config: { rules: { "react-luau/typo-rule": "warning" } } }),
      /Unknown configured rule/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explicit file targets bypass directory include and ignore filters", () => {
  const root = tempProject();
  try {
    const file = path.join(root, "src", "Root.luau");
    assert.deepEqual(discoverLuauFiles(file, { include: ["other/**"], ignore: ["**/*.luau"] }), [file]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

