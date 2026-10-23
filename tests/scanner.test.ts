import { expect, test, onTestFinished } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanPath } from "../src/scanner";
import { dedent, lint } from "./helpers/rule-tester";

test("syntax verification survives diagnostic suppression and cached reports without changing configured findings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-syntax-verification-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "Component.luau");
  fs.writeFileSync(filename, dedent`
    local React = require(script.Parent.React)
    return React.createElement("Frame", {
  `);
  const config = { rules: { "react-luau/parse-error": "off" as const } };
  const first = await scanPath(root, { config, parallel: false });
  expect(first.unverifiedFiles).toEqual(["Component.luau"]);
  expect(first.diagnostics.filter(entry => entry.rule === "react-luau/parse-error")).toEqual([]);
  const cached = await scanPath(root, { config, parallel: false });
  expect(cached.unverifiedFiles).toEqual(first.unverifiedFiles);
  fs.writeFileSync(filename, dedent`
    local React = require(script.Parent.React)
    return React.createElement("Frame")
  `);
  const fixed = await scanPath(root, { config, parallel: false });
  expect(fixed.unverifiedFiles).toBe(undefined);
  expect(fixed.diagnostics.length).toBe(0);
});

test("comments and Luau's parse error limit don't change analysis of surrounding code", async () => {
  const report = await lint({
    "Broken.luau": dedent`
      local React = require(script.Parent.React)
      !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

    `,
    "List.luau": dedent`
      local React = require(script.Parent.React)
      type Items = --[[ by id ]] { -- keyed by id
        [string]: number
      }
      local function List(props: { items: Items })
        local children = {}
        for id, value in pairs(props.items) do
          children[id] = React.createElement("Frame")
        end
        return React.createElement("Frame", nil, children)
      end
      return List
    `,
    "Parent.luau": dedent`
      local React = require(script.Parent.React)
      local Child = React.memo(function() return React.createElement("Frame") end)
      local function Parent(props)
        return React.createElement(Child, { value = props.enabled --[[a]] and { key --[[b]] = 1 } })
      end
      return Parent
    `
  }, {});
  expect(report.diagnostics.filter(d => d.file !== "Broken.luau").map(d => ({ rule: d.rule, file: d.file, line: d.location.line, column: d.location.column, message: d.message, severity: d.severity }))).toEqual([
    {
      rule: "react-luau/rerender-unstable-memo-props",
      file: "Parent.luau",
      line: 4,
      column: 39,
      message: "Memoized Child can receive fresh value prop when its parent renders",
      severity: "warning"
    }
  ]);
});

test("specific Binding warning supersedes generic high-frequency state warning", async () => {
  const report = await lint({
    "Component.luau": dedent`
      local React = require(script.Parent.React)
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

      return Component
    `
  }, {});
  expect(report.diagnostics.filter(d => ["react-luau/prefer-binding-over-state", "react-luau/rerender-high-frequency-state"].includes(d.rule)).map(({ location, ...d }) => ({ ...d, line: location.line, column: location.column }))).toMatchObject([
    {
      rule: "react-luau/prefer-binding-over-state",
      file: "Component.luau",
      line: 5,
      column: 33,
      message: "State position is updated from a high-frequency callback and only feeds presentation updates that do not need React reconciliation.",
      severity: "warning"
    }
  ]);
  expect(report.diagnostics.filter(d => ["react-luau/prefer-binding-over-state", "react-luau/rerender-high-frequency-state"].includes(d.rule))).toHaveLength(1);
});

