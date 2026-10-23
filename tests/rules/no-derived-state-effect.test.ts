import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-derived-state-effect", {
  valid: [
    {
      name: "effect updates a binding instead of derived state",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function AdvancedValid(props)
          local animated, setAnimated = React.useBinding(0)
          React.useEffect(function()
            local connection = RunService.RenderStepped:Connect(function(dt) setAnimated(animated:getValue() + dt) end)
            return function() connection:Disconnect() end
          end, { animated, setAnimated })
        end
      `,
    },
  ],
  invalid: [
    {
      name: "effect derives state from props",
      code: dedent`
        local function Component(props)
          local expensive, setExpensive = React.useState(0)
          React.useEffect(function() setExpensive(props.value * 2) end, { props })
        end
      `,
      errors: [
        { line: 3, column: 30, message: "setExpensive() stores a value derived from props inside an effect." },
      ],
    },
    {
      name: "code quoted in findings keeps its comments",
      code: dedent`
        local function Counter(props)
          local doubled, setDoubled = React.useState(0)
          React.useEffect(function() setDoubled(props.count --[[ raw ]] * 2) end, { props.count })
        end
      `,
      errors: [
        { line: 3, column: 30, message: "setDoubled() stores a value derived from props inside an effect.", fixPreview: {"kind":"pattern","before":"setDoubled(props.count --[[ raw ]] * 2)","after":"local doubled = props.count --[[ raw ]] * 2","note":"Remove the state pair and the setter call if the effect has no other work. Keep state when the delay is intentional."} },
      ],
    },
  ],
});
