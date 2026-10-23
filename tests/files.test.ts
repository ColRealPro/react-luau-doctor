import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    expect(files).toEqual(["src/Nested/Child.lua", "src/Root.luau"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("path selection applies file globs and ignored directory prefixes", () => {
  const config = { ignore: ["**/*.story.luau", "src/Hidden/"], include: ["src/**/*.luau"] };
  expect(isSelectedLuauPath("src/Component.luau", config)).toBe(true);
  expect(isSelectedLuauPath("src/Nested/Component.luau", config)).toBe(true);
  expect(isSelectedLuauPath("src/Nested/Component.story.luau", config)).toBe(false);
  expect(isSelectedLuauPath("src/Hidden/Component.luau", config)).toBe(false);
  expect(isSelectedLuauPath("Packages/Dependency.luau", {})).toBe(false);
  expect(isSelectedLuauPath("test/Component.luau", config)).toBe(false);
});

test("scanner rejects unknown configured rule ids", async () => {
  const root = tempProject();
  try {
    await expect(scanPath(root, { config: { rules: { "react-luau/typo-rule": "warning" } } })).rejects.toThrow(/Unknown configured rule/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explicit file targets bypass directory include and ignore filters", () => {
  const root = tempProject();
  try {
    const file = path.join(root, "src", "Root.luau");
    expect(discoverLuauFiles(file, { include: ["other/**"], ignore: ["**/*.luau"] })).toEqual([file]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