test("high-frequency state warning remains when React reconciliation is required", async () => {
  const report = await lint({
    "Component.luau": dedent`
      local React = require(script.Parent.React)
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

      return Component
    `
  }, {});
  expect(report.diagnostics.filter(d => ["react-luau/rerender-high-frequency-state", "react-luau/prefer-binding-over-state"].includes(d.rule)).map(({ location, ...d }) => ({ ...d, line: location.line, column: location.column }))).toMatchObject([
    {
      rule: "react-luau/rerender-high-frequency-state",
      file: "Component.luau",
      line: 5,
      column: 33,
      message: "position has a state setter called from a per-frame callback and may cause frequent rerenders when its value changes.",
      severity: "warning"
    }
  ]);
  expect(report.diagnostics.filter(d => ["react-luau/rerender-high-frequency-state", "react-luau/prefer-binding-over-state"].includes(d.rule))).toHaveLength(1);
});

test("mixed high-frequency state keeps generic warning and Binding candidate", async () => {
  const report = await lint({
    "Component.luau": dedent`
      local React = require(script.Parent.React)
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

      return Component
    `
  }, {
    config: {
      rules: {
        "react-luau/prefer-binding-over-state-candidate": "suggestion"
      }
    }
  });
  expect(report.diagnostics.filter(d => ["react-luau/rerender-high-frequency-state", "react-luau/prefer-binding-over-state", "react-luau/prefer-binding-over-state-candidate"].includes(d.rule)).map(({ location, ...d }) => ({ ...d, line: location.line, column: location.column }))).toMatchObject([
    {
      rule: "react-luau/rerender-high-frequency-state",
      file: "Component.luau",
      line: 5,
      column: 33,
      message: "position has a state setter called from a per-frame callback and may cause frequent rerenders when its value changes.",
      severity: "warning"
    },
    {
      rule: "react-luau/prefer-binding-over-state-candidate",
      file: "Component.luau",
      line: 5,
      column: 33,
      message: "State position has presentation-oriented consumers, but other uses still appear to need React reconciliation.",
      severity: "suggestion"
    }
  ]);
  expect(report.diagnostics.filter(d => ["react-luau/rerender-high-frequency-state", "react-luau/prefer-binding-over-state", "react-luau/prefer-binding-over-state-candidate"].includes(d.rule))).toHaveLength(2);
});

test("a lower-severity Binding diagnostic does not hide a stronger high-frequency warning", async () => {
  const report = await lint({
    "Component.luau": dedent`
      local React = require(script.Parent.React)
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

      return Component
    `
  }, {
    config: {
      rules: {
        "react-luau/prefer-binding-over-state": "suggestion"
      }
    }
  });
  expect(report.diagnostics.filter(d => ["react-luau/prefer-binding-over-state", "react-luau/rerender-high-frequency-state"].includes(d.rule)).map(({ location, ...d }) => ({ ...d, line: location.line, column: location.column }))).toMatchObject([
    {
      rule: "react-luau/rerender-high-frequency-state",
      file: "Component.luau",
      line: 5,
      column: 33,
      message: "position has a state setter called from a per-frame callback and may cause frequent rerenders when its value changes.",
      severity: "warning"
    },
    {
      rule: "react-luau/prefer-binding-over-state",
      file: "Component.luau",
      line: 5,
      column: 33,
      message: "State position is updated from a high-frequency callback and only feeds presentation updates that do not need React reconciliation.",
      severity: "suggestion"
    }
  ]);
  expect(report.diagnostics.filter(d => ["react-luau/prefer-binding-over-state", "react-luau/rerender-high-frequency-state"].includes(d.rule))).toHaveLength(2);
});

test("disabling the specific Binding rule preserves the high-frequency warning", async () => {
  const report = await lint({
    "Component.luau": dedent`
      local React = require(script.Parent.React)
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

      return Component
    `
  }, {
    config: {
      rules: {
        "react-luau/prefer-binding-over-state": "off"
      }
    }
  });
  expect(report.diagnostics.filter(d => ["react-luau/prefer-binding-over-state", "react-luau/rerender-high-frequency-state"].includes(d.rule)).map(({ location, ...d }) => ({ ...d, line: location.line, column: location.column }))).toMatchObject([
    {
      rule: "react-luau/rerender-high-frequency-state",
      file: "Component.luau",
      line: 5,
      column: 33,
      message: "position has a state setter called from a per-frame callback and may cause frequent rerenders when its value changes.",
      severity: "warning"
    }
  ]);
  expect(report.diagnostics.filter(d => ["react-luau/prefer-binding-over-state", "react-luau/rerender-high-frequency-state"].includes(d.rule))).toHaveLength(1);
});

