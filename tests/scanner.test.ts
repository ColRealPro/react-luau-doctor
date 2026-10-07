import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanPath } from "../src/scanner";

const fixtures = path.resolve(import.meta.dir, "fixtures");

test("render setter analysis follows expressions and aliases without warning for deferred or conditional updates", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-render-setters-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "Component.luau"),
    `local React = require(script.Parent.React)
local function Component(props)
    local open, setOpen = React.useState(false)
    local update = setOpen
    local first = setOpen(true)
    consume(update(true))
    do
        setOpen(true)
    end
    local left = setOpen(true) or props.enabled
    local right = props.enabled and setOpen(true)
    local choice = if props.enabled then setOpen(true) else nil
    if props.enabled then setOpen(true) end
    for _ in {} do setOpen(true) end
    while props.enabled do setOpen(true) end
    repeat if props.enabled then break end until setOpen(true)
    React.useEffect(function() setOpen(true) end, {})
    local function deferred() setOpen(true) end
    do
        local setOpen = function(value) return value end
        local ignored = setOpen(true)
    end
    return React.createElement("TextButton", {
        Visible = open,
        [React.Event.Activated] = update(true),
        [React.Event.MouseEnter] = function() setOpen(true) end,
    })
end
return Component`,
  );
  fs.writeFileSync(
    path.join(root, "Guarded.luau"),
    `local React = require(script.Parent.React)
local function Component(props)
    local value, setValue = React.useState(0)
    if not props.enabled then return nil end
    local result = setValue(1)
    return React.createElement("Frame")
end
return Component`,
  );
  const report = await scanPath(root, { cache: false });
  const findings = report.diagnostics.filter(
    (item) => item.rule === "react-luau/no-set-state-in-render",
  );

  assert.deepEqual(
    findings.map((item) => [item.file, item.location.line]),
    [
      ["Component.luau", 5],
      ["Component.luau", 6],
      ["Component.luau", 8],
      ["Component.luau", 10],
    ["Component.luau", 25],
    ],
  );
});

test("dependency analysis resolves shadowed module locals inside initializers without hiding later reactive reads", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "doctor-dependency-scope-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "Component.luau"),
    `local React = require(script.Parent.React)
local catalog = require(script.Parent.Catalog)
local function Component(props)
    local catalog = React.useMemo(function()
        return catalog[props.id]
    end, { props.id })
    React.useEffect(function()
        consume(catalog)
    end, {})
    return React.createElement("Frame")
end
return Component`,
  );
  const report = await scanPath(root, { cache: false });
  const findings = report.diagnostics.filter(
    (item) => item.rule === "react-luau/exhaustive-deps",
  );
  assert.equal(findings.length, 1);
  assert.match(
    findings[0].message,
    /React\.useEffect dependency table is missing catalog/,
  );
});

test("dependency table aliases match inline analysis while uncertain contents remain conservative", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "doctor-dependency-tables-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const cases = [
    ["Inline", "", "{ props.query }"],
    ["Alias", "local dependencies = { props.query }", "dependencies"],
    [
      "Chain",
      "local dependencies = { props.query }\nlocal alias = (dependencies :: { any })",
      "alias",
    ],
    [
      "Reassigned",
      "local dependencies = {}\ndependencies = { props.query }",
      "dependencies",
    ],
    [
      "Reused",
      "local dependencies = { props.query }\nReact.useCallback(function() return props.query end, dependencies)",
      "dependencies",
    ],
    [
      "Complete",
      "local dependencies = { props.query, props.category }",
      "dependencies",
    ],
    [
      "Written",
      "local dependencies = { props.query }\nlocal alias = dependencies\nalias[2] = props.category",
      "dependencies",
    ],
    [
      "Mutated",
      "local dependencies = { props.query }\ntable.insert(dependencies, props.category)",
      "dependencies",
    ],
    [
      "Escaped",
      "local dependencies = { props.query }\nupdateDependencies(dependencies)",
      "dependencies",
    ],
    [
      "Conditional",
      "local dependencies = { props.query }\nif props.enabled then dependencies = {} end",
      "dependencies",
    ],
    [
      "Shadowed",
      "local dependencies = { props.query }\ndo\nlocal dependencies = { props.query, props.category }",
      "dependencies",
    ],
  ];

  for (const [name, declarations, argument] of cases) {
    fs.writeFileSync(
      path.join(root, `${name}.luau`),
      `local React = require(script.Parent.React)
local function Component(props)
    ${declarations}
    React.useEffect(function()
        search(props.query, props.category)
    end, ${argument})
    ${name === "Shadowed" ? "end" : ""}
    return React.createElement("Frame")
end
return Component`,
    );
  }

  fs.writeFileSync(
    path.join(root, "Memo.luau"),
    `local React = require(script.Parent.React)
local function Component(props)
    local producerDependencies = { props.query }
    local result = React.useMemo(function() return transform(props.query) end, producerDependencies)
    local dependencies = { props.query }
    React.useEffect(function() consume(result) end, dependencies)
    return React.createElement("Frame")
end
return Component`,
  );
  const report = await scanPath(root, { cache: false });
  assert.equal(
    report.diagnostics.some((item) => item.rule === "react-luau/parse-error"),
    false,
  );
  const findings = report.diagnostics.filter(
    (item) => item.rule === "react-luau/exhaustive-deps",
  );
  const warnings = findings.filter((item) => item.severity === "warning");
  assert.deepEqual(warnings.map((item) => item.file).sort(), [
    "Alias.luau",
    "Chain.luau",
    "Inline.luau",
    "Reassigned.luau",
    "Reused.luau",
  ]);

  for (const finding of warnings) {
    assert.match(finding.message, /missing props\.category/);
    const source = fs.readFileSync(path.join(root, finding.file), "utf8");
    assert.match(source.split("\n")[finding.location.line - 1], /end, /);
  }

  const memo = findings.filter((item) => item.file === "Memo.luau");
  assert.equal(memo.length, 1);
  assert.equal(memo[0].severity, "suggestion");
  assert.match(memo[0].message, /memo dependencies are already covered/);
});

test("state updaters reject mutations of previous state but allow fresh copies and shadowed parameters", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-state-updater-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "mutate.luau"),
    `return function(value) table.clear(value) end`,
  );
  fs.writeFileSync(
    path.join(root, "Component.luau"),
    `local React = require(script.Parent.React)
local mutate = require(script.Parent.mutate)
local function Component()
    local items, setItems = React.useState({})
    local update = setItems
    update(function(previous)
        local alias = previous.items
        table.insert(alias, 1)
        previous.enabled = true
        mutate(previous.items)
        return previous
    end)
    local function clear(previous)
        table.clear(previous)
        return previous
    end
    setItems(clear)
    setItems(function(previous)
        local copy = table.clone(previous)
        table.insert(copy, 1)
        copy.enabled = true
        local function helper(previous)
            table.insert(previous, 1)
        end
        helper({})
        for previous in {} do
            table.clear(previous)
        end
        return copy
    end)
    setItems(function(previous)
        local copy = table.clone(previous)
        table.insert(copy.items, 1)
        copy.items = table.clone(previous.items)
        table.insert(copy.items, 1)
        return copy
    end)
    setItems(function(previous)
        previous = {}
        previous.enabled = true
        return previous
    end)
    local setItems = function(callback) return callback({}) end
    setItems(function(previous)
        table.clear(previous)
        return previous
    end)
    return React.createElement("Frame")
end
return Component`,
  );
  const report = await scanPath(root, { cache: false, parallel: false });
  const findings = report.diagnostics.filter(
    (item) => item.rule === "react-luau/no-mutating-state-updater",
  );
  assert.deepEqual(
    findings.map((item) => item.location.line),
    [8, 9, 10, 14, 33],
  );
});

test("direct component calls follow local aliases without confusing helpers or shadowed names", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-component-call-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "Component.luau"),
    `local React = require(script.Parent.React)
local function Child()
    React.useState(0)
    return React.createElement("Frame")
end
local function PureChild() return React.createElement("Frame") end
local function MakeElement() return React.createElement("Frame") end
local alias = Child
local function Parent()
    local child = alias()
    local pure = PureChild()
    local helper = MakeElement()
    local element = React.createElement(PureChild)
    do
        local Child = function() return 1 end
        Child()
    end
    local function callback(Child) return Child() end
    return React.createElement("Frame", {}, { child, pure, helper, element })
end
return Parent`,
  );
  const report = await scanPath(root, { cache: false });
  const findings = report.diagnostics.filter(
    (item) => item.rule === "react-luau/no-call-component-as-function",
  );
  assert.deepEqual(
    findings.map((item) => item.location.line),
    [10, 11],
  );
});

test("hook-using helpers that return values are not treated as directly called components", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-hook-helper-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "Component.luau"),
    `local React = require(script.Parent.React)
local function makeValues(initial)
    local first = React.useBinding(initial)
    local second = React.useBinding(0)
    local unusedElement = React.createElement("Frame")
    return first, second
end
local alias = makeValues
local function Component()
    local first, second = makeValues(1)
    local third, fourth = alias(2)
    return React.createElement("Frame")
end
return Component`,
  );
  const report = await scanPath(root, { cache: false });
  assert.equal(
    report.diagnostics.some(
      (item) => item.rule === "react-luau/no-call-component-as-function",
    ),
    false,
  );
});

test("binding creation warns during render but allows deferred work and guarded lazy ref initialization", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "doctor-binding-creation-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "Component.luau"),
    `local React = require(script.Parent.React)
local createBinding = React.createBinding
local shared = createBinding(0)
local function Component()
    local value = createBinding(0)
    local handle = React.useRef(nil)
    if handle.current == nil then
        handle.current = createBinding(0)
    else
        print("already initialized")
    end
    React.useEffect(function() createBinding(0) end, {})
    return React.createElement("TextButton", {
        Text = value,
        [React.Event.Activated] = function() createBinding(0) end,
    })
end
local function Other(React)
    React.useState(0)
    local binding = React.createBinding(0)
    return React.createElement("Frame")
end
return Component`,
  );
  const report = await scanPath(root, { cache: false });
  const findings = report.diagnostics.filter(
    (item) => item.rule === "react-luau/no-create-binding-in-render",
  );
  assert.deepEqual(
    findings.map((item) => item.location.line),
    [5],
  );
});

test("binding snapshot reads follow proven bindings and maps but allow events and unrelated getValue methods", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-binding-read-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "Component.luau"),
    `local React = require(script.Parent.React)
local shared = React.createBinding(0)
local function Component()
    local value, setValue = React.useBinding(0)
    local alias = (value :: any)
    local mapped = value:map(function(current) return tostring(current) end)
    local joined = React.joinBindings({ value, shared })
    local first = alias:getValue()
    local second = mapped:getValue()
    local third = joined:getValue()
    local fourth = shared:getValue()
    local unrelated = makeStore()
    unrelated:getValue()
    React.useEffect(function() value:getValue() end, {})
    do
        local value = makeStore()
        value:getValue()
    end
    return React.createElement("TextButton", {
        Text = mapped,
        [React.Event.Activated] = function() setValue(value:getValue() + 1) end,
    })
end
return Component`,
  );
  const report = await scanPath(root, { cache: false });
  const findings = report.diagnostics.filter(
    (item) => item.rule === "react-luau/no-binding-getvalue-in-render",
  );
  assert.deepEqual(
    findings.map((item) => item.location.line),
    [8, 9, 10, 11],
  );
});

test("binding snapshots may initialize refs without exempting other render reads or shadowed hooks", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "doctor-binding-ref-init-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "Component.luau"),
    `local React = require(script.Parent.React)
local useRef = React.useRef
local function Component()
    local value = React.useBinding(0)
    local direct = React.useRef(value:getValue())
    local aliased = useRef({ previous = value:getValue() })
    local formatted = React.useRef(tostring(value:getValue()))
    local snapshot = value:getValue()
    direct.current = value:getValue()
    local useRef = function(initial) return initial end
    local unrelated = useRef(value:getValue())
    local extra = React.useRef(nil, value:getValue())
    return React.createElement("TextLabel", { Text = value:getValue() })
end
return Component`,
  );
  const report = await scanPath(root, { cache: false });
  const findings = report.diagnostics.filter(
    (item) => item.rule === "react-luau/no-binding-getvalue-in-render",
  );
  assert.deepEqual(
    findings.map((item) => item.location.line),
    [8, 9, 11, 12, 13],
  );
});

test("memo callbacks must return a value but nested returns do not count and explicit nil remains allowed", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-memo-return-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "Component.luau"),
    `local React = require(script.Parent.React)
local memo = React.useMemo
local function calculate() compute() end
local function Component(props)
    local first = memo(calculate, {})
    local second = memo(function()
        local function inner() return 1 end
        inner()
        return
    end, {})
    local third = memo(function() return nil end, {})
    local fourth = memo(function()
        if props.enabled then return 1 end
    end, { props.enabled })
    local fifth = memo(function() return function() return 1 end end, {})
    local memo = function(callback) return callback() end
    memo(function() compute() end)
    return React.createElement("Frame")
end
return Component`,
  );
  const report = await scanPath(root, { cache: false });
  const findings = report.diagnostics.filter(
    (item) => item.rule === "react-luau/usememo-must-return",
  );
  assert.deepEqual(
    findings.map((item) => item.location.line),
    [5, 6],
  );
});

async function ruleIds(filename: string): Promise<Set<string>> {
  const report = await scanPath(fixtures);
  return new Set(report.diagnostics.filter((diagnostic) => diagnostic.file === filename).map((diagnostic) => diagnostic.rule));
}

test("finds React-Luau and Roblox-specific issues", async () => {
  const ids = await ruleIds("bad-component.luau");
  assert.ok(ids.has("react-luau/rules-of-hooks"));
  assert.ok(ids.has("react-luau/exhaustive-deps"));
  assert.ok(ids.has("react-luau/effect-needs-cleanup"));
  assert.ok(ids.has("react-luau/no-side-effects-in-render"));
  assert.ok(ids.has("react-luau/no-prop-mutation"));
  assert.ok(ids.has("react-luau/no-task-spawn-in-render"));
  assert.ok(ids.has("react-luau/no-yield-in-render"));
  assert.ok(ids.has("react-luau/no-array-index-as-key"));
});

