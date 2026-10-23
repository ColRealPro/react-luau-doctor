import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/unstable-context-value", {
  valid: [
    {
      name: "value datatype context",
      code: dedent`
        local Context = React.createContext(nil)
        local function Component(props)
          local gradient = props.enabled and ColorSequence.new({
            ColorSequenceKeypoint.new(0, Color3.fromHex("ffffff")),
            ColorSequenceKeypoint.new(1, Color3.fromRGB(0, 0, 0)),
          }) or ColorSequence.new(Color3.new(0, 0, 0))
          return React.createElement(Context.Provider, { value = gradient })
        end
      `,
    },
  ],
  invalid: [
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
        { file: "Component.luau", line: 8, column: 50, message: "Context Provider can receive a new reference value when the component renders", severity: "warning" },
      ],
    },
  ],
});
