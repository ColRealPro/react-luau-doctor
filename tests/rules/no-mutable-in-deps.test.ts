import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-mutable-in-deps", {
  valid: [
    {
      name: "dependency analysis respects nested shadowing and hook bindings are scoped per function",
      code: dedent`
        local function FirstComponent()
          local ref = React.useRef(nil)
        end
        local function SecondComponent(props)
          local value = props.value
          local ref = props.externalRef
          React.useEffect(function()
            local function consume(value)
              print(value)
            end
            consume(1)
            print(props.title)
            print(ref.current)
          end, { props.title, ref.current })
        end
      `,
    },
    {
      name: "binding and setter dependencies are stable",
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
      name: "mutable ref field appears in dependencies",
      code: dedent`
        local function Component(props)
          local cacheRef = React.useRef(nil)
          React.useEffect(function() print(cacheRef.current) end, { cacheRef.current })
        end
      `,
      errors: [
        { line: 3, column: 61, message: "cacheRef.current is mutable ref state and will not itself trigger a React render when it changes." },
      ],
    },
  ],
});
