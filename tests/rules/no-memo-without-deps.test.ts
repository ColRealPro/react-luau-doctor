import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-memo-without-deps", {
  valid: [
    {
      name: "memo dependency argument: local third = React.useMemo(function() return props.value * 2 end, { props.value })",
      code: dedent`
        local function Component(props, ...)
          local third = React.useMemo(function() return props.value * 2 end, { props.value })
        end
      `,
    },
    {
      name: "memo dependency argument: local fourth = React.useCallback(...)",
      code: dedent`
        local function Component(props, ...)
          local fourth = React.useCallback(...)
        end
      `,
    },
    {
      name: "memo dependency argument: local fifth = React.useMemo(table.unpack(props.args))",
      code: dedent`
        local function Component(props, ...)
          local fifth = React.useMemo(table.unpack(props.args))
        end
      `,
    },
    {
      name: "memo dependency argument: React.useEffect(function() print(props.value) end)",
      code: dedent`
        local function Component(props, ...)
          React.useEffect(function() print(props.value) end)
        end
      `,
    },
  ],
  invalid: [
    {
      name: "memo dependency argument: local first = React.useMemo(function() return props.value * 2 end)",
      code: dedent`
        local function Component(props, ...)
          local first = React.useMemo(function() return props.value * 2 end)
        end
      `,
      errors: [
        { line: 2, column: 17, message: "useMemo has no dependency table, so it recomputes on every render" },
      ],
    },
    {
      name: "memo dependency argument: local second = useCallback(function() print(props.value) end, nil)",
      code: dedent`
        local useCallback = React.useCallback
        local function Component(props, ...)
          local second = useCallback(function() print(props.value) end, nil)
          return React.createElement("Frame")
        end
      `,
      errors: [
        { line: 3, column: 18, message: "useCallback has no dependency table, so it returns a new function on every render" },
      ],
    },
  ],
});
