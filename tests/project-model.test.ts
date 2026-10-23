import { expect, test } from "bun:test";
import path from "node:path";
import { normalizeRequireTarget, resolveModuleReference } from "../src/module-resolution";
import { buildProjectModel } from "../src/project-model";
import type { ScanFileInput } from "../src/types";

function sourceFile(relativePath: string, source: string): ScanFileInput {
  return {
    absolutePath: path.resolve("/virtual", relativePath),
    relativePath,
    source,
  };
}

test("ambiguous basename aliases are removed while longer unique paths remain usable", () => {
  const model = buildProjectModel("/virtual", [
    sourceFile("src/A/Widget.luau", `local React = require(script.Parent.React)\nreturn React.memo(function() return nil end)`),
    sourceFile("src/B/Widget.luau", `local function Widget() return nil end\nreturn Widget`),
  ]);

  expect(resolveModuleReference(normalizeRequireTarget("script.Parent.Widget"), model.memoizedModules)).toBe(null);
  expect(resolveModuleReference(normalizeRequireTarget("ReplicatedStorage.A.Widget"), model.memoizedModules)).toBe("shallow");
});

test("a state-named method is not treated as having a binding sibling when another owner uses the same method name without one", () => {
  const model = buildProjectModel("/virtual", [
    sourceFile("Paired.luau", `local Paired = {}\nfunction Paired:GetReactState() return nil end\nfunction Paired:GetReactBinding() return nil end\nreturn Paired`),
    sourceFile("Unpaired.luau", `local Unpaired = {}\nfunction Unpaired:GetReactState() return nil end\nreturn Unpaired`),
  ]);

  expect(model.bindingApiAlternatives.has("GetReactState")).toBe(false);
});
