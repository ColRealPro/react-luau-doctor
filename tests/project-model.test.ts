import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
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

test("module references require path-segment suffixes instead of raw string suffixes", () => {
  const model = buildProjectModel("/virtual", [
    sourceFile("Director.luau", `local React = require(script.Parent.React)\nlocal Director = React.memo(function() return nil end)\nreturn Director`),
    sourceFile("ReplayDirector.luau", `local function ReplayDirector() return nil end\nreturn ReplayDirector`),
  ]);

  assert.equal(
    resolveModuleReference(normalizeRequireTarget("script.Parent.Director"), model.memoizedModules),
    "shallow",
  );
  assert.equal(
    resolveModuleReference(normalizeRequireTarget("script.Parent.ReplayDirector"), model.memoizedModules),
    null,
  );
});

test("ambiguous basename aliases are removed while longer unique paths remain usable", () => {
  const model = buildProjectModel("/virtual", [
    sourceFile("src/A/Crosshair.luau", `local React = require(script.Parent.React)\nreturn React.memo(function() return nil end)`),
    sourceFile("src/B/Crosshair.luau", `local function Crosshair() return nil end\nreturn Crosshair`),
  ]);

  assert.equal(resolveModuleReference(normalizeRequireTarget("script.Parent.Crosshair"), model.memoizedModules), null);
  assert.equal(
    resolveModuleReference(normalizeRequireTarget("ReplicatedStorage.A.Crosshair"), model.memoizedModules),
    "shallow",
  );
});

test("binding API alternatives are inferred only from sibling methods that actually exist", () => {
  const model = buildProjectModel("/virtual", [
    sourceFile("ClientState.luau", `local ClientState = {}\nfunction ClientState:GetReactState(selector) return nil end\nfunction ClientState:GetReactBinding(selector) return nil end\nreturn ClientState`),
    sourceFile("OtherState.luau", `local OtherState = {}\nfunction OtherState:ReadState() return nil end\nreturn OtherState`),
  ]);

  assert.equal(model.bindingApiAlternatives.get("GetReactState"), "GetReactBinding");
  assert.equal(model.bindingApiAlternatives.has("ReadState"), false);
});

test("custom callback wrappers are inferred from implementation rather than function names", () => {
  const model = buildProjectModel("/virtual", [
    sourceFile("useSignalBridge.luau", `local React = require(script.Parent.React)\nlocal function useSignalBridge(event, handler: (...any) -> ())\n  React.useEffect(function()\n    local connection = event:Connect(handler)\n    return function() connection:Disconnect() end\n  end, { event, handler })\nend\nreturn useSignalBridge`),
  ]);

  const summary = resolveModuleReference(
    normalizeRequireTarget("script.Parent.useSignalBridge"),
    model.externalCallbackModules,
  );
  assert.ok(summary);
  assert.deepEqual(summary.callbackParameterIndexes, [1]);
});


test("a state-named method is not treated as having a binding sibling when another owner uses the same method name without one", () => {
  const model = buildProjectModel("/virtual", [
    sourceFile("Paired.luau", `local Paired = {}\nfunction Paired:GetReactState() return nil end\nfunction Paired:GetReactBinding() return nil end\nreturn Paired`),
    sourceFile("Unpaired.luau", `local Unpaired = {}\nfunction Unpaired:GetReactState() return nil end\nreturn Unpaired`),
  ]);

  assert.equal(model.bindingApiAlternatives.has("GetReactState"), false);
});


test("export detection uses the module's final return instead of an inner return", () => {
  const model = buildProjectModel("/virtual", [
    sourceFile("useEventConnection.luau", `local React = require(script.Parent.React)\nlocal function useEventConnection<T...>(event: RBXScriptSignal<T...>, callback: (T...) -> (), dependencies: { any })\n  local cachedCallback = React.useMemo(function()\n    return callback\n  end, dependencies)\n  React.useEffect(function()\n    local connection = event:Connect(cachedCallback)\n    return function() connection:Disconnect() end\n  end, { event, cachedCallback })\nend\nreturn useEventConnection`),
  ]);

  const summary = resolveModuleReference(normalizeRequireTarget("script.Parent.useEventConnection"), model.externalCallbackModules);
  assert.ok(summary);
  assert.deepEqual(summary.callbackParameterIndexes, [1]);
});

test("binding-compatible custom component props are inferred only when every read forwards to host props", () => {
  const model = buildProjectModel("/virtual", [
    sourceFile("VisualFrame.luau", `local React = require(script.Parent.React)
local function VisualFrame(props)
  return React.createElement("Frame", {
    Rotation = props.rotation,
    Size = props["size"],
  })
end
return VisualFrame`),
    sourceFile("StructuralFrame.luau", `local React = require(script.Parent.React)
local function StructuralFrame(props)
  return React.createElement("Frame", {
    Rotation = props.rotation,
  }, {
    child = props.rotation > 0 and React.createElement("Frame") or nil,
  })
end
return StructuralFrame`),
    sourceFile("MemoVisualFrame.luau", `local React = require(script.Parent.React)
local function MemoVisualFrame(props)
  return React.createElement("Frame", { Position = props.position })
end
return React.memo(MemoVisualFrame)`),
  ]);

  const visual = resolveModuleReference(
    normalizeRequireTarget("script.Parent.VisualFrame"),
    model.bindingCompatibleComponentProps,
  );
  assert.ok(visual);
  assert.deepEqual([...visual].sort(), ["rotation", "size"]);

  const structural = resolveModuleReference(
    normalizeRequireTarget("script.Parent.StructuralFrame"),
    model.bindingCompatibleComponentProps,
  );
  assert.equal(structural?.has("rotation") ?? false, false);

  const memoVisual = resolveModuleReference(
    normalizeRequireTarget("script.Parent.MemoVisualFrame"),
    model.bindingCompatibleComponentProps,
  );
  assert.equal(memoVisual?.has("position") ?? false, true);
});

test("React hook module ownership is inferred from direct and transitive React hook usage", () => {
  const model = buildProjectModel("/virtual", [
    sourceFile("useMatterReact.luau", `local Matter = require(script.Parent.Matter)
local function useMatterReact(discriminator)
  return Matter.useHookState(discriminator)
end
return useMatterReact`),
    sourceFile("useInner.luau", `local React = require(script.Parent.React)
local function useInner()
  return React.useState(0)
end
return useInner`),
    sourceFile("useOuter.luau", `local useInner = require(script.Parent.useInner)
local function useOuter()
  return useInner()
end
return useOuter`),
  ]);

  assert.equal(
    resolveModuleReference(normalizeRequireTarget("script.Parent.useMatterReact"), model.reactHookModules),
    false,
  );
  assert.equal(
    resolveModuleReference(normalizeRequireTarget("script.Parent.useInner"), model.reactHookModules),
    true,
  );
  assert.equal(
    resolveModuleReference(normalizeRequireTarget("script.Parent.useOuter"), model.reactHookModules),
    true,
  );
});