test("configuration can disable rules and override severities", async () => {
  const report = await lint(dedent`
    local React = require(script.Parent.React)
    local function Component(props)
      props.value = 1
      React.useEffect(function() print(props.value) end, { unpack(props.dependencies) })
      return React.createElement("Frame")
    end
    return Component
  `, { config: { rules: {
    "react-luau/no-prop-mutation": "off",
    "react-luau/exhaustive-deps": "error",
  } } });
  expect(report.diagnostics.filter(d => d.rule === "react-luau/no-prop-mutation")).toEqual([]);
  expect(report.diagnostics.filter(d => d.rule === "react-luau/exhaustive-deps")).toMatchObject([
    { severity: "error" },
  ]);
  expect(report.diagnostics.filter(d => d.rule === "react-luau/exhaustive-deps")).toHaveLength(1);
});

test("accepts modern Luau const, export-by-value, attributes, type functions, explicit type arguments, and integer literals", async () => {
  const report = await lint(dedent`
    local React = require(script.Parent.React)
    type function IdentityType(value)
      return value
    end
    declare extern type NativeHandle with
      read Id: number
    end
    @[deprecated { reason = "legacy helper" }]
    local function identity<T>(value: T): T
      return value
    end
    export const Component = @native function(props)
      const integers = { 123i, 1_000i, 0xABABi, 0b1000_1000i }
      const value: number = React.useMemo(function() return identity<<number>>(props.value) end, { props.value })
      props.value = value
      return React.createElement("Frame")
    end
  `, { filename: "Modern.luau" });
  expect(report.unverifiedFiles).toBeUndefined();
  expect(report.diagnostics).toMatchObject([{
    rule: "react-luau/no-prop-mutation",
    file: "Modern.luau",
    location: { line: 15, column: 3 },
    message: "Component mutates props directly.",
    severity: "error",
  }]);
  expect(report.diagnostics).toHaveLength(1);
  expect(report.scannedFiles).toBe(1);
});

test("typed hook syntax parses and diagnostics after non-ASCII text keep source columns", async () => {
  const report = await lint({
    "Component.luau": dedent`
      local React = require(script.Parent.React)
      local function Component<T...>(props: { label: string }, ...: T...): React.Element
        local greeting: typeof(props.label) = "héllo 😀"; props.label = greeting
        local value = React.useMemo(function() return nil :: { hasValue: true } | nil end, {})
        return React.createElement("TextLabel", { Text = tostring(value) })
      end
      return Component
    `
  }, {});
  expect(report.diagnostics.filter(d => ["react-luau/parse-error", "react-luau/no-prop-mutation"].includes(d.rule)).map(({ location, ...d }) => ({ ...d, line: location.line, column: location.column }))).toMatchObject([
    {
      rule: "react-luau/no-prop-mutation",
      file: "Component.luau",
      line: 3,
      column: 53,
      message: "Component mutates props directly.",
      severity: "error"
    }
  ]);
  expect(report.diagnostics.filter(d => ["react-luau/parse-error", "react-luau/no-prop-mutation"].includes(d.rule))).toHaveLength(1);
  expect(report.unverifiedFiles).toBeUndefined();
});