test("reports static Name props on named Roblox children but allows dynamic names", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-child-name-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Names.luau"), `local React = require(script.Parent.React)
local createElement = React.createElement
local function Names(props)
  return React.createElement("Frame", {}, {
    First = React.createElement("TextLabel", { Name = "First" }),
    Second = createElement("Frame", { ["Name"] = 'Second' }),
    Third = React.createElement("Frame", { Name = ("Third") }),
    Fourth = React.createElement("Frame", { Name = "Four" .. "th" }),
    ["Fifth"] = React.createElement("Frame", { Name = "Fifth" }),
    Dynamic = React.createElement("Frame", { Name = props.name }),
    DynamicCapitalized = React.createElement("Frame", { Name = props.Name }),
    Computed = React.createElement("Frame", { Name = getName() }),
    Interpolated = React.createElement("Frame", { Name = \`Item{props.id}\` }),
    Concatenated = React.createElement("Frame", { Name = "Item" .. props.id }),
    Custom = React.createElement(Widget, { Name = "Widget" }),
  })
end
local Root = React.createElement("Frame", { Name = "Root" })
return Names
`);

  const report = await scanPath(root);
  const diagnostics = report.diagnostics.filter((item) => item.rule === "react-luau/no-static-name-prop");
  assert.deepEqual(diagnostics.map((item) => item.location.line), [5, 6, 7, 8, 9]);
});

test("accepts binding-driven animation with owned cleanup", async () => {
  const ids = await ruleIds("good-component.luau");
  assert.equal(ids.has("react-luau/prefer-binding-over-state"), false);
  assert.equal(ids.has("react-luau/effect-needs-cleanup"), false);
  assert.equal(ids.has("react-luau/rules-of-hooks"), false);
});


test("recognizes aliases, assigned custom hooks, and memo-wrapped components", async () => {
  const ids = await ruleIds("valid-patterns.luau");
  assert.equal(ids.has("react-luau/rules-of-hooks"), false);
  assert.equal(ids.has("react-luau/exhaustive-deps"), false);
});


test("finds state, effect, identity, and lifecycle issues", async () => {
  const ids = await ruleIds("advanced-issues.luau");
  const expected = [
    "react-luau/no-set-state-in-render",
    "react-luau/no-create-context-in-render",
    "react-luau/no-random-key",
    "react-luau/no-nested-component-definition",
    "react-luau/no-derived-state-effect",
    "react-luau/no-self-updating-effect",
    "react-luau/no-effect-with-fresh-deps",
    "react-luau/no-mutable-in-deps",
    "react-luau/rerender-functional-setstate",
    "react-luau/rerender-lazy-state-init",
    "react-luau/rerender-lazy-ref-init",
    "react-luau/rerender-state-only-in-handlers",
    "react-luau/no-direct-state-mutation",
    "react-luau/no-ref-current-in-render",
    "react-luau/no-create-root-in-render",
  ];

  for (const rule of expected) assert.ok(ids.has(rule), `expected ${rule}`);
});

test("self-updating effects catch guaranteed no-deps render loops without flagging convergent updates", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-self-updating-no-deps-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "InfiniteTable.luau"), `local React = require(script.Parent.React)
local function InfiniteTable()
  local state, setState = React.useState({})
  React.useEffect(function()
    setState({})
  end)
  return React.createElement("Frame", { Name = tostring(state) })
end
return InfiniteTable
`);

  fs.writeFileSync(path.join(root, "InfiniteArithmetic.luau"), `local React = require(script.Parent.React)
local function InfiniteArithmetic()
  local count, setCount = React.useState(0)
  React.useEffect(function()
    setCount(count + 1)
  end)
  return React.createElement("Frame", { Name = tostring(count) })
end
return InfiniteArithmetic
`);

  fs.writeFileSync(path.join(root, "InfiniteUpdater.luau"), `local React = require(script.Parent.React)
local function InfiniteUpdater()
  local count, setCount = React.useState(0)
  React.useEffect(function()
    setCount(function(previous)
      return previous + 1
    end)
  end)
  return React.createElement("Frame", { Name = tostring(count) })
end
return InfiniteUpdater
`);

  fs.writeFileSync(path.join(root, "InfiniteExplicitNil.luau"), `local React = require(script.Parent.React)
local function InfiniteExplicitNil()
  local items, setItems = React.useState({})
  React.useLayoutEffect(function()
    setItems(table.clone(items))
  end, nil)
  return React.createElement("Frame", { Name = tostring(items) })
end
return InfiniteExplicitNil
`);

  fs.writeFileSync(path.join(root, "Convergent.luau"), `local React = require(script.Parent.React)
local function Convergent(props)
  local count, setCount = React.useState(0)
  React.useEffect(function()
    setCount(props.count)
  end)
  return React.createElement("Frame", { Name = tostring(count) })
end
return Convergent
`);

  fs.writeFileSync(path.join(root, "Guarded.luau"), `local React = require(script.Parent.React)
local function Guarded()
  local count, setCount = React.useState(0)
  React.useEffect(function()
    if count < 1 then
      setCount(count + 1)
    end
  end)
  return React.createElement("Frame", { Name = tostring(count) })
end
return Guarded
`);

  fs.writeFileSync(path.join(root, "MountOnly.luau"), `local React = require(script.Parent.React)
local function MountOnly()
  local state, setState = React.useState({})
  React.useEffect(function()
    setState({})
  end, {})
  return React.createElement("Frame", { Name = tostring(state) })
end
return MountOnly
`);

  const report = await scanPath(root);
  const selfUpdates = report.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/no-self-updating-effect");
  const files = new Set(selfUpdates.map((diagnostic) => diagnostic.file));
  assert.deepEqual(files, new Set([
    "InfiniteArithmetic.luau",
    "InfiniteExplicitNil.luau",
    "InfiniteTable.luau",
    "InfiniteUpdater.luau",
  ]));
});

test("accepts stable identities, functional updates, lazy state, bindings, and deterministic cleanup", async () => {
  const ids = await ruleIds("advanced-valid.luau");
  const forbidden = [
    "react-luau/no-set-state-in-render",
    "react-luau/no-create-context-in-render",
    "react-luau/no-random-key",
    "react-luau/no-nested-component-definition",
    "react-luau/no-derived-state-effect",
    "react-luau/no-self-updating-effect",
    "react-luau/no-effect-with-fresh-deps",
    "react-luau/no-mutable-in-deps",
    "react-luau/rerender-functional-setstate",
    "react-luau/rerender-lazy-state-init",
    "react-luau/rerender-lazy-ref-init",
    "react-luau/rerender-state-only-in-handlers",
    "react-luau/no-direct-state-mutation",
    "react-luau/no-ref-current-in-render",
    "react-luau/no-create-root-in-render",
    "react-luau/prefer-binding-over-state",
    "react-luau/effect-needs-cleanup",
    "react-luau/exhaustive-deps",
  ];

  for (const rule of forbidden) assert.equal(ids.has(rule), false, `did not expect ${rule}`);
});


test("reports Luau parse errors before downstream analysis", async () => {
  const ids = await ruleIds("syntax-error.luau");
  assert.ok(ids.has("react-luau/parse-error"));
});


test("effect cleanup recognizes named cleanup functions and Maid-style ownership", async () => {
  const ids = await ruleIds("cleanup-patterns.luau");
  assert.equal(ids.has("react-luau/effect-needs-cleanup"), false);
});


test("effect cleanup recognizes destroying a proven Instance as connection cleanup", async () => {
  const ids = await ruleIds("instance-destroy-cleanup.luau");
  assert.equal(ids.has("react-luau/effect-needs-cleanup"), false);
});


test("effect cleanup does not assume arbitrary Destroy methods own Roblox event connections", async () => {
  const ids = await ruleIds("instance-destroy-unproven.luau");
  assert.ok(ids.has("react-luau/effect-needs-cleanup"));
});


test("dependency analysis respects nested shadowing and hook bindings are scoped per function", async () => {
  const ids = await ruleIds("scope-valid.luau");
  assert.equal(ids.has("react-luau/exhaustive-deps"), false);
  assert.equal(ids.has("react-luau/no-mutable-in-deps"), false);
});

test("dependency analysis ignores generic and annotation-only type identifiers", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-deps-types-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "TypedHook.luau"), `local React = require(script.Parent.React)

local function useTypedMemo<T>(value: T)
	local callback = React.useCallback(function(nextValue: T): T
		return nextValue
	end, {})

	return React.useMemo(function(): T
		local copy = value :: T
		callback(copy)
		return copy
	end, { value, callback })
end

return useTypedMemo
`);

  const report = await scanPath(root);
  const diagnostics = report.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/exhaustive-deps");
  assert.equal(diagnostics.length, 0);
});

