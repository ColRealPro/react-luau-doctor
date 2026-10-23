import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-effect-with-fresh-deps", {
  valid: [
    {
      name: "memoized context retains stable dependencies",
      code: dedent`
        local StableContext = React.createContext(nil)
        local function AdvancedValid(props)
          local count, setCount = React.useState(0)
          local contextValue = React.useMemo(function() return { count = count } end, { count })
          return React.createElement(StableContext.Provider, { value = contextValue })
        end
      `,
    },
    {
      name: "bindings and binding setters are stable dependencies",
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
    {
      name: "value datatypes and persistent references are stable dependencies",
      code: dedent`
        local constant = {}
        local function Component(props)
          local state = React.useState({})
          local memo = React.useMemo(function() return {} end, {})
          local callback = React.useCallback(function() end, {})
          local gradient = props.enabled and ColorSequence.new({
            ColorSequenceKeypoint.new(0, Color3.fromHex("ffffff")),
            ColorSequenceKeypoint.new(1, Color3.fromRGB(0, 0, 0)),
          }) or ColorSequence.new(Color3.new(0, 0, 0))
          React.useEffect(function() consume(gradient) end, { gradient, state, memo, callback, constant })
        end
      `,
    },
  ],
  invalid: [
    {
      name: "render creates a fresh dependency table",
      code: dedent`
        local function Component(props)
          local options = {}
          React.useEffect(function() print(options) end, { options })
        end
      `,
      errors: [
        { line: 3, column: 52, message: "React.useEffect depends on options that can be a new table when the component renders" },
      ],
    },
    {
      name: "hook dependencies and context values share render reference analysis",
      code: dedent`
        local Context = React.createContext(nil)
        local function build() return table.create(0) end
        local function Component(props)
          local params = RaycastParams.new()
          local value = build()
          local alias = value
          React.useEffect(function() consume(alias, params) end, { alias, params, props.enabled and {} })
          return React.createElement(Context.Provider, { value = if props.enabled then alias else props.value })
        end
      `,
      errors: [
        { file: "Component.luau", line: 7, column: 60, message: "React.useEffect depends on alias that can be a new table when the component renders", severity: "error" },
        { file: "Component.luau", line: 7, column: 67, message: "React.useEffect depends on params that can be a new object when the component renders", severity: "error" },
        { file: "Component.luau", line: 7, column: 75, message: "React.useEffect depends on an inline value that can be a new table when the component renders", severity: "error" },
      ],
    },
  ],
});