test("scans of part of a project keep transitive effects without caching a partial effect set", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-scoped-effects-"));
  const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-scoped-effects-cache-"));
  const previousCache = process.env.REACT_LUAU_DOCTOR_CACHE_DIR;
  process.env.REACT_LUAU_DOCTOR_CACHE_DIR = cacheDirectory;

  onTestFinished(() => {
    if (previousCache === undefined) delete process.env.REACT_LUAU_DOCTOR_CACHE_DIR;
    else process.env.REACT_LUAU_DOCTOR_CACHE_DIR = previousCache;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cacheDirectory, { recursive: true, force: true });
  });

  for (const area of ["First", "Second"]) {
    fs.mkdirSync(path.join(root, area));

    fs.writeFileSync(path.join(root, area, `${area}Mutator.luau`), dedent`
      local stored = {}
      local function mutateStored()
        stored.changed = true
      end
      return mutateStored

    `);

    fs.writeFileSync(path.join(root, area, `${area}Wrapper.luau`), dedent`
      local mutateStored = require(script.Parent.${area}Mutator)
      local function performWork()
        mutateStored()
      end
      return performWork
    `);

    fs.writeFileSync(path.join(root, area, `${area}Component.luau`), dedent`
      local React = require(script.Parent.React)
      local performWork = require(script.Parent.${area}Wrapper)
      local function Component()
        performWork()
        return React.createElement("Frame")
      end
      return Component
    `);
  }

  for (const area of ["First", "Second"]) {
    const report = await scanPath(path.join(root, area), { projectRoot: root, parallel: false });

    expect(report.diagnostics.filter(entry => entry.rule === "react-luau/no-side-effects-in-render")
      .map(entry => ({ file: entry.file, line: entry.location.line, column: entry.location.column, message: entry.message }))).toEqual([{
        file: `${area}/${area}Component.luau`,
        line: 4,
        column: 3,
        message: "performWork runs during render, and code it calls eventually changes state outside the current render.",
      }]);
  }
});

test("typeof types and casts before comparisons parse cleanly", async () => {
  const report = await lint({
    "Component.luau": dedent`
      local React = require(script.Parent.React)
      local Base = require(script.Parent.Base)

      local context = React.createContext(nil :: Base | typeof(Base))

      local function render(component: typeof(Base) | string, value: typeof(Base.value)?): typeof(Base)
        return component :: typeof(Base)
      end

      local function Component(props)
        local ref = React.useRef(nil :: typeof(props.value)?)
        if ref.current :: number <= 0 and typeof(props.value) == "number" then
          return nil
        end
        return React.createElement("Frame", { Name = render("Frame", nil) })
      end

      return Component :: typeof(Component)

    `
  }, {});
  expect(report.diagnostics.filter(d => ["react-luau/parse-error"].includes(d.rule)).map(({ location, ...d }) => ({ ...d, line: location.line, column: location.column }))).toMatchObject([]);
  expect(report.diagnostics.filter(d => ["react-luau/parse-error"].includes(d.rule))).toHaveLength(0);
  expect(report.unverifiedFiles).toBeUndefined();
});

test("typeof in type brackets, commented unions, and builtin-named function type parameters parse cleanly", async () => {
  const report = await lint({
    "Component.luau": dedent`
      local React = require(script.Parent.React)
      local Base = require(script.Parent.Base)

      export type Variant =
        typeof(Base.A)
        -- Deprecated
        | typeof(Base.B)

      export type Props = Readonly<
        {
          value: number,
        }
      >

      local renderers: { [typeof("Frame") | string]: (number: number, string: string) -> () } = {}

      local function Component(props)
        local ref = nil :: Ref<typeof(Base)> | nil
        local kind = renderers[typeof(props.value)]
        return React.createElement("Frame", { Name = tostring(ref) .. tostring(kind) })
      end

      return Component

    `
  }, {});
  expect(report.diagnostics.filter(d => ["react-luau/parse-error"].includes(d.rule)).map(({ location, ...d }) => ({ ...d, line: location.line, column: location.column }))).toMatchObject([]);
  expect(report.diagnostics.filter(d => ["react-luau/parse-error"].includes(d.rule))).toHaveLength(0);
  expect(report.unverifiedFiles).toBeUndefined();
});