test("dependency tables recognize immutable transparent aliases", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-dependency-aliases-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Alias.luau"), `local React = require(script.Parent.React)

local function Alias(props)
	local store = props.store
	React.useMemo(function()
		return props.store:getState()
	end, { store })
end

return Alias
`);

  fs.writeFileSync(path.join(root, "AliasChain.luau"), `local React = require(script.Parent.React)

local function AliasChain(props)
	local source = props
	local store = source.store
	React.useMemo(function()
		return props.store:getState()
	end, { store })
end

return AliasChain
`);

  fs.writeFileSync(path.join(root, "MutableAlias.luau"), `local React = require(script.Parent.React)

local function MutableAlias(props)
	local store = props.store
	store = props.otherStore
	React.useMemo(function()
		return props.store:getState()
	end, { store })
end

return MutableAlias
`);

  fs.writeFileSync(path.join(root, "DerivedValue.luau"), `local React = require(script.Parent.React)

local function DerivedValue(props)
	local hasStore = props.store ~= nil
	React.useMemo(function()
		return props.store
	end, { hasStore })
end

return DerivedValue
`);

  const report = await scanPath(root);
  const diagnostics = report.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/exhaustive-deps");
  assert.equal(diagnostics.some((diagnostic) => diagnostic.file === "Alias.luau"), false);
  assert.equal(diagnostics.some((diagnostic) => diagnostic.file === "AliasChain.luau"), false);

  const mutable = diagnostics.find((diagnostic) => diagnostic.file === "MutableAlias.luau");
  assert.match(mutable?.message ?? "", /missing props\.store/);

  const derived = diagnostics.find((diagnostic) => diagnostic.file === "DerivedValue.luau");
  assert.match(derived?.message ?? "", /missing props\.store/);
});

test("dependency tables normalize transparent casts and optional false sentinels", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-dependency-normalization-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Normalized.luau"), `local React = require(script.Parent.React)

local function Normalized(plugin: Plugin, menu: PluginMenu?)
	React.useEffect(function()
		print(plugin, menu)
	end, { (plugin :: any), menu or false })
end

return Normalized
`);

  fs.writeFileSync(path.join(root, "UnsafeFallback.luau"), `local React = require(script.Parent.React)

local function UnsafeFallback(value, fallback)
	React.useEffect(function()
		print(value)
	end, { value or fallback })
end

return UnsafeFallback
`);

  const report = await scanPath(root);
  const diagnostics = report.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/exhaustive-deps");
  assert.equal(diagnostics.some((diagnostic) => diagnostic.file === "Normalized.luau"), false);

  const unsafe = diagnostics.find((diagnostic) => diagnostic.file === "UnsafeFallback.luau");
  assert.match(unsafe?.message ?? "", /missing value/);
});

test("does not treat arbitrary Add methods as cleanup ownership", async () => {
  const ids = await ruleIds("cleanup-manager-invalid.luau");
  assert.ok(ids.has("react-luau/effect-needs-cleanup"));
});



test("effect cleanup tracks outliving tasks and paired Roblox binding APIs", async () => {
  const valid = await scanPath(path.join(fixtures, "effect-lifetime-valid.luau"));
  assert.equal(valid.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/effect-needs-cleanup"), false);

  const invalid = await scanPath(path.join(fixtures, "effect-lifetime-invalid.luau"));
  const cleanupDiagnostics = invalid.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/effect-needs-cleanup");
  assert.equal(cleanupDiagnostics.length, 5);
  assert.ok(cleanupDiagnostics.some((diagnostic) => diagnostic.message.includes("yielding spawned task")));
  assert.ok(cleanupDiagnostics.some((diagnostic) => diagnostic.message.includes("deferred task")));
  assert.ok(cleanupDiagnostics.some((diagnostic) => diagnostic.message.includes("delayed task")));
  assert.ok(cleanupDiagnostics.some((diagnostic) => diagnostic.message.includes("activation binding")));
  assert.ok(cleanupDiagnostics.some((diagnostic) => diagnostic.message.includes("BindToSimulation connection")));
});


test("dependency analysis excludes mutable Roblox leaf values, refs, and bindings while keeping reactive identity", async () => {
  const report = await scanPath(path.join(fixtures, "deps-reactivity.luau"));
  const dependencyDiagnostics = report.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/exhaustive-deps");
  assert.equal(dependencyDiagnostics.length, 1);
  assert.match(dependencyDiagnostics[0].message, /props\.Instance/);
  assert.match(dependencyDiagnostics[0].message, /props\.value/);
  assert.doesNotMatch(dependencyDiagnostics[0].message, /CFrame|numberValue\.Value|numberValue\.Changed|ref\.current|binding/);
});


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

test("binding-over-state advice fires for host-property-only state and hook consumers", async () => {
  const report = await scanPath(path.join(fixtures, "binding-consumption.luau"));
  const diagnostics = report.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/prefer-binding-over-state");
  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.message.includes("position")));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.message.includes("Hook state size")));
  assert.equal(diagnostics.some((diagnostic) => diagnostic.message.includes("currentTime")), false);
  assert.equal(diagnostics.some((diagnostic) => diagnostic.message.includes("visible")), false);
});


test("binding-over-state recognizes imported custom hooks that return externally updated state", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-hook-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "BindingHookModule.luau"), `local React = require(script.Parent.React)
local RunService = game:GetService("RunService")

local function useTrackedHostValue()
	local value, setValue = React.useState(0)
	React.useEffect(function()
		local connection = RunService.RenderStepped:Connect(function(dt)
			setValue(dt)
		end)
		return function()
			connection:Disconnect()
		end
	end, {})
	return value
end

return useTrackedHostValue
`);

  fs.writeFileSync(path.join(root, "Consumer.luau"), `local React = require(script.Parent.React)
local useTrackedHostValue = require(script.Parent.BindingHookModule)

local function Consumer()
	local value = useTrackedHostValue()
	return React.createElement("Frame", {
		Rotation = value,
	})
end

return Consumer
`);

  const report = await scanPath(root);
  const diagnostics = report.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/prefer-binding-over-state");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].file, "Consumer.luau");
  assert.match(diagnostics[0].message, /useTrackedHostValue returns state updated from a high-frequency source/);
});

test("yield-in-render requires Roblox receiver provenance and ignores opaque lookalikes", async () => {
  const report = await scanPath(path.join(fixtures, "yielding-engine-apis.luau"));
  const diagnostics = report.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/no-yield-in-render");
  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.message.includes("GetAsync")));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.message.includes("PreloadAsync")));
  assert.equal(diagnostics.some((diagnostic) => diagnostic.message.includes("DoAsync")), false);
  assert.equal(diagnostics.some((diagnostic) => diagnostic.message.includes("props.cache:GetAsync")), false);
});

test("diagnostic ids are deterministic across scans", async () => {
  const file = path.join(fixtures, "advanced-issues.luau");
  const first = await scanPath(file);
  const second = await scanPath(file);
  assert.deepEqual(
    first.diagnostics.map((diagnostic) => diagnostic.id),
    second.diagnostics.map((diagnostic) => diagnostic.id),
  );
});

test("configuration can disable rules and override severities", async () => {
  const file = path.join(fixtures, "bad-component.luau");
  const report = await scanPath(file, {
    config: {
      rules: {
        "react-luau/no-prop-mutation": "off",
        "react-luau/no-array-index-as-key": "error",
      },
    },
  });

  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/no-prop-mutation"), false);
  assert.equal(
    report.diagnostics.find((diagnostic) => diagnostic.rule === "react-luau/no-array-index-as-key")?.severity,
    "error",
  );
});



test("directory scans skip non-React Luau files automatically", async () => {
  const report = await scanPath(fixtures);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.file === "non-react-module.luau"), false);
  assert.equal(report.scannedFiles, 25);
});


test("handles large-codebase React-Luau patterns without known false positives", async () => {
  const report = await scanPath(path.join(fixtures, "large-codebase-regressions.luau"));
  const diagnostics = report.diagnostics;
  const ids = new Set(diagnostics.map((diagnostic) => diagnostic.rule));

  assert.equal(ids.has("react-luau/parse-error"), false);
  assert.equal(ids.has("react-luau/rules-of-hooks"), false);
  assert.equal(ids.has("react-luau/effect-needs-cleanup"), false);
  assert.equal(ids.has("react-luau/no-side-effects-in-render"), false);
  assert.equal(ids.has("react-luau/no-task-spawn-in-render"), false);
  assert.equal(ids.has("react-luau/no-array-index-as-key"), false);
  assert.equal(ids.has("react-luau/no-direct-state-mutation"), false);
  assert.equal(ids.has("react-luau/rerender-lazy-state-init"), false);
  assert.equal(ids.has("react-luau/rerender-lazy-ref-init"), false);

  assert.equal(
    diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/prefer-binding-over-state").length,
    1,
  );
});


test("accepts modern Luau const, export-by-value, attributes, type functions, explicit type arguments, and integer literals", async () => {
  const report = await scanPath(path.join(fixtures, "modern-luau-syntax.luau"));
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/parse-error"), false);
  assert.equal(report.scannedFiles, 1);
  const propMutation = report.diagnostics.find((diagnostic) => diagnostic.rule === "react-luau/no-prop-mutation");
  assert.equal(propMutation?.location.line, 31);
  assert.equal(propMutation?.location.column, 2);
});

test("scan progress advances across every candidate file", async () => {
  const progress: Array<{ current: number; total: number; partial?: boolean }> = [];
  const report = await scanPath(fixtures, {
    cache: false,
    onProgress(value) {
      progress.push(value);
    },
  });

  assert.equal(progress[0]?.current, 0);
  assert.equal(progress[0]?.total, report.candidateFiles);
  assert.equal(progress.at(-1)?.current, report.candidateFiles);
  assert.equal(progress.at(-1)?.total, report.candidateFiles);
});

test("parallel effect parsing reports progress for each completed file", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-parse-progress-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fileCount = 24;
  for (let index = 0; index < fileCount; index += 1) {
    fs.writeFileSync(path.join(root, `Component${index}.luau`), `local React = require(script.Parent.React)
local function Component()
  return React.createElement("Frame")
end
return Component
`);
  }
  const progress: Array<{ current: number; total: number; file?: string }> = [];
  const report = await scanPath(root, {
    cache: false,
    parallel: true,
    onProgress(value) {
      if (value.phase === "effects-parse") progress.push(value);
    },
  });

  assert.equal(report.scannedFiles, fileCount);
  assert.deepEqual([...new Set(progress.map((value) => value.current))],
    Array.from({ length: fileCount + 1 }, (_, index) => index));
  assert.ok(progress.every((value) => value.total === fileCount));
  assert.equal(new Set(progress.filter((value) => value.current > 0 && value.file).map((value) => value.file)).size,
    fileCount);
});

test("project effect progress continues through graph finalization after source parsing completes", async () => {
  const progress: Array<{ phase?: string; label?: string; current: number; total: number }> = [];
  await scanPath(fixtures, {
    cache: false,
    onProgress(value) {
      progress.push(value);
    },
  });

  const parseComplete = progress.findIndex(
    (value) => value.phase === "effects-parse" && value.total > 0 && value.current === value.total,
  );
  const functionIndexStart = progress.findIndex((value) => value.phase === "effects-index-functions");
  const callAnalysisStart = progress.findIndex((value) => value.phase === "effects-analyze-calls");
  const graphAssemblyStart = progress.findIndex((value) => value.phase === "effects-assemble-graph");
  const resolveStart = progress.findIndex((value) => value.phase === "effects-resolve");
  const propagateStart = progress.findIndex((value) => value.phase === "effects-propagate");
  const summarizeStart = progress.findIndex((value) => value.phase === "effects-summarize");

  assert.ok(parseComplete >= 0, "expected source-effect parsing to complete");
  assert.ok(functionIndexStart > parseComplete, "function indexing should become visible immediately after parsing");
  assert.ok(callAnalysisStart > functionIndexStart, "source call analysis should be a distinct visible phase");
  assert.ok(graphAssemblyStart > callAnalysisStart, "effect graph assembly should be a distinct visible phase");
  assert.ok(resolveStart > graphAssemblyStart, "dependency linking should follow graph assembly");
  assert.ok(propagateStart > resolveStart, "effect propagation should be a distinct visible phase");
  assert.ok(summarizeStart > propagateStart, "effect finalization should remain visible before React scanning");
  assert.equal(progress[functionIndexStart].label, "Indexing effect functions");
  assert.equal(progress[callAnalysisStart].label, "Resolving effect calls");
  assert.equal(progress[graphAssemblyStart].label, "Building effect graph");
  assert.equal(progress[resolveStart].label, "Linking effect dependencies");
  assert.equal(progress[propagateStart].label, "Propagating project effects");
  assert.equal(progress[summarizeStart].label, "Finalizing project effects");
});

test("inline suppressions can hide exact rules and audit mode can ignore suppressions", async () => {
  const file = path.join(fixtures, "inline-disables.luau");
  const normal = await scanPath(file);
  const audit = await scanPath(file, { respectInlineDisables: false });

  const normalPropMutations = normal.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/no-prop-mutation");
  const auditPropMutations = audit.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/no-prop-mutation");

  assert.equal(normalPropMutations.length, 1);
  assert.equal(normalPropMutations[0].location.line, 13);
  assert.equal(auditPropMutations.length, 3);
});

test("dynamic unpack dependency tables are reported as partial-analysis suggestions", async () => {
  const report = await scanPath(path.join(fixtures, "deps-advanced-confidence.luau"));
  const diagnostics = report.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/exhaustive-deps");
  const dynamic = diagnostics.find((diagnostic) => diagnostic.message.includes("dynamic unpack"));

  assert.equal(dynamic?.severity, "suggestion");
  assert.doesNotMatch(dynamic?.message ?? "", /missing callback|missing bindings/);
});

test("memoized values with covered producer dependencies become suggestions instead of stale-value warnings", async () => {
  const report = await scanPath(path.join(fixtures, "deps-advanced-confidence.luau"));
  const diagnostics = report.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/exhaustive-deps");
  const covered = diagnostics.find((diagnostic) => diagnostic.message.includes("memoized value") && diagnostic.message.includes("memoizedCallback"));
  const actuallyMissing = diagnostics.find((diagnostic) => diagnostic.message.includes("missing memoizedValue"));

  assert.equal(covered?.severity, "suggestion");
  assert.match(covered?.message ?? "", /memoizedCallback/);
  assert.equal(actuallyMissing?.severity, "warning");
});

test("effect cleanup downgrades low-risk one-shot scheduled work but keeps outliving tasks as warnings", async () => {
  const report = await scanPath(path.join(fixtures, "effect-lifetime-invalid.luau"));
  const diagnostics = report.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/effect-needs-cleanup");

  const deferred = diagnostics.find((diagnostic) => diagnostic.message.includes("deferred task"));
  assert.equal(deferred?.severity, "suggestion");
  assert.doesNotMatch(deferred?.help ?? "", /suggestion|warning/i);
  assert.equal(diagnostics.find((diagnostic) => diagnostic.message.includes("yielding spawned task"))?.severity, "warning");
  assert.equal(diagnostics.find((diagnostic) => diagnostic.message.includes("delayed task"))?.severity, "warning");
});


test("dependency analysis expands pure derived locals to their reactive inputs", async () => {
  const report = await scanPath(path.join(fixtures, "deps-advanced-confidence.luau"));
  const diagnostics = report.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/exhaustive-deps");

  assert.equal(diagnostics.some((diagnostic) => /derivedValue|\bh\b|\bs\b/.test(diagnostic.message)), false);
  const derivedMissing = diagnostics.find((diagnostic) => diagnostic.message.includes("props.total"));
  assert.equal(derivedMissing?.severity, "warning");
  assert.doesNotMatch(derivedMissing?.message ?? "", /isComplete/);
});


test("render-computed refs used only by later callbacks are suggestions, while render-read ref writes remain warnings", async () => {
  const report = await scanPath(path.join(fixtures, "ref-mirror-patterns.luau"));
  const diagnostics = report.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/no-ref-current-in-render");

  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics.find((diagnostic) => diagnostic.message.includes("mirrored.current"))?.severity, "suggestion");
  assert.equal(diagnostics.find((diagnostic) => diagnostic.message.includes("imperative.current"))?.severity, "warning");
});

test("finds high-confidence React-Luau performance patterns", async () => {
  const ids = await ruleIds("performance-issues.luau");
  const expected = [
    "react-luau/rerender-unstable-memo-props",
    "react-luau/rerender-high-frequency-state",
    "react-luau/rerender-unnecessary-usememo",
    "react-luau/rerender-unnecessary-usecallback",
    "react-luau/rerender-static-discovery-in-render",
    "react-luau/rerender-repeated-collection-scan",
    "react-luau/rerender-static-state",
    "react-luau/prefer-use-ref-for-mutable-cell",
  ];
  for (const rule of expected) assert.ok(ids.has(rule), `expected ${rule}`);
});

test("diagnostics keep primary spans focused and preserve precise evidence for container findings", async () => {
  const report = await scanPath(fixtures);
  const multiline = report.diagnostics.filter((diagnostic) => diagnostic.location.line !== diagnostic.location.endLine);
  assert.deepEqual(multiline.map((diagnostic) => `${diagnostic.rule}@${diagnostic.file}:${diagnostic.location.line}-${diagnostic.location.endLine}`), []);

  const memoProps = report.diagnostics.find((diagnostic) =>
    diagnostic.file === "performance-issues.luau" && diagnostic.rule === "react-luau/rerender-unstable-memo-props"
  );
  assert.ok(memoProps);
  assert.deepEqual(memoProps.highlights?.map((location) => location.line), [37, 38]);
  assert.equal(memoProps.location.line, 37);

  const cleanup = report.diagnostics.find((diagnostic) =>
    diagnostic.file === "bad-component.luau" && diagnostic.rule === "react-luau/effect-needs-cleanup"
  );
  assert.ok((cleanup?.highlights?.length ?? 0) > 0);
});

test("performance findings with real runtime cost are warnings", async () => {
  const report = await scanPath(fixtures);
  const diagnostics = report.diagnostics.filter((diagnostic) => diagnostic.file === "performance-issues.luau");
  const warningRules = [
    "react-luau/rerender-unstable-memo-props",
    "react-luau/rerender-high-frequency-state",
    "react-luau/rerender-unnecessary-usememo",
    "react-luau/rerender-unnecessary-usecallback",
    "react-luau/rerender-static-discovery-in-render",
    "react-luau/rerender-repeated-collection-scan",
    "react-luau/rerender-static-state",
  ];

  for (const rule of warningRules) {
    const matches = diagnostics.filter((diagnostic) => diagnostic.rule === rule);
    assert.ok(matches.length > 0, `expected ${rule}`);
    assert.ok(matches.every((diagnostic) => diagnostic.severity === "warning"), `${rule} should be warning severity`);
  }

  const mutableCell = diagnostics.find((diagnostic) => diagnostic.rule === "react-luau/prefer-use-ref-for-mutable-cell");
  assert.equal(mutableCell?.severity, "suggestion");
  assert.equal(mutableCell?.category, "Hooks");
});

test("performance rules stay conservative around identity, guarded frame state, and memoized discovery", async () => {
  const ids = await ruleIds("performance-valid.luau");
  const forbidden = [
    "react-luau/rerender-unstable-memo-props",
    "react-luau/rerender-high-frequency-state",
    "react-luau/rerender-unnecessary-usememo",
    "react-luau/rerender-unnecessary-usecallback",
    "react-luau/rerender-static-discovery-in-render",
    "react-luau/rerender-repeated-collection-scan",
    "react-luau/rerender-static-state",
    "react-luau/prefer-use-ref-for-mutable-cell",
  ];
  for (const rule of forbidden) assert.equal(ids.has(rule), false, `did not expect ${rule}`);
});

test("project-aware memo analysis still resolves unchanged memoized modules in scoped file scans", async () => {
  const file = path.join(fixtures, "performance-issues.luau");
  const report = await scanPath(fixtures, {
    files: [{ absolutePath: file, relativePath: "performance-issues.luau" }],
  });
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rerender-unstable-memo-props"));
});


test("project-aware memo analysis does not confuse overlapping module names", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-module-collision-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Director.luau"), `local React = require(script.Parent.React)
local Director = React.memo(function()
	return React.createElement("Frame")
end)
return Director
`);
  fs.writeFileSync(path.join(root, "ReplayDirector.luau"), `local React = require(script.Parent.React)
local function ReplayDirector(props)
	return React.createElement("Frame")
end
return ReplayDirector
`);
  fs.writeFileSync(path.join(root, "Consumer.luau"), `local React = require(script.Parent.React)
local ReplayDirector = require(script.Parent.ReplayDirector)
local function Consumer()
	return React.createElement(ReplayDirector, {
		config = {},
	})
end
return Consumer
`);

  const report = await scanPath(root);
  assert.equal(
    report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rerender-unstable-memo-props"),
    false,
  );
});


test("binding candidate surfaces measurement effects that only derive presentation state", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-measurement-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useObservedGuiMetric.luau"), `local React = require(script.Parent.React)
local function useObservedGuiMetric(targetRef, observedKey)
	local value, setValue = React.useState(nil)
	React.useEffect(function()
		local instance = targetRef.current
		if not instance then return end
		local function update()
			setValue(instance[observedKey])
		end
		local connection = instance:GetPropertyChangedSignal(observedKey):Connect(update)
		update()
		return function() connection:Disconnect() end
	end, { targetRef, observedKey })
	return value
end
return useObservedGuiMetric
`);

  fs.writeFileSync(path.join(root, "Consumer.luau"), `local React = require(script.Parent.React)
local useObservedGuiMetric = require(script.Parent.useObservedGuiMetric)
local function Consumer()
	local ref = React.useRef(nil)
	local measuredSize = useObservedGuiMetric(ref, "AbsoluteSize")
	local size, setSize = React.useState(UDim2.fromOffset(0, 0))
	React.useEffect(function()
		if measuredSize then
			setSize(UDim2.fromOffset(measuredSize.X, measuredSize.Y))
		end
	end, { measuredSize })
	return React.createElement("Frame", { ref = ref, Size = size })
end
return Consumer
`);

  const report = await scanPath(root);
  assert.equal(
    report.diagnostics.some((entry) => entry.file === "Consumer.luau" && entry.rule === "react-luau/prefer-binding-over-state"),
    false,
  );
  const candidate = report.diagnostics.find(
    (entry) => entry.file === "Consumer.luau" && entry.rule === "react-luau/prefer-binding-over-state-candidate",
  );
  assert.ok(candidate);
  assert.match(candidate.message, /effect only derives presentation state or Bindings/);
});

test("binding-over-state keeps measurement state when an effect performs behavioral work", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-measurement-behavior-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useObservedGuiMetric.luau"), `local React = require(script.Parent.React)
local function useObservedGuiMetric(targetRef, observedKey)
  local value, setValue = React.useState(nil)
  React.useEffect(function()
    local instance = targetRef.current
    if not instance then return end
    local function update()
      setValue(instance[observedKey])
    end
    local connection = instance:GetPropertyChangedSignal(observedKey):Connect(update)
    update()
    return function() connection:Disconnect() end
  end, { targetRef, observedKey })
  return value
end
return useObservedGuiMetric
`);

  fs.writeFileSync(path.join(root, "Consumer.luau"), `local React = require(script.Parent.React)
local useObservedGuiMetric = require(script.Parent.useObservedGuiMetric)
local function Consumer(props)
  local ref = React.useRef(nil)
  local measuredSize = useObservedGuiMetric(ref, "AbsoluteSize")
  React.useEffect(function()
    if measuredSize then
      props.onMeasured(measuredSize)
    end
  end, { measuredSize, props.onMeasured })
  return React.createElement("Frame", { ref = ref })
end
return Consumer
`);

  const report = await scanPath(root);
  assert.equal(
    report.diagnostics.some((entry) => entry.file === "Consumer.luau" && entry.rule.startsWith("react-luau/prefer-binding-over-state")),
    false,
  );
});

test("binding-over-state infers dual-mode measurement hooks and skips calls already using binding mode", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-dual-mode-measurement-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useObservedMetric.luau"), `local React = require(script.Parent.React)
local function useObservedMetric(targetRef, observedKey, dependencies, preferBinding: boolean?)
	local value, updateValue
	if preferBinding then
		value, updateValue = React.useBinding(nil)
	else
		value, updateValue = React.useState(nil)
	end
	React.useEffect(function()
		local instance = targetRef.current
		if not instance then return end
		local function update()
			updateValue(instance[observedKey])
		end
		local connection = instance:GetPropertyChangedSignal(observedKey):Connect(update)
		update()
		return function() connection:Disconnect() end
	end, { targetRef, observedKey, unpack(dependencies or {}) })
	return value
end
return useObservedMetric
`);

  fs.writeFileSync(path.join(root, "StateConsumer.luau"), `local React = require(script.Parent.React)
local useObservedMetric = require(script.Parent.useObservedMetric)
local function StateConsumer()
	local ref = React.useRef(nil)
	local measuredSize = useObservedMetric(ref, "AbsoluteSize")
	return React.createElement("Frame", { ref = ref, Size = measuredSize or UDim2.fromOffset(0, 0) })
end
return StateConsumer
`);

  fs.writeFileSync(path.join(root, "BindingConsumer.luau"), `local React = require(script.Parent.React)
local useObservedMetric = require(script.Parent.useObservedMetric)
local function BindingConsumer()
	local ref = React.useRef(nil)
	local measuredSize = useObservedMetric(ref, "AbsoluteSize", {}, true)
	return React.createElement("Frame", { ref = ref, Size = measuredSize })
end
return BindingConsumer
`);

  const report = await scanPath(root);
  const diagnostics = report.diagnostics.filter((entry) => entry.rule === "react-luau/prefer-binding-over-state");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].file, "StateConsumer.luau");
  assert.match(diagnostics[0].message, /AbsoluteSize/);
});

test("binding-over-state keeps semantic external snapshots in React state", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-snapshot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useSnapshot.luau"), `local React = require(script.Parent.React)
local function useSnapshot(replicator)
	local state, setState = React.useState(nil)
	React.useEffect(function()
		local connection = replicator.Changed:Connect(function()
			setState(table.clone(replicator.State))
		end)
		setState(replicator.State)
		return function() connection:Disconnect() end
	end, { replicator })
	return state
end
return useSnapshot
`);

  fs.writeFileSync(path.join(root, "Consumer.luau"), `local React = require(script.Parent.React)
local useSnapshot = require(script.Parent.useSnapshot)
local function Consumer(props)
	local snapshot = useSnapshot(props.replicator)
	local text = snapshot and snapshot.Ammo or 0
	return React.createElement("TextLabel", { Text = text })
end
return Consumer
`);

  const report = await scanPath(root);
  assert.equal(
    report.diagnostics.some((entry) => entry.file === "Consumer.luau" && entry.rule.startsWith("react-luau/prefer-binding-over-state")),
    false,
  );
});

test("binding candidate recognizes explicit state-to-binding API alternatives without upgrading semantic state to a warning", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-client-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "VisualState.luau"), `local VisualState = {}
function VisualState:GetReactState(selector)
	return nil
end
function VisualState:GetReactBinding(selector)
	return nil
end
return VisualState
`);

  fs.writeFileSync(path.join(root, "Consumer.luau"), `local React = require(script.Parent.React)
local VisualState = require(script.Parent.VisualState)
local function Consumer()
	local transparency = VisualState:GetReactState(function(state)
		return state.transparency
	end)
	local enabled = VisualState:GetReactState(function(state)
		return state.enabled
	end)
	local mixed = VisualState:GetReactState(function(state)
		return state.mixed
	end)
	return React.createElement("Frame", {
		BackgroundTransparency = transparency,
		Rotation = mixed,
	}, {
		child = enabled and React.createElement("Frame") or nil,
		mixedChild = mixed > 0 and React.createElement("Frame") or nil,
	})
end
return Consumer
`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((entry) => entry.rule === "react-luau/prefer-binding-over-state"), false);
  const candidates = report.diagnostics.filter((entry) => entry.rule === "react-luau/prefer-binding-over-state-candidate");
  assert.equal(candidates.length, 1);
  assert.match(candidates[0].message, /GetReactBinding/);
  assert.match(candidates[0].message, /transparency/);
  assert.doesNotMatch(candidates[0].message, /mixed/);
});

test("binding-over-state does not invent a binding alternative from a method name alone", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-no-alternative-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "StateStore.luau"), `local StateStore = {}
function StateStore:GetReactState(selector)
	return nil
end
return StateStore
`);
  fs.writeFileSync(path.join(root, "Consumer.luau"), `local React = require(script.Parent.React)
local StateStore = require(script.Parent.StateStore)
local function Consumer()
	local rotation = StateStore:GetReactState(function(state) return state.rotation end)
	return React.createElement("Frame", { Rotation = rotation })
end
return Consumer
`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((entry) => entry.rule === "react-luau/prefer-binding-over-state"), false);
});

test("binding candidate surfaces arbitrary external mirrors without calling them high-frequency", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-callback-wrapper-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useSignalBridge.luau"), `local React = require(script.Parent.React)
local function useSignalBridge(event, handler: (...any) -> (), dependencies)
	React.useEffect(function()
		local connection = event:Connect(handler)
		return function() connection:Disconnect() end
	end, dependencies)
end
return useSignalBridge
`);
  fs.writeFileSync(path.join(root, "Consumer.luau"), `local React = require(script.Parent.React)
local useSignalBridge = require(script.Parent.useSignalBridge)
local function Consumer(props)
	local position, setPosition = React.useState(UDim2.fromOffset(0, 0))
	useSignalBridge(props.changed, function(nextPosition)
		setPosition(nextPosition)
	end, { props.changed })
	return React.createElement("Frame", { Position = position })
end
return Consumer
`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((entry) => entry.rule === "react-luau/prefer-binding-over-state"), false);
  const candidate = report.diagnostics.find((entry) => entry.rule === "react-luau/prefer-binding-over-state-candidate");
  assert.ok(candidate);
  assert.match(candidate.message, /external reactive value/);
});

test("React namespace detection supports aliased relative-string requires", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-react-alias-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Consumer.luau"), `local R = require("../../React")
local function Consumer()
	local count, setCount = R.useState(0)
	setCount(count + 1)
	return R.createElement("Frame")
end
return Consumer
`);

  const report = await scanPath(root);
  assert.equal(report.scannedFiles, 1);
  assert.ok(report.diagnostics.some((entry) => entry.rule === "react-luau/no-set-state-in-render"));
});

test("binding-over-state keeps arbitrary named signal state and structural high-frequency state", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-named-callback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Consumer.luau"), `local React = require(script.Parent.React)
local RunService = game:GetService("RunService")
local function Consumer(props)
	local position, setPosition = React.useState(UDim2.fromOffset(0, 0))
	local hoverResizeEdge, setHoverResizeEdge = React.useState(nil)
	React.useEffect(function()
		local function update()
			setPosition(UDim2.fromOffset(1, 1))
		end
		local changed = props.signal:Connect(update)
		local heartbeat = RunService.Heartbeat:Connect(function()
			local nextEdge = nil
			if hoverResizeEdge ~= nextEdge then
				setHoverResizeEdge(nextEdge)
			end
		end)
		return function()
			changed:Disconnect()
			heartbeat:Disconnect()
		end
	end, { hoverResizeEdge })
	return React.createElement("Frame", { Position = position }, {
		child = hoverResizeEdge and React.createElement("Frame") or nil,
	})
end
return Consumer
`);

  const report = await scanPath(root);
  assert.equal(
    report.diagnostics.some((entry) => entry.rule.startsWith("react-luau/prefer-binding-over-state")),
    false,
  );
});

test("binding-over-state follows proven bindable props through custom components", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-component-prop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useObservedValue.luau"), `local React = require(script.Parent.React)
local RunService = game:GetService("RunService")
local function useObservedValue()
  local value, setValue = React.useState(0)
  React.useEffect(function()
    local connection = RunService.RenderStepped:Connect(setValue)
    return function() connection:Disconnect() end
  end, {})
  return value
end
return useObservedValue
`);

  fs.writeFileSync(path.join(root, "VisualFrame.luau"), `local React = require(script.Parent.React)
local function VisualFrame(props)
  return React.createElement("Frame", { Rotation = props.rotation })
end
return VisualFrame
`);

  fs.writeFileSync(path.join(root, "Consumer.luau"), `local React = require(script.Parent.React)
local useObservedValue = require(script.Parent.useObservedValue)
local VisualFrame = require(script.Parent.VisualFrame)
local function Consumer()
  local rotation = useObservedValue()
  return React.createElement(VisualFrame, { rotation = rotation })
end
return Consumer
`);

  const report = await scanPath(root);
  const warnings = report.diagnostics.filter((entry) => entry.rule === "react-luau/prefer-binding-over-state");
  const candidates = report.diagnostics.filter((entry) => entry.rule === "react-luau/prefer-binding-over-state-candidate");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].file, "Consumer.luau");
  assert.equal(candidates.length, 0);
});

test("binding-over-state does not prove custom props binding-compatible through nested callbacks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-nested-prop-callback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Child.luau"), `local React = require(script.Parent.React)
local function Child(props)
  local base = React.useBinding(0)
  return React.createElement("Frame", { Size = props.Size }, {
    inner = React.createElement("Frame", {
      Position = base:map(function()
        return UDim2.fromOffset(props.Size.X.Offset, 0)
      end),
    }),
  })
end
return Child
`);

  fs.writeFileSync(path.join(root, "Consumer.luau"), `local React = require(script.Parent.React)
local RunService = game:GetService("RunService")
local Child = require(script.Parent.Child)
local function Consumer()
  local size, setSize = React.useState(UDim2.fromOffset(0, 0))
  React.useEffect(function()
    local connection = RunService.RenderStepped:Connect(function(dt)
      setSize(UDim2.fromOffset(dt, 0))
    end)
    return function() connection:Disconnect() end
  end, {})
  return React.createElement(Child, { Size = size })
end
return Consumer
`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((entry) => entry.rule === "react-luau/prefer-binding-over-state"), false);
  assert.equal(report.diagnostics.some((entry) => entry.rule === "react-luau/prefer-binding-over-state-candidate"), false);
});

test("binding candidate rule ignores analyzed structural custom-component consumers", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-candidate-component-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useObservedValue.luau"), `local React = require(script.Parent.React)
local RunService = game:GetService("RunService")
local function useObservedValue()
  local value, setValue = React.useState(0)
  React.useEffect(function()
    local connection = RunService.RenderStepped:Connect(setValue)
    return function() connection:Disconnect() end
  end, {})
  return value
end
return useObservedValue
`);

  fs.writeFileSync(path.join(root, "StructuralThing.luau"), `local React = require(script.Parent.React)
local function StructuralThing(props)
  return React.createElement("Frame", nil, {
    child = props.rotation > 0 and React.createElement("Frame") or nil,
  })
end
return StructuralThing
`);

  fs.writeFileSync(path.join(root, "Consumer.luau"), `local React = require(script.Parent.React)
local useObservedValue = require(script.Parent.useObservedValue)
local StructuralThing = require(script.Parent.StructuralThing)
local function Consumer()
  local value = useObservedValue()
  return React.createElement(StructuralThing, { rotation = value })
end
return Consumer
`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((entry) => entry.rule === "react-luau/prefer-binding-over-state" && entry.file === "Consumer.luau"), false);
  assert.equal(report.diagnostics.some((entry) => entry.rule === "react-luau/prefer-binding-over-state-candidate" && entry.file === "Consumer.luau"), false);
});

test("binding candidate keeps unresolved visual custom props optional", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-unresolved-component-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Consumer.luau"), `local React = require(script.Parent.React)
local RunService = game:GetService("RunService")
local UnknownChild = require(script.Parent.UnknownChild)
local function Consumer()
  local rotation, setRotation = React.useState(0)
  React.useEffect(function()
    local connection = RunService.RenderStepped:Connect(setRotation)
    return function() connection:Disconnect() end
  end, {})
  return React.createElement(UnknownChild, { Rotation = rotation })
end
return Consumer
`);
  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((entry) => entry.rule === "react-luau/prefer-binding-over-state"), false);
  const candidate = report.diagnostics.find((entry) => entry.rule === "react-luau/prefer-binding-over-state-candidate");
  assert.ok(candidate);
  assert.equal(candidate.severity, "suggestion");
});

test("binding candidate follows derived measurements into memoized child effects", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-child-effect-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "useProperty.luau"), `local React = require(script.Parent.React)
local function useProperty(ref, propertyName, asBinding)
  local value, setValue
  if asBinding then
    value, setValue = React.useBinding(nil)
  else
    value, setValue = React.useState(nil)
  end
  React.useEffect(function()
    local instance = ref.current
    if not instance then return end
    local function update()
      setValue(instance[propertyName])
    end
    local connection = instance:GetPropertyChangedSignal(propertyName):Connect(update)
    update()
    return function() connection:Disconnect() end
  end, { ref, propertyName })
  return value
end
return useProperty
`);
  fs.writeFileSync(path.join(root, "MeasuredPanel.luau"), `local React = require(script.Parent.React)
local function MeasuredPanel(props)
  local width, setWidth = React.useState(0)
  React.useEffect(function()
    setWidth(props.Width)
  end, { props.Width })
  return React.createElement("Frame", { Size = UDim2.fromOffset(props.Width, 24) }, {
    indicator = React.createElement("Frame", { Size = UDim2.fromOffset(width, 4) }),
  })
end
return React.memo(MeasuredPanel)
`);
  const consumer = `local React = require(script.Parent.React)
local MeasuredPanel = require(script.Parent.MeasuredPanel)
local useProperty = require(script.Parent.useProperty)
local function Consumer()
  local ref = React.useRef(nil)
  local measuredSize = useProperty(ref, "AbsoluteSize") or Vector2.zero
  local paddedWidth = measuredSize.X + 8
  return React.createElement(MeasuredPanel, { Width = paddedWidth })
end
return Consumer
`;
  fs.writeFileSync(path.join(root, "Consumer.luau"), consumer);
  fs.writeFileSync(path.join(root, "MixedConsumer.luau"), consumer.replace(
    'return React.createElement(MeasuredPanel, { Width = paddedWidth })',
    `return React.createElement("Frame", { Size = UDim2.fromOffset(paddedWidth, 24) }, {
    panel = React.createElement(MeasuredPanel, { Width = paddedWidth }),
  })`,
  ));
  const report = await scanPath(root);
  const recommendations = report.diagnostics.filter((entry) => entry.rule.startsWith("react-luau/prefer-binding-over-state"));
  assert.equal(recommendations.some((entry) => entry.file === "Consumer.luau"), false);
  const mixed = recommendations.filter((entry) => entry.file === "MixedConsumer.luau");
  assert.equal(mixed.length, 1);
  assert.ok(mixed.every((entry) => entry.rule === "react-luau/prefer-binding-over-state-candidate"));
});

test("binding candidate rule surfaces mixed visual and structural state but ignores structural-only state", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-candidate-mixed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Consumer.luau"), `local React = require(script.Parent.React)
local RunService = game:GetService("RunService")
local function Consumer()
  local position, setPosition = React.useState(UDim2.fromOffset(0, 0))
  local selected, setSelected = React.useState(false)
  React.useEffect(function()
    local connection = RunService.RenderStepped:Connect(function(dt)
      setPosition(UDim2.fromOffset(dt, 0))
      setSelected(dt > 0)
    end)
    return function() connection:Disconnect() end
  end, {})
  return React.createElement("Frame", { Position = position }, {
    mixedChild = position.X.Offset > 0 and React.createElement("Frame") or nil,
    selectedChild = selected and React.createElement("Frame") or nil,
  })
end
return Consumer
`);

  const report = await scanPath(root);
  const candidates = report.diagnostics.filter((entry) => entry.rule === "react-luau/prefer-binding-over-state-candidate");
  assert.equal(candidates.length, 1);
  assert.match(candidates[0].message, /position/);
  assert.doesNotMatch(candidates[0].message, /selected/);
});

test("binding candidate rule ignores project-proven binding API siblings for structural-only consumers", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-candidate-api-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Store.luau"), `local Store = {}
function Store:GetReactState(selector) return nil end
function Store:GetReactBinding(selector) return nil end
return Store
`);
  fs.writeFileSync(path.join(root, "Consumer.luau"), `local React = require(script.Parent.React)
local Store = require(script.Parent.Store)
local function Consumer()
  local visible = Store:GetReactState(function(state) return state.visible end)
  return React.createElement("Frame", nil, {
    child = visible and React.createElement("Frame") or nil,
  })
end
return Consumer
`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((entry) => entry.rule === "react-luau/prefer-binding-over-state"), false);
  assert.equal(report.diagnostics.some((entry) => entry.rule === "react-luau/prefer-binding-over-state-candidate"), false);
});

test("binding-over-state warns for proven high-frequency input presentation state", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-input-changed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local UserInputService = game:GetService("UserInputService")

local function Component()
  local position, setPosition = React.useState(Vector2.zero)
  React.useEffect(function()
    local connection = UserInputService.InputChanged:Connect(function(input)
      setPosition(input.Position)
    end)
    return function() connection:Disconnect() end
  end, {})
  return React.createElement("Frame", {
    Position = UDim2.fromOffset(position.X, position.Y),
  })
end

return Component
`);

  const report = await scanPath(root);
  const diagnostic = report.diagnostics.find((entry) => entry.rule === "react-luau/prefer-binding-over-state");
  assert.ok(diagnostic);
  assert.match(diagnostic.message, /high-frequency/);
});

