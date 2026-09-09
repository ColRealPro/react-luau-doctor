import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanPath } from "../src/scanner";

function writeComponent(root: string, source: string): void {
  fs.writeFileSync(path.join(root, "Component.luau"), source);
}

const presentationOnly = `local React = require(script.Parent.React)
local RunService = game:GetService("RunService")

local function Component()
  local position, setPosition = React.useState(Vector2.zero)
  React.useEffect(function()
    local connection = RunService.RenderStepped:Connect(function()
      setPosition(getPosition())
    end)
    return function()
      connection:Disconnect()
    end
  end, {})

  return React.createElement("Frame", {
    Position = UDim2.fromOffset(position.X, position.Y),
  })
end

return Component`;

test("specific Binding warning supersedes generic high-frequency state warning", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-supersession-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeComponent(root, presentationOnly);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/prefer-binding-over-state").length, 1);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rerender-high-frequency-state"), false);
});

test("high-frequency state warning remains when React reconciliation is required", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-structural-high-frequency-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeComponent(root, `local React = require(script.Parent.React)
local RunService = game:GetService("RunService")

local function Component()
  local position, setPosition = React.useState(Vector2.zero)
  React.useEffect(function()
    local connection = RunService.RenderStepped:Connect(function()
      setPosition(getPosition())
    end)
    return function()
      connection:Disconnect()
    end
  end, {})

  if position.X > 0 then
    return React.createElement("Frame")
  end
  return nil
end

return Component`);

  const report = await scanPath(root);
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rerender-high-frequency-state"));
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/prefer-binding-over-state"), false);
});

test("mixed high-frequency state keeps generic warning and Binding candidate", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-mixed-high-frequency-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeComponent(root, `local React = require(script.Parent.React)
local RunService = game:GetService("RunService")

local function Component()
  local position, setPosition = React.useState(Vector2.zero)
  React.useEffect(function()
    local connection = RunService.RenderStepped:Connect(function()
      setPosition(getPosition())
    end)
    return function()
      connection:Disconnect()
    end
  end, {})

  local children = {}
  if position.X > 0 then
    children.Marker = React.createElement("Frame")
  end

  return React.createElement("Frame", {
    Position = UDim2.fromOffset(position.X, position.Y),
  }, children)
end

return Component`);

  const report = await scanPath(root);
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rerender-high-frequency-state"));
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/prefer-binding-over-state"), false);
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/prefer-binding-over-state-candidate"));
});

test("a lower-severity Binding diagnostic does not hide a stronger high-frequency warning", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-severity-supersession-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeComponent(root, presentationOnly);

  const report = await scanPath(root, {
    config: {
      rules: {
        "react-luau/prefer-binding-over-state": "suggestion",
      },
    },
  });
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/prefer-binding-over-state"));
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rerender-high-frequency-state"));
});

test("disabling the specific Binding rule preserves the high-frequency warning", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-disabled-binding-supersession-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeComponent(root, presentationOnly);

  const report = await scanPath(root, {
    config: {
      rules: {
        "react-luau/prefer-binding-over-state": "off",
      },
    },
  });
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/prefer-binding-over-state"), false);
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rerender-high-frequency-state"));
});
