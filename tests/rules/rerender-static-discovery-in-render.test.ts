import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/rerender-static-discovery-in-render", {
  valid: [
    {
      name: "static discovery runs in an empty-dependency memo",
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
      name: "static module discovery inside render",
      code: dedent`
        local ReplicatedStorage = game:GetService("ReplicatedStorage")
        local function Component(props)
          local modules = {}
          for _, module in ReplicatedStorage.Shared.Modules:GetChildren() do
            modules[module.Name] = require(module)
          end
          return React.createElement("Frame", { Name = tostring(modules) })
        end
      `,
      errors: [
        { line: 4, column: 20, message: "ReplicatedStorage.Shared.Modules:GetChildren runs during component render and feeds module requires.", category: "Performance" },
      ],
    },
  ],
});