test("binding-over-state propagates mouse movement pressure through imported hooks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-mouse-hook-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useMousePosition.luau"), `local React = require(script.Parent.React)
local Players = game:GetService("Players")
local mouse = Players.LocalPlayer:GetMouse()

local function useMousePosition()
  local position, setPosition = React.useState(Vector2.zero)
  React.useEffect(function()
    local connection = mouse.Move:Connect(function()
      setPosition(Vector2.new(mouse.X, mouse.Y))
    end)
    return function() connection:Disconnect() end
  end, {})
  return position
end

return useMousePosition
`);

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local useMousePosition = require(script.Parent.useMousePosition)

local function Component()
  local position = useMousePosition()
  return React.createElement("Frame", {
    Position = UDim2.fromOffset(position.X, position.Y),
  })
end

return Component
`);

  const report = await scanPath(root);
  const diagnostic = report.diagnostics.find((entry) => entry.rule === "react-luau/prefer-binding-over-state");
  assert.ok(diagnostic);
  assert.match(diagnostic.message, /high-frequency/);
});

test("binding-over-state recognizes React.Change host feedback without requiring a frame-rate source", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-react-change-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)

local function Component()
  local absoluteSize, setAbsoluteSize = React.useState(Vector2.zero)
  return React.createElement("Frame", {
    [React.Change.AbsoluteSize] = function(instance)
      setAbsoluteSize(instance.AbsoluteSize)
    end,
    Size = UDim2.fromOffset(math.max(absoluteSize.X - 8, 0), absoluteSize.Y),
  })
end

return Component
`);

  const report = await scanPath(root);
  const diagnostic = report.diagnostics.find((entry) => entry.rule === "react-luau/prefer-binding-over-state");
  assert.ok(diagnostic);
  assert.match(diagnostic.message, /AbsoluteSize/);
  assert.match(diagnostic.message, /feedback/);
  assert.equal(diagnostic.fixPreview, undefined);
});

