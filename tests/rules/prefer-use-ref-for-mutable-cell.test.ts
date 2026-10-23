import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/prefer-use-ref-for-mutable-cell", {
  valid: [
    {
      name: "mutable cells already use refs",
      code: dedent`
        local function PerformanceValid(props)
          local ref = React.useRef(nil)
          return React.createElement("Frame", { ref = ref })
        end
      `,
    },
    {
      name: "callback and discovery memos are observed",
      code: dedent`
        local ReplicatedStorage = game:GetService("ReplicatedStorage")
        local function PerformanceValid(props)
          local seed = React.useMemo(function() return math.random() end, {})
          local cachedCallback = React.useMemo(function() return props.callback end, { props.callback })
          local onClick = React.useCallback(function() setValue(function(previous) return previous + 1 end) end, {})
          local value, setValue = React.useState(0)
          local modules = React.useMemo(function() return ReplicatedStorage.Shared.Modules:GetChildren() end, {})
          React.useEffect(function() cachedCallback() end, { cachedCallback })
          return React.createElement("TextButton", { LayoutOrder = value, Name = tostring(seed) .. tostring(modules), [React.Event.Activated] = onClick })
        end
      `,
    },
  ],
  invalid: [
    {
      name: "memo creates a mutable ref-shaped table",
      code: dedent`
        local function Component(props)
          local parentFrameRef = React.useMemo(function() return { current = nil } end, {})
          return React.createElement("Frame", { ref = parentFrameRef })
        end
      `,
      errors: [
        { line: 2, column: 26, message: "parentFrameRef uses useMemo to create a { current = ... } mutable cell.", category: "Hooks" },
      ],
    },
  ],
});