test("directory scans skip non-React Luau files automatically", async () => {
  const report = await lint({
    "Component.luau": dedent`
      local React = require(script.Parent.React)
      return React.createElement("Frame")
    `,
    "Utility.luau": dedent`
      local value = {}
      value.changed = true
      return value
    `,
  });
  expect(report.candidateFiles).toBe(2);
  expect(report.scannedFiles).toBe(1);
  expect(report.diagnostics).toEqual([]);
});

test("inline suppressions can hide exact rules and audit mode can ignore suppressions", async () => {
  const code = dedent`
    local React = require(script.Parent.React)
    local function Component(props)
      -- react-luau-doctor-disable-next-line no-prop-mutation
      props.value = 1
      -- react-luau-doctor-disable react-luau/no-prop-mutation
      props.other = 2
      -- react-luau-doctor-enable react-luau/no-prop-mutation
      props.third = 3
      return React.createElement("Frame")
    end
    return Component
  `;
  const normal = await lint(code);
  const audit = await lint(code, { respectInlineDisables: false });
  const lines = (report: typeof normal) => report.diagnostics.filter(d => d.rule === "react-luau/no-prop-mutation").map(d => d.location.line);
  expect(lines(normal)).toEqual([8]);
  expect(lines(audit)).toEqual([4, 6, 8]);
});

test("project-aware memo analysis still resolves unchanged memoized modules in scoped file scans", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-scoped-memo-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Child.luau"), dedent`
    local React = require(script.Parent.React)
    return React.memo(function() return React.createElement("Frame") end)
  `);
  const source = dedent`
    local React = require(script.Parent.React)
    local Child = require(script.Parent.Child)
    local function Component() return React.createElement(Child, { value = {} }) end
    return Component
  `;
  const file = path.join(root, "Component.luau");
  fs.writeFileSync(file, source);
  await scanPath(root, { parallel: false });
  const report = await scanPath(root, { parallel: false, files: [{ absolutePath: file, relativePath: "Component.luau" }] });
  expect(report.diagnostics).toMatchObject([{ rule: "react-luau/rerender-unstable-memo-props", file: "Component.luau", location: { line: 3, column: 64 } }]);
  expect(report.diagnostics).toHaveLength(1);
});

test("reports Luau parse errors before downstream analysis", async () => {
  const report = await lint(dedent`
    local React = require(script.Parent.React)

    local function BrokenComponent(props
        return React.createElement("Frame")
    end

    return BrokenComponent

  `);
  expect(report.unverifiedFiles).toEqual(["Component.luau"]);
  expect(report.diagnostics.map(({ rule, location, message, severity }) => ({ rule, location, message, severity }))).toEqual([
    {
      "rule": "react-luau/parse-error",
      "location": {
        "line": 4,
        "column": 5,
        "endLine": 4,
        "endColumn": 11
      },
      "message": "Expected ')' (to close '(' at line 3), got 'return'",
      "severity": "error"
    }
  ]);
});

test("diagnostics have deterministic file and source order", async () => {
  const code = dedent`
    local React = require(script.Parent.React)
    local function Component(props)
      props.first = 1
      props.second = 2
      return React.createElement("Frame")
    end
    return Component
  `;
  const first = await lint({ "Z.luau": code, "A.luau": code });
  const second = await lint({ "A.luau": code, "Z.luau": code });
  expect(first.diagnostics.map(d => [d.file, d.location.line, d.rule])).toEqual([
    ["A.luau", 3, "react-luau/no-prop-mutation"],
    ["A.luau", 4, "react-luau/no-prop-mutation"],
    ["Z.luau", 3, "react-luau/no-prop-mutation"],
    ["Z.luau", 4, "react-luau/no-prop-mutation"],
  ]);
  expect(first.diagnostics.map(d => d.id)).toEqual(second.diagnostics.map(d => d.id));
});
