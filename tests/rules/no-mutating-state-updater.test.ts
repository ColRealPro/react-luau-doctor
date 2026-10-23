import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-mutating-state-updater", {
  valid: [
    {
      name: "fresh copies and shadowed updater parameters",
      files: {
        "Component.luau": dedent`
          local function Component()
            local items, setItems = React.useState({})
            setItems(function(previous)
              local copy = table.clone(previous)
              table.insert(copy, 1)
              copy.enabled = true
              local function helper(previous)
                table.insert(previous, 1)
              end
              helper({})
              for previous in {} do
                table.clear(previous)
              end
              return copy
            end)
            return React.createElement("Frame")
          end
        `,
        "mutate.luau": dedent`
          return function(value) table.clear(value) end
        `,
      },
    },
    {
      name: "reassigned previous state is fresh",
      files: {
        "Component.luau": dedent`
          local function Component()
            local items, setItems = React.useState({})
            setItems(function(previous)
              previous = {}
              previous.enabled = true
              return previous
            end)
            return React.createElement("Frame")
          end
        `,
        "mutate.luau": dedent`
          return function(value) table.clear(value) end
        `,
      },
    },
    {
      name: "shadowed setter is unrelated",
      files: {
        "Component.luau": dedent`
          local function Component()
            local items, setItems = React.useState({})
            local setItems = function(callback) return callback({}) end
            setItems(function(previous)
              table.clear(previous)
              return previous
            end)
            return React.createElement("Frame")
          end
        `,
        "mutate.luau": dedent`
          return function(value) table.clear(value) end
        `,
      },
    },
  ],
  invalid: [
    {
      name: "mutating an aliased previous-state field",
      files: {
        "Component.luau": dedent`
          local React = require(script.Parent.React)
          local function Component()
            local items, setItems = React.useState({})
            local update = setItems
            update(function(previous)
              local alias = previous.items
              table.insert(alias, 1)
              return previous
            end)
            return React.createElement("Frame")
          end
        `,
        "mutate.luau": dedent`
          return function(value) table.clear(value) end
        `,
      },
      errors: [
        { line: 7, column: 5, message: "This updater mutates previous state through alias", file: "Component.luau" },
      ],
    },
    {
      name: "assigning to previous state",
      files: {
        "Component.luau": dedent`
          local function Component()
            local items, setItems = React.useState({})
            local update = setItems
            update(function(previous)
              previous.enabled = true
              return previous
            end)
            return React.createElement("Frame")
          end
        `,
        "mutate.luau": dedent`
          return function(value) table.clear(value) end
        `,
      },
      errors: [
        { line: 5, column: 5, message: "This updater mutates previous state through previous.enabled", file: "Component.luau" },
      ],
    },
    {
      name: "imported helper mutates previous state",
      files: {
        "Component.luau": dedent`
          local React = require(script.Parent.React)
          local mutate = require(script.Parent.mutate)
          local function Component()
            local items, setItems = React.useState({})
            local update = setItems
            update(function(previous)
              mutate(previous.items)
              return previous
            end)
            return React.createElement("Frame")
          end
        `,
        "mutate.luau": dedent`
          return function(value) table.clear(value) end
        `,
      },
      errors: [
        { line: 7, column: 5, message: "This updater mutates previous state through previous.items", file: "Component.luau" },
      ],
    },
    {
      name: "named mutating updater",
      files: {
        "Component.luau": dedent`
          local function Component()
            local items, setItems = React.useState({})
            local function clear(previous)
              table.clear(previous)
              return previous
            end
            setItems(clear)
            return React.createElement("Frame")
          end
        `,
        "mutate.luau": dedent`
          return function(value) table.clear(value) end
        `,
      },
      errors: [
        { line: 4, column: 5, message: "This updater mutates previous state through previous", file: "Component.luau" },
      ],
    },
    {
      name: "shallow copy retains nested previous state",
      files: {
        "Component.luau": dedent`
          local function Component()
            local items, setItems = React.useState({})
            setItems(function(previous)
              local copy = table.clone(previous)
              table.insert(copy.items, 1)
              copy.items = table.clone(previous.items)
              table.insert(copy.items, 1)
              return copy
            end)
            return React.createElement("Frame")
          end
        `,
        "mutate.luau": dedent`
          return function(value) table.clear(value) end
        `,
      },
      errors: [
        { line: 5, column: 5, message: "This updater mutates previous state through copy.items", file: "Component.luau" },
      ],
    },
  ],
});
