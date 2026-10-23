import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-create-binding-in-render", {
  valid: [
    {
      name: "binding creation in guarded lazy ref initialization",
      code: dedent`
        local createBinding = React.createBinding
        local shared = createBinding(0)
        local function Component()
          local handle = React.useRef(nil)
          if handle.current == nil then
            handle.current = createBinding(0)
          else
            print("already initialized")
          end
          React.useEffect(function() createBinding(0) end, {})
          return React.createElement("TextButton", { Text = value })
        end
      `,
    },
    {
      name: "binding creation in an effect",
      code: dedent`
        local createBinding = React.createBinding
        local shared = createBinding(0)
        local function Component()
          React.useEffect(function() createBinding(0) end, {})
          return React.createElement("TextButton", { Text = value })
        end
      `,
    },
    {
      name: "binding creation in an event callback",
      code: dedent`
        local createBinding = React.createBinding
        local shared = createBinding(0)
        local function Component()
          return React.createElement("TextButton", {
            Text = value,
            [React.Event.Activated] = function() createBinding(0) end,
          })
        end
      `,
    },
    {
      name: "shadowed React createBinding method",
      code: dedent`
        local function Other(React)
          React.useState(0)
          local binding = React.createBinding(0)
          return React.createElement("Frame")
        end
      `,
    },
  ],
  invalid: [
    {
      name: "createBinding during render",
      code: dedent`
        local createBinding = React.createBinding
        local shared = createBinding(0)
        local function Component()
          local value = createBinding(0)
          return React.createElement("TextButton", { Text = value })
        end
      `,
      errors: [
        { line: 4, column: 17, message: "React.createBinding creates a new binding on every render" },
      ],
    },
  ],
});
