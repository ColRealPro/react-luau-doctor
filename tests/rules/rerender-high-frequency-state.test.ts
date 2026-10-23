import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/rerender-high-frequency-state", {
  valid: [
    {
      name: "high-frequency state ignores a provable one-shot guard",
      code: dedent`
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
            return function() connection:Disconnect() end
          end, {})
          return React.createElement("Frame", { Visible = pulsing })
        end
      `,
    },
    {
      name: "frame callback updates only when the edge changes",
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
    {
      name: "high-frequency state requires a real RunService source",
      code: dedent`
        local function Component(props)
          local value, setValue = React.useState(0)
          React.useEffect(function()
            return props.Heartbeat:Connect(function(nextValue) setValue(nextValue) end)
          end, { props.Heartbeat })
          return React.createElement("Frame", { Rotation = value })
        end
      `,
      config: {"rules":{"react-luau/prefer-binding-over-state-candidate":"suggestion"}},
    },
  ],
  invalid: [
    {
      name: "frame callback updates unguarded state",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function Component(props)
          local currentTime, setCurrentTime = React.useState(0)
          RunService.RenderStepped:Connect(function(dt) setCurrentTime(currentTime + dt) end)
          return React.createElement("Frame", { LayoutOrder = currentTime })
        end
      `,
      errors: [
        { line: 3, column: 39, message: "currentTime has a state setter called from a per-frame callback and may cause frequent rerenders when its value changes.", category: "Performance" },
      ],
    },
  ],
});