test("binding-over-state keeps host measurements in state when they determine React structure", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-structural-measurement-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)

local function Component()
  local absoluteSize, setAbsoluteSize = React.useState(Vector2.zero)
  local children = {}
  if absoluteSize.X > 300 then
    children.sidebar = React.createElement("Frame")
  end
  return React.createElement("Frame", {
    [React.Change.AbsoluteSize] = function(instance)
      setAbsoluteSize(instance.AbsoluteSize)
    end,
  }, children)
end

return Component
`);

  const report = await scanPath(root);
  assert.equal(
    report.diagnostics.some((entry) => entry.rule.startsWith("react-luau/prefer-binding-over-state")),
    false,
  );
});

test("binding candidate keeps opaque helpers out of strong high-frequency warnings", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-opaque-helper-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local RunService = game:GetService("RunService")

local function Component(props)
  local value, setValue = React.useState(0)
  React.useEffect(function()
    local connection = RunService.RenderStepped:Connect(function(dt)
      setValue(dt)
    end)
    return function() connection:Disconnect() end
  end, {})
  local rotation = props.transform(value)
  return React.createElement("Frame", { Rotation = rotation })
end

return Component
`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((entry) => entry.rule === "react-luau/prefer-binding-over-state"), false);
  const candidate = report.diagnostics.find((entry) => entry.rule === "react-luau/prefer-binding-over-state-candidate");
  assert.ok(candidate);
});

test("binding candidate treats non-measurement instance properties as optional even when a Binding mode exists", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-semantic-property-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useObservedProperty.luau"), `local React = require(script.Parent.React)
local function useObservedProperty(targetRef, property, preferBinding: boolean?)
  local value, updateValue
  if preferBinding then
    value, updateValue = React.useBinding(nil)
  else
    value, updateValue = React.useState(nil)
  end
  React.useEffect(function()
    local instance = targetRef.current
    if not instance then return end
    local function update()
      updateValue(instance[property])
    end
    local connection = instance:GetPropertyChangedSignal(property):Connect(update)
    update()
    return function() connection:Disconnect() end
  end, { targetRef, property })
  return value
end
return useObservedProperty
`);

  fs.writeFileSync(path.join(root, "Consumer.luau"), `local React = require(script.Parent.React)
local useObservedProperty = require(script.Parent.useObservedProperty)
local function Consumer()
  local ref = React.useRef(nil)
  local health = useObservedProperty(ref, "Health")
  return React.createElement("TextLabel", { ref = ref, Text = tostring(health or 0) })
end
return Consumer
`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((entry) => entry.rule === "react-luau/prefer-binding-over-state"), false);
  const candidate = report.diagnostics.find((entry) => entry.rule === "react-luau/prefer-binding-over-state-candidate");
  assert.ok(candidate);
  assert.match(candidate.message, /Binding-returning mode/);
});

test("binding candidate follows generic signal mirrors through imported hooks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-generic-hook-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useSignalValue.luau"), `local React = require(script.Parent.React)
local function useSignalValue(signal)
  local value, setValue = React.useState(0)
  React.useEffect(function()
    local connection = signal:Connect(setValue)
    return function() connection:Disconnect() end
  end, { signal })
  return value
end
return useSignalValue
`);

  fs.writeFileSync(path.join(root, "Consumer.luau"), `local React = require(script.Parent.React)
local useSignalValue = require(script.Parent.useSignalValue)
local function Consumer(props)
  local rotation = useSignalValue(props.changed)
  return React.createElement("Frame", { Rotation = rotation })
end
return Consumer
`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((entry) => entry.rule === "react-luau/prefer-binding-over-state"), false);
  const candidate = report.diagnostics.find((entry) => entry.rule === "react-luau/prefer-binding-over-state-candidate");
  assert.ok(candidate);
  assert.match(candidate.message, /external reactive value/);
});

test("binding-over-state keeps imported constant event transitions in React state", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-generic-hook-constant-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useOpenedState.luau"), `local React = require(script.Parent.React)
local function useOpenedState(signal)
  local visible, setVisible = React.useState(false)
  React.useEffect(function()
    local connection = signal:Connect(function()
      setVisible(true)
    end)
    return function() connection:Disconnect() end
  end, { signal })
  return visible
end
return useOpenedState
`);

  fs.writeFileSync(path.join(root, "Consumer.luau"), `local React = require(script.Parent.React)
local useOpenedState = require(script.Parent.useOpenedState)
local function Consumer(props)
  local visible = useOpenedState(props.opened)
  return React.createElement("Frame", { Visible = visible })
end
return Consumer
`);

  const report = await scanPath(root);
  assert.equal(
    report.diagnostics.some((entry) => entry.rule.startsWith("react-luau/prefer-binding-over-state")),
    false,
  );
});

test("binding-over-state keeps event-driven constant state transitions in React state", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-event-transition-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local function Component(props)
  local visible, setVisible = React.useState(false)
  React.useEffect(function()
    local connection = props.opened:Connect(function()
      setVisible(true)
    end)
    return function() connection:Disconnect() end
  end, { props.opened })
  return React.createElement("Frame", { Visible = visible })
end
return Component
`);

  const report = await scanPath(root);
  assert.equal(
    report.diagnostics.some((entry) => entry.rule.startsWith("react-luau/prefer-binding-over-state")),
    false,
  );
});

