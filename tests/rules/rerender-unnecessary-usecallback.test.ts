import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/rerender-unnecessary-usecallback", {
  valid: [
    {
      name: "stable callback is passed to a memoized component",
      files: {
        "Component.luau": dedent`
          local MemoChildCustom = require(script.Parent.MemoChildCustom)
          local function PerformanceValid(props)
            local value, setValue = React.useState(0)
            local onClick = React.useCallback(function() setValue(function(previous) return previous + 1 end) end, {})
            return React.createElement(MemoChildCustom, { onClick = onClick, value = value })
          end
        `,
        "MemoChildCustom.luau": dedent`
          local function MemoChildCustom(props)
            return React.createElement("Frame", { Name = tostring(props.value) })
          end
          return React.memo(MemoChildCustom, function(previous, next) return previous.value == next.value end)
        `,
      },
    },
  ],
  invalid: [
    {
      name: "callback has no captures or observed identity",
      code: dedent`
        local function Component(props)
          local safeClamp = React.useCallback(function(value) return math.clamp(value, 0, 1) end, {})
          return React.createElement("Frame", { LayoutOrder = safeClamp(props.value) })
        end
      `,
      errors: [
        { line: 2, column: 21, message: "safeClamp is wrapped in useCallback, but its identity is never observed.", category: "Performance" },
      ],
    },
    {
      name: "useCallback captured by a dependency hook is unobserved only when its captures are stable",
      files: {
        "Component.luau": dedent`
          local function Component(props)
            local open, setOpen = React.useState(false)
            local close = React.useCallback(function() setOpen(false) end, {})
            local notify = React.useCallback(function() props.onClose() end, { props.onClose })
            local reset = React.useCallback(function() setOpen(false) end, { setOpen })
            React.useEffect(function()
              if not props.visible then
                close()
                notify()
                reset()
              end
            end, { props.visible, notify })
            return React.createElement("Frame", { Visible = open })
          end
        `,
        "Plain.luau": dedent`
          local function Plain(props)
            local open, setOpen = React.useState(false)
            local close = function() setOpen(false) end
            local notify = function() props.onClose() end
            React.useEffect(function()
              if not props.visible then
                close()
                notify()
              end
            end, { props.visible, props.onClose })
            return React.createElement("Frame", { Visible = open })
          end
          return Plain
        `,
      },
      errors: [
        { file: "Component.luau", line: 3, column: 17, message: "close is wrapped in useCallback, but its identity is never observed.", severity: "warning" },
        { file: "Component.luau", line: 5, column: 17, message: "reset is wrapped in useCallback, but its identity is never observed.", severity: "warning" },
      ],
    },
  ],
});
