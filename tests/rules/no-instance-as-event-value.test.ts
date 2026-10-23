import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-instance-as-event-value", {
  valid: [
    {
      name: "event Instance argument: [React.Change.TextBounds] = function(rbx)",
      code: dedent`
        local function Component()
          local text, setText = React.useState("")
          return React.createElement("TextBox", { [React.Change.TextBounds] = function(rbx) setText(rbx.Text) end })
        end
      `,
    },
    {
      name: "event Instance argument: [React.Event.InputEnded] = function(rbx, input)",
      code: dedent`
        local function Component()
          local text, setText = React.useState("")
          return React.createElement("TextBox", {
            [React.Event.InputEnded] = function(rbx, input) if input.KeyCode == Enum.KeyCode.Return then end end,
          })
        end
      `,
    },
    {
      name: "event Instance argument: [React.Event.FocusLost] = function(rbx)",
      code: dedent`
        local function Component()
          local text, setText = React.useState("")
          return React.createElement("TextBox", {
            [React.Event.FocusLost] = function(rbx)
              local label = "Focus " .. rbx.Name
            end,
          })
        end
      `,
    },
  ],
  invalid: [
    {
      name: "event Instance argument: [React.Change.Text] = function(newText)",
      code: dedent`
        local function Component()
          local text, setText = React.useState("")
          return React.createElement("TextBox", { [React.Change.Text] = function(newText) setText(newText) end })
        end
      `,
      errors: [
        { line: 3, column: 91, message: "newText is the changed Instance, not its Text value", fixPreview: {"kind":"pattern","before":"[React.Change.Text] = function(newText)\n\tuse(newText)\nend,","after":"[React.Change.Text] = function(rbx)\n\tuse(rbx.Text)\nend,","note":"React-Luau passes the Instance whose property changed"} },
      ],
    },
    {
      name: "event Instance argument: [React.Event.InputBegan] = function(input)",
      code: dedent`
        local function Component()
          local text, setText = React.useState("")
          return React.createElement("TextBox", {
            [React.Event.InputBegan] = function(input) if input.KeyCode == Enum.KeyCode.Return then end end,
          })
        end
      `,
      errors: [
        { line: 4, column: 51, message: "input is the Instance that fired InputBegan, not an event argument", fixPreview: {"kind":"pattern","before":"[React.Event.InputBegan] = function(input)\n\tuse(input)\nend,","after":"[React.Event.InputBegan] = function(rbx, input)\n\tuse(input)\nend,","note":"React-Luau passes the Instance first, then the signal's own arguments"} },
      ],
    },
    {
      name: "event Instance argument: [React.Change.AbsoluteSize] = function(value)",
      code: dedent`
        local function Component()
          local text, setText = React.useState("")
          return React.createElement("TextBox", { [React.Change.AbsoluteSize] = function(value) local width = value + 1 end })
        end
      `,
      errors: [
        { line: 3, column: 103, message: "value is the changed Instance, not its AbsoluteSize value", fixPreview: {"kind":"pattern","before":"[React.Change.AbsoluteSize] = function(value)\n\tuse(value)\nend,","after":"[React.Change.AbsoluteSize] = function(rbx)\n\tuse(rbx.AbsoluteSize)\nend,","note":"React-Luau passes the Instance whose property changed"} },
      ],
    },
  ],
});
