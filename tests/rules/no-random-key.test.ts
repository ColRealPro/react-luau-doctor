import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-random-key", {
  valid: [
    {
      name: "stable identifiers are component keys",
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
      name: "random value used as a key",
      code: dedent`
        local HttpService = game:GetService("HttpService")
        local function Component(props)
          return React.createElement("Frame", { key = HttpService:GenerateGUID(false) })
        end
      `,
      errors: [
        { line: 3, column: 47, message: "React key is created from HttpService:GenerateGUID(), so its identity can change every render." },
      ],
    },
  ],
});
