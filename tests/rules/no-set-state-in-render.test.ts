import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-set-state-in-render", {
  valid: [
    {
      name: "render setter: local right = props.enabled and setOpen(true)",
      code: dedent`
        local function Component(props)
          local open, setOpen = React.useState(false)
          local right = props.enabled and setOpen(true)
        end
      `,
    },
    {
      name: "render setter: local choice = if props.enabled then setOpen(true) else nil",
      code: dedent`
        local function Component(props)
          local open, setOpen = React.useState(false)
          local choice = if props.enabled then setOpen(true) else nil
        end
      `,
    },
    {
      name: "render setter: if props.enabled then setOpen(true) end",
      code: dedent`
        local function Component(props)
          local open, setOpen = React.useState(false)
          if props.enabled then setOpen(true) end
        end
      `,
    },
    {
      name: "render setter: for _ in {} do setOpen(true) end",
      code: dedent`
        local function Component(props)
          local open, setOpen = React.useState(false)
          for _ in {} do setOpen(true) end
        end
      `,
    },
    {
      name: "render setter: while props.enabled do setOpen(true) end",
      code: dedent`
        local function Component(props)
          local open, setOpen = React.useState(false)
          while props.enabled do setOpen(true) end
        end
      `,
    },
    {
      name: "render setter: repeat if props.enabled then break end until setOpen(true)",
      code: dedent`
        local function Component(props)
          local open, setOpen = React.useState(false)
          repeat if props.enabled then break end until setOpen(true)
        end
      `,
    },
    {
      name: "render setter: React.useEffect(function() setOpen(true) end, {})",
      code: dedent`
        local function Component(props)
          local open, setOpen = React.useState(false)
          React.useEffect(function() setOpen(true) end, {})
        end
      `,
    },
    {
      name: "render setter: do",
      code: dedent`
        local function Component(props)
          local open, setOpen = React.useState(false)
          do
            local setOpen = function(value) return value end
            local ignored = setOpen(true)
          end
        end
      `,
    },
    {
      name: "render setter handler: deferred callback",
      code: dedent`
        local function Component(props)
          local open, setOpen = React.useState(false)
          return React.createElement("TextButton", {
            Visible = open,
            [React.Event.MouseEnter] = function() setOpen(true) end,
          })
        end
      `,
    },
    {
      name: "setter after a guarded early return",
      code: dedent`
        local function Component(props)
          local value, setValue = React.useState(0)
          if not props.enabled then return nil end
          local result = setValue(1)
        end
      `,
    },
    {
      name: "functional state updates run inside event callbacks",
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
    {
      name: "local deferred function can update state",
      code: dedent`
        local function Component(props)
          local open, setOpen = React.useState(false)
          local function deferred() setOpen(true) end
        end
      `,
    },
    {
      name: "same-scope local redeclaration shadows setter",
      code: dedent`
        local function Component(props)
          local value, setValue = React.useState(0)
          local setValue = function() return nil end
          setValue()
        end
      `,
    },
  ],
  invalid: [
    {
      name: "state setter runs during render",
      code: dedent`
        local function Component(props)
          local count, setCount = React.useState(0)
          setCount(1)
        end
      `,
      errors: [
        { line: 3, column: 3, message: "setCount() is called unconditionally during component render" },
      ],
    },
    {
      name: "React namespace detection supports aliased relative-string requires",
      code: dedent`
        local R = require("../../React")
        local function Consumer()
          local count, setCount = R.useState(0)
          setCount(count + 1)
          return R.createElement("Frame")
        end
      `,
      errors: [
        { line: 4, column: 3 },
      ],
    },
    {
      name: "render setter: local first = setOpen(true)",
      code: dedent`
        local function Component(props)
          local open, setOpen = React.useState(false)
          local first = setOpen(true)
        end
      `,
      errors: [
        { line: 3, column: 17, message: "setOpen() is called unconditionally during component render" },
      ],
    },
    {
      name: "render setter: consume(update(true))",
      code: dedent`
        local function Component(props)
          local open, setOpen = React.useState(false)
          local update = setOpen
          consume(update(true))
        end
      `,
      errors: [
        { line: 4, column: 11, message: "update() is called unconditionally during component render" },
      ],
    },
    {
      name: "render setter: do",
      code: dedent`
        local function Component(props)
          local open, setOpen = React.useState(false)
          do
            setOpen(true)
          end
        end
      `,
      errors: [
        { line: 4, column: 5 },
      ],
    },
    {
      name: "render setter: local left = setOpen(true) or props.enabled",
      code: dedent`
        local function Component(props)
          local open, setOpen = React.useState(false)
          local left = setOpen(true) or props.enabled
        end
      `,
      errors: [
        { line: 3, column: 16 },
      ],
    },
    {
      name: "render setter handler: eager invocation",
      code: dedent`
        local function Component(props)
          local open, setOpen = React.useState(false)
          local update = setOpen
          return React.createElement("TextButton", {
            Visible = open,
            [React.Event.Activated] = update(true),
          })
        end
      `,
      errors: [
        { line: 6, column: 31 },
      ],
    },
  ],
});
