import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/rerender-static-state", {
  valid: [
    {
      name: "state changes through an observed callback",
      code: dedent`
        local function PerformanceValid(props)
          local value, setValue = React.useState(0)
          local onClick = React.useCallback(function() setValue(function(previous) return previous + 1 end) end, {})
          return React.createElement("TextButton", { LayoutOrder = value, [React.Event.Activated] = onClick })
        end
      `,
    },
    {
      name: "guarded frame updates still change state",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function PerformanceValid(props)
          local edge, setEdge = React.useState("None")
          RunService.RenderStepped:Connect(function()
            local nextEdge = props.edge
            if edge ~= nextEdge then
              setEdge(nextEdge)
            end
          end)
          return React.createElement("Frame", { Name = edge })
        end
      `,
    },
  ],
  invalid: [
    {
      name: "state value never changes",
      code: dedent`
        local function Component(props)
          local textColor, setTextColor = React.useState(Color3.fromRGB(255, 255, 255))
          return React.createElement("Frame", { BackgroundColor3 = textColor })
        end
      `,
      errors: [
        { line: 2, column: 20, message: "textColor cannot change because setTextColor is never used.", category: "Performance" },
      ],
    },
  ],
});
