import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/rerender-unnecessary-usememo", {
  valid: [
    {
      name: "unnecessary useMemo does not flag empty-dependency initial-value capture",
      code: dedent`
        local function Component(props)
          local initialName = React.useMemo(function() return props.name end, {})
          return React.createElement("TextLabel", { Text = initialName })
        end
      `,
    },
    {
      name: "empty dependencies capture a random seed once",
      code: dedent`
        local function PerformanceValid(props)
          local seed = React.useMemo(function() return math.random() end, {})
          return React.createElement("Frame", { Name = tostring(seed) })
        end
      `,
    },
    {
      name: "memoized callback is observed by an effect",
      code: dedent`
        local function PerformanceValid(props)
          local cachedCallback = React.useMemo(function() return props.callback end, { props.callback })
          React.useEffect(function() cachedCallback() end, { cachedCallback })
          return React.createElement("Frame")
        end
      `,
    },
    {
      name: "discovery results are memoized",
      code: dedent`
        local ReplicatedStorage = game:GetService("ReplicatedStorage")
        local function PerformanceValid(props)
          local modules = React.useMemo(function() return ReplicatedStorage.Shared.Modules:GetChildren() end, {})
          return React.createElement("Frame", { Name = tostring(modules) })
        end
      `,
    },
  ],
  invalid: [
    {
      name: "trivial memo reads its dependency",
      code: dedent`
        local function Component(props)
          local userName = React.useMemo(function() return props.name end, { props.name })
          return React.createElement("TextLabel", { Text = userName })
        end
      `,
      errors: [
        { line: 2, column: 20, message: "useMemo caches a trivial derived value.", category: "Performance" },
      ],
    },
  ],
});
