import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-self-updating-effect", {
  valid: [
    {
      name: "self-updating effects catch guaranteed no-deps render loops without flagging convergent updates (Convergent)",
      code: dedent`
        local function Convergent(props)
          local count, setCount = React.useState(0)
          React.useEffect(function() setCount(props.count) end)
        end
      `,
    },
    {
      name: "self-updating effects catch guaranteed no-deps render loops without flagging convergent updates (Guarded)",
      code: dedent`
        local function Guarded()
          local count, setCount = React.useState(0)
          React.useEffect(function()
            if count < 1 then
              setCount(count + 1)
            end
          end)
        end
      `,
    },
    {
      name: "self-updating effects catch guaranteed no-deps render loops without flagging convergent updates (MountOnly)",
      code: dedent`
        local function MountOnly()
          local state, setState = React.useState({})
          React.useEffect(function() setState({}) end, {})
        end
      `,
    },
    {
      name: "effect updates its binding without a state render loop",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function AdvancedValid(props)
          local animated, setAnimated = React.useBinding(0)
          React.useEffect(function()
            local connection = RunService.RenderStepped:Connect(function(dt) setAnimated(animated:getValue() + dt) end)
            return function() connection:Disconnect() end
          end, { animated, setAnimated })
        end
      `,
    },
  ],
  invalid: [
    {
      name: "effect updates state in its own dependencies",
      code: dedent`
        local function Component(props)
          local count, setCount = React.useState(0)
          React.useEffect(function() setCount(count + 1) end, { count })
        end
      `,
      errors: [
        { line: 3, column: 30, message: "setCount() updates count, which is also in this effect's dependency table." },
      ],
    },
    {
      name: "self-updating effects catch guaranteed no-deps render loops without flagging convergent updates (InfiniteArithmetic)",
      code: dedent`
        local function InfiniteArithmetic()
          local count, setCount = React.useState(0)
          React.useEffect(function() setCount(count + 1) end)
        end
      `,
      errors: [
        { line: 3, column: 30, message: "setCount() unconditionally changes count in an effect that runs after every render." },
      ],
    },
    {
      name: "self-updating effects catch guaranteed no-deps render loops without flagging convergent updates (InfiniteExplicitNil)",
      code: dedent`
        local function InfiniteExplicitNil()
          local items, setItems = React.useState({})
          React.useLayoutEffect(function() setItems(table.clone(items)) end, nil)
        end
      `,
      errors: [
        { line: 3, column: 36, message: "setItems() unconditionally changes items in an effect that runs after every render." },
      ],
    },
    {
      name: "self-updating effects catch guaranteed no-deps render loops without flagging convergent updates (InfiniteTable)",
      code: dedent`
        local function InfiniteTable()
          local state, setState = React.useState({})
          React.useEffect(function() setState({}) end)
        end
      `,
      errors: [
        { line: 3, column: 30, message: "setState() unconditionally changes state in an effect that runs after every render." },
      ],
    },
    {
      name: "self-updating effects catch guaranteed no-deps render loops without flagging convergent updates (InfiniteUpdater)",
      code: dedent`
        local function InfiniteUpdater()
          local count, setCount = React.useState(0)
          React.useEffect(function() setCount(function(previous) return previous + 1 end) end)
        end
      `,
      errors: [
        { line: 3, column: 30 },
      ],
    },
  ],
});
