import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-binding-getvalue-in-render", {
  valid: [
    {
      name: "binding snapshot: local unrelated = makeStore()",
      code: dedent`
        local function Component()
          local unrelated = makeStore()
          unrelated:getValue()
          return React.createElement("Frame")
        end
      `,
    },
    {
      name: "binding snapshot: React.useEffect(function() value:getValue() end, {})",
      code: dedent`
        local function Component()
          local value, setValue = React.useBinding(0)
          React.useEffect(function() value:getValue() end, {})
        end
      `,
    },
    {
      name: "binding snapshot: do",
      code: dedent`
        local function Component()
          local value, setValue = React.useBinding(0)
          do
            local value = makeStore()
            value:getValue()
          end
        end
      `,
    },
    {
      name: "binding snapshot: [React.Event.Activated] = function() setValue(value:getValue() + 1) end,",
      code: dedent`
        local function Component()
          local value, setValue = React.useBinding(0)
          local mapped = value:map(function(current) return tostring(current) end)
          return React.createElement("TextButton", {
            Text = mapped,
            [React.Event.Activated] = function() setValue(value:getValue() + 1) end,
          })
        end
      `,
    },
    {
      name: "ref initializer: local direct = React.useRef(value:getValue())",
      code: dedent`
        local function Component()
          local value = React.useBinding(0)
          local direct = React.useRef(value:getValue())
        end
      `,
    },
    {
      name: "ref initializer: local aliased = useRef({ previous = value:getValue() })",
      code: dedent`
        local React = require(script.Parent.React)
        local useRef = React.useRef
        local function Component()
          local value = React.useBinding(0)
          local aliased = useRef({ previous = value:getValue() })
        end
      `,
    },
    {
      name: "ref initializer: local formatted = React.useRef(tostring(value:getValue()))",
      code: dedent`
        local function Component()
          local value = React.useBinding(0)
          local formatted = React.useRef(tostring(value:getValue()))
        end
      `,
    },
    {
      name: "useState binding initializer: local direct = React.useState(value:getValue())",
      code: dedent`
        local function Component()
          local value = React.useBinding(0)
          local direct = React.useState(value:getValue())
        end
      `,
    },
    {
      name: "useState binding initializer: local aliased = initialize({ previous = value:getValue() })",
      code: dedent`
        local React = require(script.Parent.React)
        local initialize = React.useState
        local function Component()
          local value = React.useBinding(0)
          local aliased = initialize({ previous = value:getValue() })
        end
      `,
    },
    {
      name: "useState binding initializer: local formatted = React.useState(tostring(value:getValue()))",
      code: dedent`
        local function Component()
          local value = React.useBinding(0)
          local formatted = React.useState(tostring(value:getValue()))
        end
      `,
    },
    {
      name: "useBinding binding initializer: local direct = React.useBinding(value:getValue())",
      code: dedent`
        local function Component()
          local value = React.useBinding(0)
          local direct = React.useBinding(value:getValue())
        end
      `,
    },
    {
      name: "useBinding binding initializer: local aliased = initialize({ previous = value:getValue() })",
      code: dedent`
        local React = require(script.Parent.React)
        local initialize = React.useBinding
        local function Component()
          local value = React.useBinding(0)
          local aliased = initialize({ previous = value:getValue() })
        end
      `,
    },
    {
      name: "useBinding binding initializer: local formatted = React.useBinding(tostring(value:getValue()))",
      code: dedent`
        local function Component()
          local value = React.useBinding(0)
          local formatted = React.useBinding(tostring(value:getValue()))
        end
      `,
    },
    {
      name: "useReducer binding initializer: local direct = React.useReducer(reducer, value:getValue())",
      code: dedent`
        local function reducer(state) return state end
        local function Component()
          local value = React.useBinding(0)
          local direct = React.useReducer(reducer, value:getValue())
        end
      `,
    },
    {
      name: "useReducer binding initializer: local aliased = initialize(reducer, { previous = value:getValue() })",
      code: dedent`
        local React = require(script.Parent.React)
        local initialize = React.useReducer
        local function reducer(state) return state end
        local function Component()
          local value = React.useBinding(0)
          local aliased = initialize(reducer, { previous = value:getValue() })
        end
      `,
    },
    {
      name: "useReducer binding initializer: local formatted = React.useReducer(reducer, tostring(value:getValue()))",
      code: dedent`
        local function reducer(state) return state end
        local function Component()
          local value = React.useBinding(0)
          local formatted = React.useReducer(reducer, tostring(value:getValue()))
        end
      `,
    },
  ],
  invalid: [
    {
      name: "binding snapshot: local first = alias:getValue()",
      code: dedent`
        local React = require(script.Parent.React)
        local function Component()
          local value, setValue = React.useBinding(0)
          local alias = (value :: any)
          local first = alias:getValue()
        end
      `,
      errors: [
        { line: 5, column: 17, message: "alias:getValue() reads a binding snapshot during render" },
      ],
    },
    {
      name: "binding snapshot: local second = mapped:getValue()",
      code: dedent`
        local function Component()
          local value, setValue = React.useBinding(0)
          local mapped = value:map(function(current) return tostring(current) end)
          local second = mapped:getValue()
        end
      `,
      errors: [
        { line: 4, column: 18, message: "mapped:getValue() reads a binding snapshot during render" },
      ],
    },
    {
      name: "binding snapshot: local third = joined:getValue()",
      code: dedent`
        local shared = React.createBinding(0)
        local function Component()
          local value, setValue = React.useBinding(0)
          local joined = React.joinBindings({ value, shared })
          local third = joined:getValue()
        end
      `,
      errors: [
        { line: 5, column: 17, message: "joined:getValue() reads a binding snapshot during render" },
      ],
    },
    {
      name: "binding snapshot: local fourth = shared:getValue()",
      code: dedent`
        local shared = React.createBinding(0)
        local function Component()
          local value, setValue = React.useBinding(0)
          local fourth = shared:getValue()
        end
      `,
      errors: [
        { line: 4, column: 18, message: "shared:getValue() reads a binding snapshot during render" },
      ],
    },
    {
      name: "ref initializer: local snapshot = value:getValue()",
      code: dedent`
        local function Component()
          local value = React.useBinding(0)
          local snapshot = value:getValue()
        end
      `,
      errors: [
        { line: 3, column: 20, message: "value:getValue() reads a binding snapshot during render" },
      ],
    },
    {
      name: "ref initializer: direct.current = value:getValue()",
      code: dedent`
        local function Component()
          local value = React.useBinding(0)
          direct.current = value:getValue()
        end
      `,
      errors: [
        { line: 3, column: 20 },
      ],
    },
    {
      name: "ref initializer: local useRef = function(initial) return initial end",
      code: dedent`
        local useRef = React.useRef
        local function Component()
          local value = React.useBinding(0)
          local useRef = function(initial) return initial end
          local unrelated = useRef(value:getValue())
        end
      `,
      errors: [
        { line: 5, column: 28 },
      ],
    },
    {
      name: "ref initializer: local extra = React.useRef(nil, value:getValue())",
      code: dedent`
        local function Component()
          local value = React.useBinding(0)
          local extra = React.useRef(nil, value:getValue())
        end
      `,
      errors: [
        { line: 3, column: 35 },
      ],
    },
    {
      name: "ref initializer: return React.createElement(\"TextLabel\", { Text = value:getValue() })",
      code: dedent`
        local function Component()
          local value = React.useBinding(0)
          return React.createElement("TextLabel", { Text = value:getValue() })
        end
      `,
      errors: [
        { line: 3, column: 52 },
      ],
    },
    {
      name: "useState binding initializer: local snapshot = value:getValue()",
      code: dedent`
        local function Component()
          local value = React.useBinding(0)
          local snapshot = value:getValue()
        end
      `,
      errors: [
        { line: 3, column: 20 },
      ],
    },
    {
      name: "useState binding initializer: local invalid = React.useState(nil, value:getValue())",
      code: dedent`
        local function Component()
          local value = React.useBinding(0)
          local invalid = React.useState(nil, value:getValue())
        end
      `,
      errors: [
        { line: 3, column: 39 },
      ],
    },
    {
      name: "useState binding initializer: local initialize = function(...) return nil end",
      code: dedent`
        local initialize = React.useState
        local function Component()
          local value = React.useBinding(0)
          local initialize = function(...) return nil end
          local unrelated = initialize(value:getValue())
        end
      `,
      errors: [
        { line: 5, column: 32 },
      ],
    },
    {
      name: "useState binding initializer: return React.createElement(\"TextLabel\", { Text = value:getValue() })",
      code: dedent`
        local function Component()
          local value = React.useBinding(0)
          return React.createElement("TextLabel", { Text = value:getValue() })
        end
      `,
      errors: [
        { line: 3, column: 52 },
      ],
    },
    {
      name: "useBinding binding initializer: local invalid = React.useBinding(nil, value:getValue())",
      code: dedent`
        local function Component()
          local value = React.useBinding(0)
          local invalid = React.useBinding(nil, value:getValue())
        end
      `,
      errors: [
        { line: 3, column: 41 },
      ],
    },
    {
      name: "useBinding binding initializer: local initialize = function(...) return nil end",
      code: dedent`
        local initialize = React.useBinding
        local function Component()
          local value = React.useBinding(0)
          local initialize = function(...) return nil end
          local unrelated = initialize(value:getValue())
        end
      `,
      errors: [
        { line: 5, column: 32 },
      ],
    },
    {
      name: "useReducer binding initializer: local invalid = React.useReducer(value:getValue(), nil, value:getValue())",
      code: dedent`
        local function Component()
          local value = React.useBinding(0)
          local invalid = React.useReducer(value:getValue(), nil, value:getValue())
        end
      `,
      errors: [
        { line: 3, column: 36 },
        { line: 3, column: 59 },
      ],
    },
    {
      name: "useReducer binding initializer: local initialize = function(...) return nil end",
      code: dedent`
        local initialize = React.useReducer
        local function reducer(state) return state end
        local function Component()
          local value = React.useBinding(0)
          local initialize = function(...) return nil end
          local unrelated = initialize(reducer, value:getValue())
        end
      `,
      errors: [
        { line: 6, column: 41 },
      ],
    },
  ],
});
