import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/usememo-must-return", {
  valid: [
    {
      name: "memo return: local third = memo(function() return nil end, {})",
      code: dedent`
        local memo = React.useMemo
        local function Component(props)
          local third = memo(function() return nil end, {})
          return React.createElement("Frame")
        end
      `,
    },
    {
      name: "memo return: local fourth = memo(function()",
      code: dedent`
        local memo = React.useMemo
        local function Component(props)
          local fourth = memo(function() if props.enabled then return 1 end end, { props.enabled })
          return React.createElement("Frame")
        end
      `,
    },
    {
      name: "memo return: local fifth = memo(function() return function() return 1 end end, {})",
      code: dedent`
        local memo = React.useMemo
        local function Component(props)
          local fifth = memo(function() return function() return 1 end end, {})
          return React.createElement("Frame")
        end
      `,
    },
    {
      name: "memo return: local memo = function(callback) return callback() end",
      code: dedent`
        local memo = React.useMemo
        local function Component(props)
          local memo = function(callback) return callback() end
          memo(function() compute() end)
          return React.createElement("Frame")
        end
      `,
    },
  ],
  invalid: [
    {
      name: "memo return: local first = memo(calculate, {})",
      code: dedent`
        local memo = React.useMemo
        local function calculate() compute() end
        local function Component(props)
          local first = memo(calculate, {})
          return React.createElement("Frame")
        end
      `,
      errors: [
        { line: 4, column: 17, message: "This useMemo callback returns no value" },
      ],
    },
    {
      name: "memo return: local second = memo(function()",
      code: dedent`
        local memo = React.useMemo
        local function Component(props)
          local second = memo(function()
            local function inner() return 1 end
            inner()
            return
          end, {})
          return React.createElement("Frame")
        end
      `,
      errors: [
        { line: 3, column: 18 },
      ],
    },
  ],
});
