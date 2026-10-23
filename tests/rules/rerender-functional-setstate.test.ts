import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/rerender-functional-setstate", {
  valid: [
    {
      name: "functional updates receive previous state",
      code: dedent`
        local function buildInitialItems()
          return {}
        end
        local function AdvancedValid(props)
          local count, setCount = React.useState(0)
          local items, setItems = React.useState(function() return buildInitialItems() end)
          local function onActivated()
            setCount(function(previous) return previous + 1 end)
            setItems(function(previous)
              local nextItems = table.clone(previous)
              nextItems[props.id] = props.value
              return nextItems
            end)
          end
          return React.createElement("TextButton", { Text = tostring(count) .. tostring(#items), [React.Event.Activated] = onActivated })
        end
      `,
    },
  ],
  invalid: [
    {
      name: "closure update reads current state",
      code: dedent`
        local function Component(props)
          local count, setCount = React.useState(0)
          React.useEffect(function() setCount(count + 1) end, { count })
          return React.createElement("Frame", { LayoutOrder = count })
        end
      `,
      errors: [
        { line: 3, column: 30, message: "setCount() reads count from a captured callback value." },
      ],
    },
  ],
});
