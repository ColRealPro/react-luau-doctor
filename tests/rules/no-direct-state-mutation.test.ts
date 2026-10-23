import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-direct-state-mutation", {
  valid: [
    {
      name: "callback local shadows state with the same name",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function Component(props)
          local count, setCount = React.useState(0)
          React.useEffect(function()
            local connection = RunService.Heartbeat:Connect(function()
              local count = 10
              count += 1
            end)
            return function() connection:Disconnect() end
          end, {})
          return React.createElement("Frame", { LayoutOrder = count })
        end
      `,
    },
    {
      name: "functional updater mutates a cloned state table",
      code: dedent`
        local function buildInitialItems()
          return {}
        end
        local function AdvancedValid(props)
          local count, setCount = React.useState(0)
          local items, setItems = React.useState(function() return buildInitialItems() end)
          local function onActivated()
            setCount(function(previous) return previous + 1 end)
            setItems(function(previous)
              local nextItems = table.clone(previous)
              nextItems[props.id] = props.value
              return nextItems
            end)
          end
          return React.createElement("TextButton", { Text = tostring(count) .. tostring(#items), [React.Event.Activated] = onActivated })
        end
      `,
    },
    {
      name: "same-scope local redeclaration shadows state",
      code: dedent`
        local function Component(props)
          local state, setState = React.useState({ changed = false })
          local state = table.clone(state)
          state.changed = true
          return React.createElement("Frame")
        end
      `,
    },
  ],
  invalid: [
    {
      name: "state table field is assigned directly",
      code: dedent`
        local function Component(props)
          local items, setItems = React.useState({})
          items.latest = props.value
          return React.createElement("Frame", { Name = tostring(items) })
        end
      `,
      errors: [
        { line: 3, column: 3, message: "items is React state backed by a table and is mutated in place." },
      ],
    },
    {
      name: "table.insert mutates state directly",
      code: dedent`
        local function Component(props)
          local items, setItems = React.useState({})
          table.insert(items, props.value)
          return React.createElement("Frame", { Name = tostring(items) })
        end
      `,
      errors: [
        { line: 3, column: 3 },
      ],
    },
    {
      name: "parameter mutation summaries follow table state through helper calls without flagging cloned state",
      files: {
        "Component.luau": dedent`
          local Mutator = require(script.Parent.Mutator)
          local function Component()
            local state, setState = React.useState({ changed = false })
            local alias = state
            Mutator.mutate(alias)
            local cloned = table.clone(state)
            Mutator.mutate(cloned)
            return React.createElement("Frame", { Name = tostring(state.changed) })
          end
        `,
        "Mutator.luau": dedent`
          local Mutator = {}
          function Mutator.mutate(value)
            value.changed = true
          end
          return Mutator
        `,
      },
      errors: [
        { line: 5, column: 3, message: "state is React state backed by a table and is mutated in place.", file: "Component.luau" },
      ],
    },
  ],
});
