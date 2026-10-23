import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/rerender-state-only-in-handlers", {
  valid: [
    {
      name: "state is read by render as well as event callbacks",
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
      name: "state is read only by an event handler",
      code: dedent`
        local function Component(props)
          local handlerOnly, setHandlerOnly = React.useState(0)
          local function onActivated()
            setHandlerOnly(handlerOnly + 1)
            print(handlerOnly)
          end
          return React.createElement("TextButton", { [React.Event.Activated] = onActivated })
        end
      `,
      errors: [
        { line: 2, column: 9, message: "handlerOnly is updated as React state but is never read by the component's render path or hook arguments." },
      ],
    },
    {
      name: "state only read inside a render Binding:map suggests a binding instead of a ref",
      code: dedent`
        local function Component(props)
          local offset, setOffset = React.useState(0)
          React.useEffect(function() setOffset(props.target) end, { props.target })
          return React.createElement("Frame", {
            Position = props.progress:map(function(value) return UDim2.fromOffset(offset, value) end),
          })
        end
      `,
      errors: [
        { line: 2, column: 9, message: "offset is React state that is only read inside a Binding:map callback", help: "Make this value a binding with React.useBinding and combine it with React.joinBindings so updates skip rerendering. A ref would leave the mapped value stale", fixPreview: {"kind":"pattern","before":"local offset, setOffset = React.useState(initial)\nlocal position = progress:map(function(value)\n\treturn UDim2.fromOffset(offset, value)\nend)","after":"local offset, setOffset = React.useBinding(initial)\nlocal position = React.joinBindings({ progress, offset }):map(function(values)\n\treturn UDim2.fromOffset(values[2], values[1])\nend)","note":"setOffset keeps working the same way, but updates the binding without rerendering"} },
      ],
    },
  ],
});
