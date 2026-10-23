import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-create-root-in-render", {
  valid: [
    {
      name: "creating elements during render does not create a root",
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
      name: "root created during render",
      code: dedent`
        local ReactRoblox = require(script.Parent.ReactRoblox)
        local function Component(props)
          ReactRoblox.createRoot(props.target)
          return React.createElement("Frame")
        end
      `,
      errors: [
        { line: 3, column: 3, message: "ReactRoblox.createRoot() is called during component render." },
      ],
    },
  ],
});