test("binding-over-state keeps reducer-style external updates in React state", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-reducer-transition-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local function Component(props)
  local count, setCount = React.useState(0)
  React.useEffect(function()
    local connection = props.incremented:Connect(function()
      setCount(function(previous)
        return previous + 1
      end)
    end)
    return function() connection:Disconnect() end
  end, { props.incremented })
  return React.createElement("TextLabel", { Text = tostring(count) })
end
return Component
`);

  const report = await scanPath(root);
  assert.equal(
    report.diagnostics.some((entry) => entry.rule.startsWith("react-luau/prefer-binding-over-state")),
    false,
  );
});

test("binding-over-state ignores one-shot external callbacks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-once-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local function Component(props)
  local rotation, setRotation = React.useState(0)
  React.useEffect(function()
    return props.ready:Once(function(value)
      setRotation(value)
    end)
  end, { props.ready })
  return React.createElement("Frame", { Rotation = rotation })
end
return Component
`);

  const report = await scanPath(root);
  assert.equal(
    report.diagnostics.some((entry) => entry.rule.startsWith("react-luau/prefer-binding-over-state")),
    false,
  );
});

test("binding-over-state treats motion-style onStep mirrors as strong presentation streams", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-onstep-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local function Component(props)
  local scale, setScale = React.useState(1)
  React.useEffect(function()
    return props.motor:onStep(function(value)
      setScale(value)
    end)
  end, { props.motor })
  return React.createElement("Frame", { Size = UDim2.fromScale(scale, scale) })
end
return Component
`);

  const report = await scanPath(root);
  const warning = report.diagnostics.find((entry) => entry.rule === "react-luau/prefer-binding-over-state");
  assert.ok(warning);
  assert.match(warning.message, /high-frequency/);
});

test("binding-over-state recognizes continuously mutable instance-property mirrors", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-cframe-property-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local function Component(props)
  local cameraCFrame, setCameraCFrame = React.useState(CFrame.new())
  React.useEffect(function()
    local connection = props.camera:GetPropertyChangedSignal("CFrame"):Connect(function()
      setCameraCFrame(props.camera.CFrame)
    end)
    return function() connection:Disconnect() end
  end, { props.camera })
  return React.createElement("Frame", { Rotation = cameraCFrame.LookVector.X * 30 })
end
return Component
`);

  const report = await scanPath(root);
  const warning = report.diagnostics.find((entry) => entry.rule === "react-luau/prefer-binding-over-state");
  assert.ok(warning);
  assert.match(warning.message, /CFrame/);
});

test("binding candidate keeps unknown instance-property mirrors optional", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-unknown-property-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local function Component(props)
  local alpha, setAlpha = React.useState(0)
  React.useEffect(function()
    local connection = props.source:GetPropertyChangedSignal("VisualAlpha"):Connect(function()
      setAlpha(props.source.VisualAlpha)
    end)
    return function() connection:Disconnect() end
  end, { props.source })
  return React.createElement("Frame", { BackgroundTransparency = alpha })
end
return Component
`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((entry) => entry.rule === "react-luau/prefer-binding-over-state"), false);
  assert.ok(report.diagnostics.some((entry) => entry.rule === "react-luau/prefer-binding-over-state-candidate"));
});

test("binding candidate recognizes derived observable payload mirrors", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-observable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local function Component(props)
  local alpha, setAlpha = React.useState(0)
  React.useEffect(function()
    return props.observable:Subscribe(function(value)
      setAlpha(math.clamp(value * props.scale, 0, 1))
    end)
  end, { props.observable, props.scale })
  return React.createElement("Frame", { BackgroundTransparency = alpha })
end
return Component
`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((entry) => entry.rule === "react-luau/prefer-binding-over-state"), false);
  assert.ok(report.diagnostics.some((entry) => entry.rule === "react-luau/prefer-binding-over-state-candidate"));
});

test("binding-over-state keeps store snapshot subscriptions semantic", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-store-snapshot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useStoreState.luau"), `local React = require(script.Parent.React)
local function useStoreState(store)
  local state, setState = React.useState(store:getState())
  React.useEffect(function()
    return store:subscribe(function()
      setState(store:getState())
    end)
  end, { store })
  return state
end
return useStoreState
`);

  fs.writeFileSync(path.join(root, "Consumer.luau"), `local React = require(script.Parent.React)
local useStoreState = require(script.Parent.useStoreState)
local function Consumer(props)
  local state = useStoreState(props.store)
  return React.createElement("TextLabel", { Text = tostring(state.count) })
end
return Consumer
`);

  const report = await scanPath(root);
  assert.equal(
    report.diagnostics.some((entry) => entry.rule.startsWith("react-luau/prefer-binding-over-state")),
    false,
  );
});

test("rules of hooks accepts iteration over a directly exported static module table", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-static-hook-loop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Config.luau"), `return {
    Items = {
      First = 1,
      Second = 2,
    },
  }`);
  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local Config = require(script.Parent.Config)

local function Component()
  local values = {}
  for name, initial in Config.Items do
    local value = React.useState(initial)
    values[name] = value
  end
  return React.createElement("Frame")
end

return Component`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rules-of-hooks"), false);
});

test("rules of hooks accepts private module literal loops and keeps unsafe sources flagged", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-local-static-hook-loop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const cases = [
    { name: "Direct", source: "BUTTONS", before: "", flagged: false },
    { name: "Pairs", source: "pairs(BUTTONS)", before: "", flagged: false },
    { name: "Ipairs", source: "ipairs(BUTTONS)", before: "", flagged: false },
    { name: "Reassigned", source: "BUTTONS", before: "BUTTONS = props.items", flagged: true },
    { name: "Mutated", source: "BUTTONS", before: "BUTTONS[1] = nil", flagged: true },
    { name: "Insert", source: "BUTTONS", before: "table.insert(BUTTONS, props.item)", flagged: true },
    { name: "Escape", source: "BUTTONS", before: "mutate(BUTTONS)", flagged: true },
    { name: "Alias", source: "BUTTONS", before: "local alias = BUTTONS\nalias[1] = nil", flagged: true },
    { name: "Shadowed", source: "BUTTONS", before: "local BUTTONS = props.items", flagged: true },
  ];

  for (const entry of cases) {
    fs.writeFileSync(path.join(root, `${entry.name}.luau`), `local React = require(script.Parent.React)
local LobbyHudState = require(script.Parent.LobbyHudState)
local BUTTONS = { { name = "Decks" }, { name = "Loadout" } }
local function Component(props)
  local selectedIndex, setSelectedIndex = React.useState(nil)
  local count = #BUTTONS
  ${entry.before}
  local buttons = {}
  for i, buttonData in ${entry.source} do
    buttons[buttonData.name] = React.createElement("TextButton", {
      OnClick = React.useCallback(function()
        LobbyHudState:Set("SelectedTab", buttonData.name)
      end, { buttonData }),
      OnHover = React.useCallback(function() setSelectedIndex(i) end, { i }),
      OnUnhover = React.useCallback(function() setSelectedIndex(nil) end, {}),
    })
  end
  return React.createElement("Frame", nil, buttons)
end
return Component`);
  }

  const report = await scanPath(root);
  for (const entry of cases) {
    assert.equal(report.diagnostics.some((diagnostic) =>
      diagnostic.file === `${entry.name}.luau` && diagnostic.rule === "react-luau/rules-of-hooks"
    ), entry.flagged, entry.name);
  }
});

test("rules of hooks still reports loops whose collection shape is runtime-dependent", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-dynamic-hook-loop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)

local function Component(props)
  for _, initial in props.items do
    React.useState(initial)
  end
  return React.createElement("Frame")
end

return Component`);

  const report = await scanPath(root);
  const diagnostic = report.diagnostics.find((entry) => entry.rule === "react-luau/rules-of-hooks");
  assert.ok(diagnostic);
  assert.match(diagnostic.message, /whose size or iteration order may change between renders/);
  assert.match(diagnostic.fixPreview?.note ?? "", /child component/);
});

test("rules of hooks reports custom hooks iterated over a vararg-built table", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-vararg-hook-loop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useEntity.luau"), `local React = require(script.Parent.React)

local function useComponent(entity, component)
  local value = React.useState(0)
  return value
end

local function useEntity(entity, ...)
  local components = {...}
  local values = {}
  for i, component in ipairs(components) do
    values[i] = useComponent(entity, component)
  end
  return values
end

return useEntity`);

  const report = await scanPath(root);
  const diagnostic = report.diagnostics.find(
    (entry) => entry.rule === "react-luau/rules-of-hooks",
  );
  assert.ok(diagnostic);
  assert.match(diagnostic.message, /size or iteration order may change between renders/);
});

test("rules of hooks ignores an early return guarded only by an impossible nil check on a non-optional parameter", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-nonoptional-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useThing.luau"), `local React = require(script.Parent.React)

local function useThing(modifier: React.Binding<number>)
  if not modifier then
    return nil
  end
  return React.useCallback(function()
    return modifier
  end, { modifier })
end

return useThing`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rules-of-hooks"), false);
});

test("rules of hooks keeps early-return diagnostics when the guarded parameter is optional", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-optional-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useThing.luau"), `local React = require(script.Parent.React)

local function useThing(modifier: React.Binding<number>?)
  if not modifier then
    return nil
  end
  return React.useCallback(function()
    return modifier
  end, { modifier })
end

return useThing`);

  const report = await scanPath(root);
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rules-of-hooks"));
});

test("unnecessary useMemo does not flag empty-dependency initial-value capture", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-initial-capture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)

local function Component(props)
  local initialName = React.useMemo(function()
    return props.name
  end, {})
  return React.createElement("TextLabel", { Text = initialName })
end

return Component`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rerender-unnecessary-usememo"), false);
});

test("high-frequency state requires a real RunService source", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-custom-heartbeat-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local function Component(props)
  local value, setValue = React.useState(0)
  React.useEffect(function()
    return props.Heartbeat:Connect(function(nextValue)
      setValue(nextValue)
    end)
  end, { props.Heartbeat })
  return React.createElement("Frame", { Rotation = value })
end
return Component
`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rerender-high-frequency-state"), false);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/prefer-binding-over-state"), false);
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/prefer-binding-over-state-candidate"));
});

test("high-frequency state ignores a provable one-shot guard", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-one-shot-frame-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local RunService = game:GetService("RunService")

local function Component()
  local pulsing, setPulsing = React.useState(false)
  React.useEffect(function()
    local didPulse = false
    local connection = RunService.Heartbeat:Connect(function()
      if shouldPulse() and not didPulse then
        didPulse = true
        setPulsing(true)
      end
    end)
    return function()
      connection:Disconnect()
    end
  end, {})
  return React.createElement("Frame", { Visible = pulsing })
end

return Component`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rerender-high-frequency-state"), false);
});

test("rules of hooks accepts parameter-controlled hook modes when every call site uses a stable mode", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-stable-hook-mode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useObservedValue.luau"), `local React = require(script.Parent.React)

local function useObservedValue(binding: boolean?)
  local value
  if binding then
    value = React.useBinding(0)
  else
    value = React.useState(0)
  end
  return value
end

return useObservedValue`);

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local useObservedValue = require(script.Parent.useObservedValue)

local function Component()
  local first = useObservedValue(true)
  local second = useObservedValue(false)
  local third = useObservedValue()
  return React.createElement("Frame", { Name = tostring(first) .. tostring(second) .. tostring(third) })
end

return Component`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rules-of-hooks"), false);
});

test("rules of hooks leaves an unknown prop-controlled custom-hook mode unreported", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-dynamic-hook-mode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useObservedValue.luau"), `local React = require(script.Parent.React)

local function useObservedValue(binding: boolean?)
  local value
  if binding then
    value = React.useBinding(0)
  else
    value = React.useState(0)
  end
  return value
end

return useObservedValue`);

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local useObservedValue = require(script.Parent.useObservedValue)

local function Component(props)
  local value = useObservedValue(props.binding)
  return React.createElement("Frame", { Name = tostring(value) })
end

return Component`);

  const report = await scanPath(root);
  assert.equal(
    report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rules-of-hooks"),
    false,
  );
});

test("rules of hooks leaves an uncalled parameter-controlled hook unreported", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-uncalled-hook-mode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useObservedValue.luau"), `local React = require(script.Parent.React)

local function useObservedValue(binding: boolean?)
  if binding then
    return React.useBinding(0)
  end
  return React.useState(0)
end

return useObservedValue`);

  const report = await scanPath(root);
  assert.equal(
    report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rules-of-hooks"),
    false,
  );
});

test("rules of hooks reports a custom-hook mode that is proven to change through state", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-changing-hook-mode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useObservedValue.luau"), `local React = require(script.Parent.React)

local function useObservedValue(binding: boolean?)
  if binding then
    return React.useBinding(0)
  end
  return React.useState(0)
end

return useObservedValue`);

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local useObservedValue = require(script.Parent.useObservedValue)

local function Component()
  local binding, setBinding = React.useState(true)
  local value = useObservedValue(binding)
  React.useEffect(function()
    setBinding(false)
  end, {})
  return React.createElement("Frame", { Name = tostring(value) })
end

return Component`);

  const report = await scanPath(root);
  const diagnostic = report.diagnostics.find(
    (entry) => entry.rule === "react-luau/rules-of-hooks" && entry.file === "Component.luau",
  );
  assert.ok(diagnostic);
  assert.match(diagnostic.message, /updated between renders/);
});

test("rules of hooks tracks topology modes stored in options-table properties", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-options-hook-mode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useObservedValue.luau"), `local React = require(script.Parent.React)

local function useObservedValue(options)
  if options.binding then
    return React.useBinding(0)
  end
  return React.useState(0)
end

return useObservedValue`);

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local useObservedValue = require(script.Parent.useObservedValue)

local function Component()
  local binding, setBinding = React.useState(true)
  local value = useObservedValue({ binding = binding })
  React.useEffect(function()
    setBinding(false)
  end, {})
  return React.createElement("Frame", { Name = tostring(value) })
end

return Component`);

  const report = await scanPath(root);
  const diagnostic = report.diagnostics.find(
    (entry) => entry.rule === "react-luau/rules-of-hooks" && entry.file === "Component.luau",
  );
  assert.ok(diagnostic);
  assert.match(diagnostic.message, /options\.binding/);
});

test("rules of hooks does not assume an options-table prop changes without evidence", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-options-prop-hook-mode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useObservedValue.luau"), `local React = require(script.Parent.React)

local function useObservedValue(options)
  if options.binding then
    return React.useBinding(0)
  end
  return React.useState(0)
end

return useObservedValue`);

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local useObservedValue = require(script.Parent.useObservedValue)

local function Component(props)
  local value = useObservedValue({ binding = props.binding })
  return React.createElement("Frame", { Name = tostring(value) })
end

return Component`);

  const report = await scanPath(root);
  assert.equal(
    report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rules-of-hooks"),
    false,
  );
});

