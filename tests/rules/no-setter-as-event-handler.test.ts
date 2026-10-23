import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-setter-as-event-handler", {
  valid: [
    {
      name: "setter handler: [React.Event.FocusLost] = props.onFocusLost,",
      code: dedent`
        local function Component(props)
          local text, setText = React.useState("")
          local size, setSize = React.useBinding(0)
          local open, setOpen = React.useState(false)
          return React.createElement("TextBox", {
            Text = text,
            Size = size,
            Visible = open,
            [React.Event.FocusLost] = props.onFocusLost,
          })
        end
      `,
    },
    {
      name: "setter handler: [React.Change.Position] = function(rbx) setOpen(rbx.Visible) end,",
      code: dedent`
        local function Component(props)
          local text, setText = React.useState("")
          local size, setSize = React.useBinding(0)
          local open, setOpen = React.useState(false)
          return React.createElement("TextBox", {
            Text = text,
            Size = size,
            Visible = open,
            [React.Change.Position] = function(rbx) setOpen(rbx.Visible) end,
          })
        end
      `,
    },
    {
      name: "setter handler: [props.key] = setText,",
      code: dedent`
        local function Component(props)
          local text, setText = React.useState("")
          local size, setSize = React.useBinding(0)
          local open, setOpen = React.useState(false)
          return React.createElement("TextBox", {
            Text = text,
            Size = size,
            Visible = open,
            [props.key] = setText,
          })
        end
      `,
    },
  ],
  invalid: [
    {
      name: "setter handler: [React.Change.Text] = setText,",
      code: dedent`
        local function Component(props)
          local text, setText = React.useState("")
          local size, setSize = React.useBinding(0)
          local open, setOpen = React.useState(false)
          return React.createElement("TextBox", {
            Text = text,
            Size = size,
            Visible = open,
            [React.Change.Text] = setText,
          })
        end
      `,
      errors: [
        { line: 9, column: 27, message: "setText receives the changed Instance, not its Text value" },
      ],
    },
    {
      name: "setter handler: [Change.AbsoluteSize] = setSize,",
      code: dedent`
        local Change = React.Change
        local function Component(props)
          local text, setText = React.useState("")
          local size, setSize = React.useBinding(0)
          local open, setOpen = React.useState(false)
          return React.createElement("TextBox", {
            Text = text,
            Size = size,
            Visible = open,
            [Change.AbsoluteSize] = setSize,
          })
        end
      `,
      errors: [
        { line: 10, column: 29, message: "setSize receives the changed Instance, not its AbsoluteSize value" },
      ],
    },
    {
      name: "setter handler: [React.Event.Focused] = setOpen,",
      code: dedent`
        local function Component(props)
          local text, setText = React.useState("")
          local size, setSize = React.useBinding(0)
          local open, setOpen = React.useState(false)
          return React.createElement("TextBox", {
            Text = text,
            Size = size,
            Visible = open,
            [React.Event.Focused] = setOpen,
          })
        end
      `,
      errors: [
        { line: 9, column: 29, message: "setOpen receives the Instance that fired Focused, not an event value" },
      ],
    },
  ],
});
