import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-nested-component-definition", {
  valid: [
    {
      name: "child component is defined at module scope",
      code: dedent`
        local function buildInitialItems()
          return {}
        end
        local function Card(props)
          return React.createElement("TextLabel", { Text = props.text })
        end
        local function AdvancedValid(props)
          local count, setCount = React.useState(0)
          local items, setItems = React.useState(function() return buildInitialItems() end)
          return React.createElement(Card, { key = props.id, id = props.id, text = tostring(count) .. ":" .. tostring(#items) })
        end
      `,
    },
  ],
  invalid: [
    {
      name: "child component declared inside render",
      code: dedent`
        local function Component(props)
          local function NestedCard()
            return React.createElement("Frame", { Name = props.title })
          end
          return React.createElement(NestedCard)
        end
      `,
      errors: [
        { line: 2, column: 18, message: "NestedCard is defined inside Component and rendered as a component type." },
      ],
    },
  ],
});
