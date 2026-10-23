import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-ref-on-function-component", {
  valid: [
    {
      name: "imported forwardRef accepts refs",
      files: {
        "Component.luau": dedent`
          local React = require(script.Parent.React)
          local Forwarded = require(script.Parent.Forwarded)
          local function Component(props)
            local ref = React.useRef(nil)
            return React.createElement("Frame", {}, { B = React.createElement(Forwarded, { ref = ref }) })
          end
        `,
        "Forwarded.luau": dedent`
          local React = require(script.Parent.React)
          local Forwarded = React.forwardRef(function(props, ref) return React.createElement("Frame", { ref = ref }) end)
          return Forwarded
        `,
      },
    },
    {
      name: "local forwardRef accepts refs",
      code: dedent`
        local LocalForwarded = React.forwardRef(function(props, ref) return React.createElement("Frame", { ref = ref }) end)
        local function Component(props)
          local ref = React.useRef(nil)
          return React.createElement("Frame", {}, { E = React.createElement(LocalForwarded, { ref = ref }) })
        end
        return Component
      `,
    },
    {
      name: "unknown component stays conservative",
      code: dedent`
        local function Component(props)
          local ref = React.useRef(nil)
          return React.createElement("Frame", {}, { F = React.createElement(props.component, { ref = ref }) })
        end
        return Component
      `,
    },
    {
      name: "host component accepts refs",
      code: dedent`
        local function Component(props)
          local ref = React.useRef(nil)
          return React.createElement("Frame", {}, { G = React.createElement("Frame", { ref = ref }) })
        end
        return Component
      `,
    },
  ],
  invalid: [
    {
      name: "imported function component rejects refs",
      files: {
        "Component.luau": dedent`
          local React = require(script.Parent.React)
          local Plain = require(script.Parent.Plain)
          local function Component(props)
            local ref = React.useRef(nil)
            return React.createElement("Frame", {}, { A = React.createElement(Plain, { ref = ref }) })
          end
        `,
        "Plain.luau": dedent`
          local React = require(script.Parent.React)
          local function Plain(props)
            return React.createElement("Frame", {})
          end
          return Plain
        `,
      },
      errors: [
        { line: 5, column: 78, message: "Plain is a function component without React.forwardRef, so this ref is never set", file: "Component.luau" },
      ],
    },
    {
      name: "imported memo component rejects refs",
      files: {
        "Component.luau": dedent`
          local React = require(script.Parent.React)
          local Memoized = require(script.Parent.Memoized)
          local function Component(props)
            local ref = React.useRef(nil)
            return React.createElement("Frame", {}, { C = React.createElement(Memoized, { ref = ref }) })
          end
        `,
        "Memoized.luau": dedent`
          local React = require(script.Parent.React)
          return React.memo(function(props) return React.createElement("Frame", {}) end)
        `,
      },
      errors: [
        { line: 5, column: 81, message: "Memoized is a function component without React.forwardRef, so this ref is never set", file: "Component.luau" },
      ],
    },
    {
      name: "local function component rejects refs",
      code: dedent`
        local function Local(props)
          return React.createElement("Frame", {})
        end
        local function Component(props)
          local ref = React.useRef(nil)
          return React.createElement("Frame", {}, { D = React.createElement(Local, { ref = ref }) })
        end
        return Component
      `,
      errors: [
        { line: 6, column: 78, message: "Local is a function component without React.forwardRef, so this ref is never set", file: "Component.luau" },
      ],
    },
  ],
});
