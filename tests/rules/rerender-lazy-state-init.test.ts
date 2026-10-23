import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/rerender-lazy-state-init", {
  valid: [
    {
      name: "literal and value datatype state initializers are cheap",
      code: dedent`
        local function Component(props)
          local position = React.useState(UDim2.fromScale(0, 0))
          local count = React.useState(0)
          return React.createElement("Frame", { Position = position, LayoutOrder = count })
        end
      `,
    },
    {
      name: "state initialization uses a lazy factory",
      code: dedent`
        local function buildInitialItems()
          return {}
        end
        local function AdvancedValid(props)
          local items, setItems = React.useState(function() return buildInitialItems() end)
          return React.createElement("Frame", { Text = tostring(#items) })
        end
      `,
    },
  ],
  invalid: [
    {
      name: "state initializer eagerly calls a factory",
      code: dedent`
        local function buildCache() return { created = true } end
        local function Component(props)
          local expensive = React.useState(buildCache())
          return React.createElement("Frame", { Name = tostring(expensive) })
        end
      `,
      errors: [
        { line: 3, column: 36, message: "buildCache is evaluated every render before useState can reuse the existing state." },
      ],
    },
  ],
});