test("rules of hooks keeps unresolved options-table mode properties unknown", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-options-variable-hook-mode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useObservedValue.luau"), `local React = require(script.Parent.React)

local function useObservedValue(options)
  if options.binding then
    return React.useBinding(0)
  end
  return React.useState(0)
end

return useObservedValue`);

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local useObservedValue = require(script.Parent.useObservedValue)

local function Component(props)
  local options = props.options
  local value = useObservedValue(options)
  return React.createElement("Frame", { Name = tostring(value) })
end

return Component`);

  const report = await scanPath(root);
  assert.equal(
    report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rules-of-hooks"),
    false,
  );
});

test("rules of hooks accepts module-invariant conditions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-module-invariant-hook-mode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useThing.luau"), `local React = require(script.Parent.React)
local isLegacy = getLegacyMode()

local function useThing()
  if isLegacy then
    return React.useState(0)
  else
    return React.useBinding(0)
  end
end

return useThing`);

  const report = await scanPath(root);
  assert.equal(
    report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rules-of-hooks"),
    false,
  );
});

test("rules of hooks accepts equivalent built-in hook topology across branches", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-equivalent-hook-branches-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)

local function Component(props)
  local value
  if props.alternate then
    value = React.useState(1)
  else
    value = React.useState(2)
  end
  return React.createElement("Frame", { Name = tostring(value) })
end

return Component`);

  const report = await scanPath(root);
  assert.equal(
    report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rules-of-hooks"),
    false,
  );
});

test("rules of hooks does not propagate topology sensitivity when both custom-hook branches use the same built-in hooks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-equivalent-custom-hook-mode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useObservedValue.luau"), `local React = require(script.Parent.React)

local function useObservedValue(binding: boolean?)
  if binding then
    return React.useState(1)
  else
    return React.useState(2)
  end
end

return useObservedValue`);

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local useObservedValue = require(script.Parent.useObservedValue)

local function Component()
  local binding, setBinding = React.useState(true)
  local value = useObservedValue(binding)
  React.useEffect(function()
    setBinding(false)
  end, {})
  return React.createElement("Frame", { Name = tostring(value) })
end

return Component`);

  const report = await scanPath(root);
  assert.equal(
    report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rules-of-hooks"),
    false,
  );
});

test("rules of hooks accepts stable modes for an anonymously exported custom hook", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-anonymous-hook-mode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useScale.luau"), `local React = require(script.Parent.React)

return function(scale: number?, useBinding: boolean?)
  local value = scale or 1
  if useBinding then
    value = React.useBinding(value)
  end
  return value
end`);

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local useScale = require(script.Parent.useScale)

local function Component()
  local scale = useScale(1, true)
  return React.createElement("Frame", { Size = scale })
end

return Component`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rules-of-hooks"), false);
});

test("rules of hooks follows a normalized local mode derived from a stable call-site argument", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-normalized-hook-mode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useObservedValue.luau"), `local React = require(script.Parent.React)

local function useObservedValue(state: boolean?)
  local useStateValue = if state == nil then true else state
  local value
  if useStateValue then
    value = React.useState(0)
  else
    value = React.useBinding(0)
  end
  return value
end

return useObservedValue`);

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local useObservedValue = require(script.Parent.useObservedValue)

local function Component()
  local value = useObservedValue()
  return React.createElement("Frame", { Name = tostring(value) })
end

return Component`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rules-of-hooks"), false);
});

test("rules of hooks accepts hook loops over an empty-dependency captured table passed through a local helper", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-captured-hook-loop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useGroupValues.luau"), `local React = require(script.Parent.React)
local useBinding = React.useBinding
local useMemo = React.useMemo

local function getStateContainer(defaults)
  local values = {}
  for name, initial in defaults do
    local binding = useBinding(initial)
    values[name] = binding
  end
  return values
end

local function useGroupValues(defaults)
  local capturedDefaults = useMemo(function()
    return defaults
  end, {})
  return getStateContainer(capturedDefaults)
end

return useGroupValues`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rules-of-hooks"), false);
});

test("rules of hooks still reports a helper hook loop when its table parameter is not lifetime-captured", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-uncaptured-hook-loop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useGroupValues.luau"), `local React = require(script.Parent.React)

local function getStateContainer(defaults)
  for _, initial in defaults do
    React.useBinding(initial)
  end
end

local function useGroupValues(defaults)
  getStateContainer(defaults)
end

return useGroupValues`);

  const report = await scanPath(root);
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rules-of-hooks"));
});

test("binding-aware rules respect same-scope local redeclarations", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-binding-shadowing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)

local function PropsComponent(props)
  local props = table.clone(props)
  props.changed = true
  return React.createElement("Frame")
end

local function StateComponent()
  local state, setState = React.useState({ changed = false })
  local state = table.clone(state)
  state.changed = true
  return React.createElement("Frame", { Name = tostring(state.changed) })
end

local function SetterComponent()
  local value, setValue = React.useState(0)
  local setValue = function() return nil end
  setValue()
  return React.createElement("Frame", { Name = tostring(value) })
end

local function RefComponent()
  local ref = React.useRef(nil)
  local ref = { current = nil }
  ref.current = 123
  return React.createElement("Frame")
end

return PropsComponent
`);

  const report = await scanPath(root);
  const forbidden = new Set([
    "react-luau/no-prop-mutation",
    "react-luau/no-direct-state-mutation",
    "react-luau/no-set-state-in-render",
    "react-luau/no-ref-current-in-render",
  ]);
  assert.deepEqual(report.diagnostics.filter((diagnostic) => forbidden.has(diagnostic.rule)), []);
});

test("source effect inference keeps fresh receiver and argument mutation local to render", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-source-effects-conditional-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Mutator.luau"), `local Mutator = {}

function Mutator.make()
  return setmetatable({ items = { "value" } }, Mutator)
end

function Mutator:flushAll()
  self.items[1] = nil
end

function Mutator.mutateArgument(value)
  value.changed = true
end

return Mutator
`);

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local Mutator = require(script.Parent.Mutator)

local function Component(props)
  local localValue = {}
  Mutator.mutateArgument(localValue)

  local instance = Mutator.make()
  instance:flushAll()

  return React.createElement("Frame", { Name = tostring(props.value) })
end

return Component
`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/no-side-effects-in-render"), false);
});

test("source effect inference flags mutation of persistent factory instances", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-source-effects-persistent-receiver-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Mutator.luau"), `local Mutator = {}

local function clearStoredItems(value)
  value.items[1] = nil
end

function Mutator.make()
  return setmetatable({ items = { "value" } }, Mutator)
end

function Mutator:flushAll()
  clearStoredItems(self)
end

return Mutator
`);

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local Mutator = require(script.Parent.Mutator)

local function Component()
  local instance = React.useMemo(function()
    return Mutator.make()
  end, {})
  instance:flushAll()
  return React.createElement("Frame")
end

return Component
`);

  const report = await scanPath(root);
  const diagnostic = report.diagnostics.find((entry) => entry.rule === "react-luau/no-side-effects-in-render");
  assert.ok(diagnostic);
  assert.match(diagnostic.message, /instance:flushAll runs during render/);
});

test("source effect inference propagates through imported source-visible functions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-source-effects-transitive-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Mutator.luau"), `local stored = {}
local function mutateStored()
  stored.changed = true
end
return mutateStored
`);

  fs.writeFileSync(path.join(root, "Wrapper.luau"), `local mutateStored = require(script.Parent.Mutator)
local function performWork()
  mutateStored()
end
return performWork
`);

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local performWork = require(script.Parent.Wrapper)
local function Component()
  performWork()
  return React.createElement("Frame")
end
return Component
`);

  const report = await scanPath(root);
  const diagnostic = report.diagnostics.find((entry) => entry.rule === "react-luau/no-side-effects-in-render");
  assert.ok(diagnostic);
  assert.match(diagnostic.message, /performWork runs during render, and code it calls eventually changes state outside the current render/);
});


test("source effect inference does not confuse function-local imports or shadowed aliases", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-source-effects-import-shadow-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Impure.luau"), `local stored = {}
local function mutate()
  stored.changed = true
end
return mutate
`);

  fs.writeFileSync(path.join(root, "Safe.luau"), `local function run()
  return 1
end
return run
`);

  fs.writeFileSync(path.join(root, "Wrapper.luau"), `local run = require(script.Parent.Impure)

local function performWork()
  local run = require(script.Parent.Safe)
  run()
end

return performWork
`);

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local performWork = require(script.Parent.Wrapper)
local function Component()
  performWork()
  return React.createElement("Frame")
end
return Component
`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/no-side-effects-in-render"), false);
});

test("unknown opaque methods are not assumed to be render side effects", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-source-effects-unknown-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local function Component(props)
  props.service:DoSomething()
  return React.createElement("Frame")
end
return Component
`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/no-side-effects-in-render"), false);
});

test("render side-effect source bindings respect lexical shadowing and sibling scopes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-source-effects-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Cleaner.luau"), `local Cleaner = {}
local function clearStoredItems(self)
  local items = self._items
  items[1] = nil
end
function Cleaner.make(): Cleaner
  return setmetatable({ _items = { "value" } }, Cleaner)
end
function Cleaner:flushAll()
  clearStoredItems(self)
end
return Cleaner
`);

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local Cleaner = require(script.Parent.Cleaner)

local function useScale()
  return React.useBinding(1)
end

local function First()
  local scale = Cleaner.make()
  return React.createElement("Frame")
end

local function Second()
  local scale = useScale()
  scale:flushAll()
  return React.createElement("Frame")
end

local function Third()
  local Cleaner = { flushAll = function() return 1 end }
  Cleaner.flushAll()
  return React.createElement("Frame")
end

local function Reassigned()
  local scale = Cleaner.make()
  scale = useScale()
  scale:flushAll()
  return React.createElement("Frame")
end

return Second
`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/no-side-effects-in-render"), false);
});

test("opaque render methods are not treated as side effects by name alone", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-source-effects-render-name-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local function Component(props)
  local text = props.formatter:render(props.value)
  return React.createElement("TextLabel", { Text = text })
end
return Component
`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/no-side-effects-in-render"), false);
});

test("source-visible custom hooks are only flagged when they directly perform render-time effects", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-source-effects-hooks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useSafeValue.luau"), `local React = require(script.Parent.React)
local function useSafeValue()
  local value, setValue = React.useState(0)
  React.useEffect(function()
    setValue(1)
  end, {})
  return value
end
return useSafeValue
`);

  fs.writeFileSync(path.join(root, "useImpureValue.luau"), `local shared = {}
local function useImpureValue()
  shared.renderCount = (shared.renderCount or 0) + 1
  return shared.renderCount
end
return useImpureValue
`);

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local useSafeValue = require(script.Parent.useSafeValue)
local useImpureValue = require(script.Parent.useImpureValue)
local function Component()
  useSafeValue()
  useImpureValue()
  return React.createElement("Frame")
end
return Component
`);

  const report = await scanPath(root);
  const diagnostics = report.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/no-side-effects-in-render");
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /useImpureValue runs during render, and code it calls eventually changes state outside the current render/);
});

test("source effect inference treats locally constructed tables as owned values", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-source-effects-owned-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Factory.luau"), `local Factory = {}
function Factory.new()
  local self = setmetatable({}, Factory)
  self.value = 1
  return self
end
return Factory
`);

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local Factory = require(script.Parent.Factory)
local function Component()
  local value = Factory.new()
  return React.createElement("Frame", { Name = tostring(value.value) })
end
return Component
`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/no-side-effects-in-render"), false);
});

test("source effect inference does not escalate useRef latest-value mirrors at hook call sites", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-source-effects-ref-mirror-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useLatest.luau"), `local React = require(script.Parent.React)
local function useLatest(value)
  local ref = React.useRef(value)
  ref.current = value
  return ref
end
return useLatest
`);

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local useLatest = require(script.Parent.useLatest)
local function Component(props)
  local latest = useLatest(props.value)
  return React.createElement("Frame", { Name = tostring(latest) })
end
return Component
`);

  const report = await scanPath(root);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/no-side-effects-in-render"), false);
  const mirror = report.diagnostics.find((diagnostic) => diagnostic.rule === "react-luau/no-ref-current-in-render");
  assert.equal(mirror?.file, "useLatest.luau");
  assert.equal(mirror?.severity, "suggestion");
});

test("Instance and tween render work share the side-effects rule and policy", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-render-effects-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local TweenService = game:GetService("TweenService")
local function Component(props)
  local part = Instance.new("Part")
  local tween = TweenService:Create(props.target, props.info, props.goal)
  tween:Play()
  local ref = React.useRef(nil)
  if ref.current == nil then
    ref.current = Instance.new("Part")
  end
  React.useEffect(function()
    local owned = Instance.new("Part")
    local animation = TweenService:Create(props.target, props.info, props.goal)
    animation:Play()
    return function()
      animation:Cancel()
      owned:Destroy()
    end
  end, { props.target, props.info, props.goal })
  return React.createElement("Frame")
end
return Component
`);
  const id = "react-luau/no-side-effects-in-render";
  for (const severity of ["error", "warning", "off"] as const) {
    const report = await scanPath(root, { cache: false, config: { rules: { [id]: severity } } });
    const findings = report.diagnostics.filter(d => d.rule === id);
    assert.deepEqual(findings.map(d => d.location.line), severity === "off" ? [] : [4, 5, 6, 9]);
    assert.ok(findings.every(d => d.severity === severity));
  }
});

test("parameter mutation summaries follow props through local and imported helpers without flagging fresh copies", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-parameter-props-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Mutator.luau"), `local Mutator = {}
function Mutator.mutate(value)
  value.changed = true
end
return Mutator
`);

  fs.writeFileSync(path.join(root, "FunctionMutator.luau"), `local function mutate(value)
  table.insert(value, "changed")
end
return mutate
`);

  fs.writeFileSync(path.join(root, "Wrapper.luau"), `local mutate = require(script.Parent.FunctionMutator)
local function wrappedMutate(value)
  mutate(value)
end
return wrappedMutate
`);

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local Mutator = require(script.Parent.Mutator)
local wrappedMutate = require(script.Parent.Wrapper)

local function localMutate(value)
  value.changed = true
end

local function outer(value)
  localMutate(value)
end

local function Component(props)
  local alias = props.data
  outer(alias)
  Mutator.mutate(props.other)
  wrappedMutate(props.third)
  table.insert(props.items, "value")

  local reassigned = props.reassigned
  reassigned = {}
  localMutate(reassigned)

  local cloned = table.clone(props.cloned)
  Mutator.mutate(cloned)

  return React.createElement("Frame")
end

return Component
`);

  const report = await scanPath(root);
  const diagnostics = report.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/no-prop-mutation");
  assert.equal(diagnostics.length, 4);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.message.includes("outer mutates an argument derived from props")));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.message.includes("Mutator.mutate mutates an argument derived from props")));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.message.includes("wrappedMutate mutates an argument derived from props")));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.message.includes("table.insert mutates an argument derived from props")));
});

