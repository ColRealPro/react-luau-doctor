import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-call-component-as-function", {
  valid: [
    {
      name: "hook-using helpers that return values are not treated as directly called components",
      code: dedent`
        local function makeValues(initial)
          local first = React.useBinding(initial)
          local second = React.useBinding(0)
          local unusedElement = React.createElement("Frame")
          return first, second
        end
        local alias = makeValues
        local function Component()
          local first, second = makeValues(1)
          local third, fourth = alias(2)
          return React.createElement("Frame")
        end
      `,
    },
    {
      name: "component call: local helper = MakeElement()",
      code: dedent`
        local function PureChild() return React.createElement("Frame") end
        local function MakeElement() return React.createElement("Frame") end
        local function Parent()
          local helper = MakeElement()
          local element = React.createElement(PureChild)
          return React.createElement("Frame", {}, { helper, element })
        end
      `,
    },
    {
      name: "component call: local element = React.createElement(PureChild)",
      code: dedent`
        local function PureChild() return React.createElement("Frame") end
        local function Parent()
          local element = React.createElement(PureChild)
          return React.createElement("Frame", {}, { element })
        end
      `,
    },
    {
      name: "component call: do",
      code: dedent`
        local function Child()
          React.useState(0)
          return React.createElement("Frame")
        end
        local function PureChild() return React.createElement("Frame") end
        local function Parent()
          do
            local Child = function() return 1 end
            Child()
          end
          local element = React.createElement(PureChild)
          return React.createElement("Frame", {}, { element })
        end
      `,
    },
    {
      name: "component call: local function callback(Child) return Child() end",
      code: dedent`
        local function Child()
          React.useState(0)
          return React.createElement("Frame")
        end
        local function PureChild() return React.createElement("Frame") end
        local function Parent()
          local function callback(Child) return Child() end
          local element = React.createElement(PureChild)
          return React.createElement("Frame", {}, { element })
        end
      `,
    },
  ],
  invalid: [
    {
      name: "component call: local child = alias()",
      code: dedent`
        local React = require(script.Parent.React)
        local function Child()
          React.useState(0)
          return React.createElement("Frame")
        end
        local function PureChild() return React.createElement("Frame") end
        local alias = Child
        local function Parent()
          local child = alias()
          local element = React.createElement(PureChild)
          return React.createElement("Frame", {}, { child, element })
        end
      `,
      errors: [
        { line: 9, column: 17, message: "alias is called directly instead of rendered as a component" },
      ],
    },
    {
      name: "component call: local pure = PureChild()",
      code: dedent`
        local function PureChild() return React.createElement("Frame") end
        local function Parent()
          local pure = PureChild()
          local element = React.createElement(PureChild)
          return React.createElement("Frame", {}, { pure, element })
        end
      `,
      errors: [
        { line: 3, column: 16, message: "PureChild is called directly instead of rendered as a component" },
      ],
    },
  ],
});
