import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-function-host-prop", {
  valid: [
    {
      name: "callback ref is allowed",
      code: dedent`
        local function onActivated() end
        local function Component(props)
          return React.createElement("TextButton", { ref = function(rbx) end }, { Child = React.createElement(props.component, { onActivated = onActivated }) })
        end
      `,
    },
    {
      name: "Event handler is allowed",
      code: dedent`
        local function onActivated() end
        local function Component(props)
          return React.createElement("TextButton", { [React.Event.Activated] = onActivated }, { Child = React.createElement(props.component, { onActivated = onActivated }) })
        end
      `,
    },
    {
      name: "ordinary text host prop is allowed",
      code: dedent`
        local function onActivated() end
        local function Component(props)
          return React.createElement("TextButton", { Text = props.text }, { Child = React.createElement(props.component, { onActivated = onActivated }) })
        end
      `,
    },
    {
      name: "callback on a custom component prop is allowed",
      code: dedent`
        local function onActivated() end
        local function Component(props)
          return React.createElement("TextButton", {
          }, { Child = React.createElement(props.component, { onActivated = onActivated }) })
        end
      `,
    },
  ],
  invalid: [
    {
      name: "inline function on a plain host prop",
      code: dedent`
        local function onActivated() end
        local function Component(props)
          return React.createElement("TextButton", { Activated = function() end }, { Child = React.createElement(props.component, { onActivated = onActivated }) })
        end
      `,
      errors: [
        { line: 3, column: 46, message: "Activated is set to a function, which Roblox cannot assign to a TextButton" },
      ],
    },
    {
      name: "named callback on a plain host prop",
      code: dedent`
        local function onActivated() end
        local function Component(props)
          return React.createElement("TextButton", { MouseEnter = onActivated }, { Child = React.createElement(props.component, { onActivated = onActivated }) })
        end
      `,
      errors: [
        { line: 3, column: 46, message: "MouseEnter is set to a function, which Roblox cannot assign to a TextButton" },
      ],
    },
  ],
});