test("prop mutation checks include useMemo callbacks and preserve cloned and shadowed inputs", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-memo-props-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Inventory.luau"), `local React = require(script.Parent.React)
local useMemo = React.useMemo
local function Inventory(props)
  local items = React.useMemo(function()
    table.sort(props.items, function(a, b)
      return a.rarity > b.rarity
    end)
    props.changed = true
    local alias = props.items
    table.insert(alias, {})
    local cloned = table.clone(props.items)
    table.sort(cloned)
    return cloned
  end, { props.items })
  local other = useMemo(function()
    table.remove(props.items)
    return items
  end, { props.items })
  local shadowed = React.useMemo(function()
    local props = { items = {} }
    table.sort(props.items)
    props.changed = true
    return props
  end, {})
  local callback = React.useCallback(function()
    table.sort(props.items)
  end, { props.items })
  return React.createElement("Frame")
end
return Inventory
`);

  const report = await scanPath(root, { cache: false });
  const diagnostics = report.diagnostics.filter(d => d.rule === "react-luau/no-prop-mutation");
  assert.deepEqual(diagnostics.map(d => d.location.line), [5, 8, 10, 16, 26]);
});

test("prop mutation checks include captured props in named and deferred functions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-named-memo-props-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Inventory.luau"), `local React = require(script.Parent.React)
local useMemo = React.useMemo
local function Inventory(props)
  local sortItems = function()
    table.sort(props.items)
    props.changed = true
    local copy = table.clone(props.items)
    table.sort(copy)
    return copy
  end
  local alias = sortItems
  local items = useMemo(alias, { props.items })
  local function removeItem()
    table.remove(props.items)
    return items
  end
  React.useMemo(removeItem, { props.items })
  local reassigned
  reassigned = function()
    table.clear(props.items)
    return items
  end
  React.useMemo(reassigned, { props.items })
  local function unused()
    table.sort(props.items)
  end
  local function deferred()
    table.sort(props.items)
  end
  React.useCallback(deferred, { props.items })
  local function shadowed()
    table.sort(props.items)
  end
  do
    local shadowed = function() return {} end
    React.useMemo(shadowed, {})
  end
  local function replaced()
    table.sort(props.items)
  end
  replaced = function() return {} end
  React.useMemo(replaced, {})
  local function withParameter(shadowed)
    return React.useMemo(shadowed, {})
  end
  React.useMemo(withParameter, {})
  return React.createElement("Frame")
end
return Inventory
`);

  const report = await scanPath(root, { cache: false });
  const diagnostics = report.diagnostics.filter(d => d.rule === "react-luau/no-prop-mutation");
  assert.deepEqual(diagnostics.map(d => d.location.line), [5, 6, 14, 20, 25, 28, 32, 39]);
});

test("prop mutation checks respect nested parameter shadowing and captured aliases", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-closure-props-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local function Component(props)
  local items = props.items
  local function shadowed(props, items)
    props.changed = true
    table.sort(props.items)
    table.sort(items)
    local alias = props.items
    table.sort(alias)
  end
  local function captured(props)
    table.sort(items)
  end
  React.useEffect(function()
    props.changed = true
    table.sort(items)
  end, { props.items })
  return React.createElement("TextButton", {
    [React.Event.Activated] = function()
      table.sort(props.items)
    end,
  })
end
return Component
`);
  const report = await scanPath(root, { cache: false });
  const diagnostics = report.diagnostics.filter(d => d.rule === "react-luau/no-prop-mutation");
  assert.deepEqual(diagnostics.map(d => d.location.line), [12, 15, 16, 20]);
});

test("parameter mutation summaries follow table state through helper calls without flagging cloned state", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-parameter-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "Mutator.luau"), `local Mutator = {}
function Mutator.mutate(value)
  value.changed = true
end
return Mutator
`);

  fs.writeFileSync(path.join(root, "Component.luau"), `local React = require(script.Parent.React)
local Mutator = require(script.Parent.Mutator)

local function Component()
  local state, setState = React.useState({ changed = false })
  local alias = state
  Mutator.mutate(alias)

  local cloned = table.clone(state)
  Mutator.mutate(cloned)

  return React.createElement("Frame", { Name = tostring(state.changed) })
end

return Component
`);

  const report = await scanPath(root);
  const diagnostics = report.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/no-direct-state-mutation");
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /state is React state backed by a table and is mutated in place/);
});

test("rules of hooks ignores project-proven non-React use APIs without weakening imported React hooks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-hook-ownership-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "useMatterReact.luau"), `local Matter = require(script.Parent.Matter)

local function cleanup(storage)
end

local function useMatterReact(discriminator)
  local storage = Matter.useHookState(discriminator, cleanup)
  return storage
end

return useMatterReact
`);

  fs.writeFileSync(path.join(root, "MatterSystem.luau"), `local React = require(script.Parent.React)
local useMatterReact = require(script.Parent.useMatterReact)

local function Child()
  return React.createElement("Frame")
end

local function mySystem(enabled)
  if enabled then
    useMatterReact({ Child = Child })
  end
end

return mySystem
`);

  fs.writeFileSync(path.join(root, "useInner.luau"), `local React = require(script.Parent.React)

local function useInner()
  return React.useState(0)
end

return useInner
`);

  fs.writeFileSync(path.join(root, "useOuter.luau"), `local useInner = require(script.Parent.useInner)

local function useOuter()
  return useInner()
end

return useOuter
`);

  fs.writeFileSync(path.join(root, "BadReactComponent.luau"), `local React = require(script.Parent.React)
local useOuter = require(script.Parent.useOuter)

local function BadReactComponent(props)
  if props.enabled then
    useOuter()
  end
  return React.createElement("Frame")
end

return BadReactComponent
`);

  const report = await scanPath(root, { cache: false, parallel: false });
  const hookDiagnostics = report.diagnostics.filter((diagnostic) => diagnostic.rule === "react-luau/rules-of-hooks");

  assert.equal(
    hookDiagnostics.some((diagnostic) => diagnostic.file === "MatterSystem.luau"),
    false,
    "Matter use* APIs should not be inferred as React hooks merely from their names",
  );
  assert.ok(
    hookDiagnostics.some((diagnostic) => diagnostic.file === "BadReactComponent.luau" && diagnostic.message.includes("useOuter")),
    "transitively imported React custom hooks should still enforce hook ordering",
  );

  const forcedMatter = await scanPath(path.join(root, "useMatterReact.luau"), { cache: false, parallel: false });
  assert.equal(
    forcedMatter.diagnostics.some((diagnostic) => diagnostic.rule === "react-luau/rules-of-hooks"),
    false,
    "forcing analysis of a non-React framework hook module should not reinterpret its hooks as React hooks",
  );
});

test("suggests reviewing unknown collection keys returned from useMemo and passed to a fragment", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-memo-child-index-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = `local React = require(script.Parent.React)
local createElement = React.createElement
local function Inventory(props)
  local itemElements = React.useMemo(function(): { [string]: React.ReactElement<any, any> }
    local elements = {}
    local sortedItems = table.clone(props.items)
    table.sort(sortedItems, function(a, b)
      return a.rarity > b.rarity
    end)
    for i, v in sortedItems do
      elements[i] = createElement(DailyShopItem, { itemName = v.name })
    end
    return elements
  end, { props.items })
  return createElement(React.Fragment, nil, itemElements)
end
return Inventory
`;
  fs.writeFileSync(path.join(root, "Inventory.luau"), source);

  const report = await scanPath(root);
  const diagnostics = report.diagnostics.filter((item) => item.rule === "react-luau/no-array-index-as-key");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, "suggestion");
  assert.equal(diagnostics[0].message, "Loop key i may be an array position used as React child identity.");
  assert.match(diagnostics[0].caveat ?? "", /stable dictionary key is valid/);
  const location = diagnostics[0].location;
  assert.equal(location.line, 11);
  assert.equal(source.split("\n")[location.line - 1].slice(location.column - 1, location.endColumn - 1), "i");
});

test("recognizes positional and unknown keys without relying on variable names", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-child-indices-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const loops = {
    Generic: `for i, item in props.items do
      children[i] = React.createElement(Row, {})
    end`,
    ExplicitKey: `for i, item in props.items do
      children[item.id] = React.createElement(Row, { key = i })
    end`,
    Ipairs: `for offset, item in ipairs(props.items) do
      children[offset] = React.createElement(Row, {})
    end`,
    ShadowedIpairs: `local ipairs = props.iterator
    for offset, item in ipairs(props.items) do
      children[offset] = React.createElement(Row, {})
    end`,
    Numeric: `for i = 1, #props.items do
      children[i] = React.createElement(Row, {})
    end`,
    UnknownK: `for k, item in props.itemsById do
      children[k] = React.createElement(Row, {})
    end`,
    Stable: `for i, item in props.items do
      children[item.id] = React.createElement(Row, { LayoutOrder = i })
    end`,
  };
  for (const [name, loop] of Object.entries(loops)) {
    fs.writeFileSync(path.join(root, `${name}.luau`), `local React = require(script.Parent.React)
local function Component(props)
  local children = {}
  ${loop}
  return React.createElement(React.Fragment, nil, children)
end
return Component
`);
  }

  const report = await scanPath(root);
  const diagnostics = report.diagnostics.filter((item) => item.rule === "react-luau/no-array-index-as-key");
  assert.deepEqual(diagnostics.map((item) => item.file).sort(), ["ExplicitKey.luau", "Generic.luau", "Ipairs.luau", "Numeric.luau", "ShadowedIpairs.luau", "UnknownK.luau"]);
  for (const diagnostic of diagnostics) {
    assert.equal(diagnostic.message.includes("may be"), !["Ipairs.luau", "Numeric.luau"].includes(diagnostic.file));
  }
});

test("resolves scoped type aliases without treating commented types as declarations", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-child-key-alias-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Scoped.luau"), `local React = require(script.Parent.React)
-- Unicode before aliases: café
type Items = { Item }
--[[
type Items = { [string]: Item }
]]
local function Dictionary(props)
  type Items = { [string]: Item }
  local items: Items = props.items
  local children = {}
  for i, item in items do
    children[i] = React.createElement(Row, {})
  end
  return React.createElement(React.Fragment, nil, children)
end
local function Array(props)
  local items: Items = props.items
  local children = {}
  for k, item in pairs(items) do
    children[k] = React.createElement(Row, {})
  end
  return React.createElement(React.Fragment, nil, children)
end
return Array
`);
  const report = await scanPath(root);
  const diagnostics = report.diagnostics.filter((item) => item.rule === "react-luau/no-array-index-as-key");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].message, "Loop index k is used as React child identity.");
});

test("uses visible collection shapes and types to distinguish positional and dictionary keys", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-child-key-types-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cases = [
    { name: "StringDictionary", type: "{ [string]: Item }", expected: "none" },
    { name: "Array", type: "{ Item }", expected: "array" },
    // Numeric keys can represent stable IDs, so the indexer alone proves no position.
    { name: "NumericMap", type: "{ [number]: Item }", expected: "unknown" },
    { name: "ImportedType", type: "Types.Items", expected: "unknown" },
  ];
  for (const entry of cases) {
    fs.writeFileSync(path.join(root, `${entry.name}.luau`), `local React = require(script.Parent.React)
export type InventoryProps = {
  items: ${entry.type},
}
local function Inventory(props: InventoryProps)
  local children = React.useMemo(function()
    local sortedItems = table.clone(props.items)
    table.sort(sortedItems, function(a, b) return a.rarity > b.rarity end)
    local elements = {}
    for k, item in sortedItems do
      elements[k] = React.createElement(Row, {})
    end
    return elements
  end, { props.items })
  return React.createElement(React.Fragment, nil, children)
end
return Inventory
`);
  }
  const report = await scanPath(root);
  const diagnostics = report.diagnostics.filter((item) => item.rule === "react-luau/no-array-index-as-key");
  for (const entry of cases) {
    const diagnostic = diagnostics.find((item) => item.file === `${entry.name}.luau`);
    if (entry.expected === "none") assert.equal(diagnostic, undefined);
    else {
      assert.ok(diagnostic, entry.name);
      assert.equal(diagnostic.message.includes("may be"), entry.expected === "unknown", entry.name);
    }
  }
});

test("respects local type hints, aliases, dictionary literals and shadowed collections", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-local-child-key-types-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cases = {
    ArrayLiteral: `local items = { props.first, props.second }`,
    DictionaryLiteral: `local items = { First = props.first, Second = props.second }`,
    StringAnnotation: `local items: { [string]: Item } = props.items`,
    ArrayAnnotation: `local items: { Item } = props.items`,
    Alias: `local source = { props.first, props.second }
  local items = source`,
    Shadowed: `local items = { props.first, props.second }
  local items: { [string]: Item } = props.items`,
    Reassigned: `local items = { props.first, props.second }
  items = props.items`,
    ConditionalReassignment: `local items = { props.first, props.second }
  if props.replace then items = props.items end`,
    NumericLiteralMap: `local items = { [100] = props.first, [200] = props.second }`,
    MixedLiteral: `local items = { props.first, Named = props.second }`,
  };
  for (const [name, setup] of Object.entries(cases)) {
    fs.writeFileSync(path.join(root, `${name}.luau`), `local React = require(script.Parent.React)
local function Component(props)
  ${setup}
  local children = {}
  for index, item in items do
    children[index] = React.createElement(Row, {})
  end
  return React.createElement(React.Fragment, nil, children)
end
return Component
`);
  }
  const report = await scanPath(root);
  const diagnostics = report.diagnostics.filter((item) => item.rule === "react-luau/no-array-index-as-key");
  assert.deepEqual(diagnostics.map((item) => item.file).sort(), ["Alias.luau", "ArrayAnnotation.luau", "ArrayLiteral.luau", "ConditionalReassignment.luau", "MixedLiteral.luau", "NumericLiteralMap.luau", "Reassigned.luau"]);
  for (const diagnostic of diagnostics) {
    assert.equal(diagnostic.message.includes("may be"), ["ConditionalReassignment.luau", "MixedLiteral.luau", "NumericLiteralMap.luau", "Reassigned.luau"].includes(diagnostic.file));
  }
});
