import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-prop-mutation", {
  valid: [
    {
      name: "source effects follow returned parameters, fresh reassignments, and casts",
      files: {
        "bump.luau": dedent`
          local store = require(script.Parent.store)
          local function bump()
            local current = store.getState()
            current.count += 1
            return current.count
          end
          return bump
        `,
        "Component.luau": dedent`
          local withB = require(script.Parent.withB)
          local markItem = require(script.Parent.markItem)
          local bump = require(script.Parent.bump)
          local function Component(props)
            local frameProps = withB(props, { Size = props.size })
            local items = markItem(props.items, props.value)
            return React.createElement("Frame", frameProps, items, bump())
          end
          return Component
        `,
        "markItem.luau": dedent`
          local function markItem(items, value)
            local result = {}
            for _, item in items do
              local next = item
              if item.id == value then
                next = table.clone(item)
                next.isChecked = true
              end
              table.insert(result, next)
            end
            return result
          end
          return markItem
        `,
        "store.luau": dedent`
          local state = { count = 0 }
          return { getState = function() return state end }
        `,
        "withA.luau": dedent`
          local function withA(props, base)
            base.A = props.a
            return base
          end
          return withA
        `,
        "withB.luau": dedent`
          local withA = require(script.Parent.withA)
          local function withB(props, base)
            local full = withA(props, base) :: any
            full.B = props.b
            local extra: any = nil
            extra = {}
            extra.C = props.c
            return full
          end
          return withB
        `,
      },
    },
    {
      name: "same-scope local redeclaration shadows props",
      code: dedent`
        local function Component(props)
          local props = table.clone(props)
          props.changed = true
          return React.createElement("Frame")
        end
      `,
    },
  ],
  invalid: [
    {
      name: "assignment mutates props",
      code: dedent`
        local function Component(props)
          props.title = "mutated"
          return React.createElement("Frame")
        end
      `,
      errors: [
        { line: 2, column: 3, message: "Component mutates props directly." },
      ],
    },
    {
      name: "parameter mutation summaries follow props through local and imported helpers without flagging fresh copies",
      files: {
        "Component.luau": dedent`
          local React = require(script.Parent.React)
          local Mutator = require(script.Parent.Mutator)
          local wrappedMutate = require(script.Parent.Wrapper)
          local function localMutate(value)
            value.changed = true
          end
          local function outer(value)
            localMutate(value)
          end
          local function Component(props)
            local alias = props.data
            outer(alias)
            Mutator.mutate(props.other)
            wrappedMutate(props.third)
            table.insert(props.items, "value")
            local reassigned = props.reassigned
            reassigned = {}
            localMutate(reassigned)
            local cloned = table.clone(props.cloned)
            Mutator.mutate(cloned)
            return React.createElement("Frame")
          end
        `,
        "Mutator.luau": dedent`
          local Mutator = {}
          function Mutator.mutate(value)
            value.changed = true
          end
          return Mutator
        `,
        "Wrapper.luau": dedent`
          local mutate = require(script.Parent.FunctionMutator)
          local function wrappedMutate(value)
            mutate(value)
          end
          return wrappedMutate
        `,
        "FunctionMutator.luau": dedent`
          local function mutate(value)
            table.insert(value, "changed")
          end
          return mutate
        `,
      },
      errors: [
        { line: 12, column: 3, message: "outer mutates an argument derived from props.", file: "Component.luau" },
        { line: 13, column: 3, message: "Mutator.mutate mutates an argument derived from props.", file: "Component.luau" },
        { line: 14, column: 3, message: "wrappedMutate mutates an argument derived from props.", file: "Component.luau" },
        { line: 15, column: 3, message: "table.insert mutates an argument derived from props.", file: "Component.luau" },
      ],
    },
    {
      name: "prop mutation checks include useMemo callbacks and preserve cloned and shadowed inputs",
      code: dedent`
        local useMemo = React.useMemo
        local function Component(props)
          local items = React.useMemo(function()
            table.sort(props.items, function(a, b) return a.rarity > b.rarity end)
            props.changed = true
            local alias = props.items
            table.insert(alias, {})
            local cloned = table.clone(props.items)
            table.sort(cloned)
            return cloned
          end, { props.items })
          local other = useMemo(function()
            table.remove(props.items)
            return items
          end, { props.items })
          local shadowed = React.useMemo(function()
            local props = { items = {} }
            table.sort(props.items)
            props.changed = true
            return props
          end, {})
          local callback = React.useCallback(function() table.sort(props.items) end, { props.items })
          return React.createElement("Frame")
        end
      `,
      errors: [
        { line: 4, column: 5, message: "table.sort mutates an argument derived from props." },
        { line: 5, column: 5 },
        { line: 7, column: 5 },
        { line: 13, column: 5, message: "table.remove mutates an argument derived from props." },
        { line: 22, column: 49 },
      ],
    },
    {
      name: "prop mutation checks include captured props in named and deferred functions",
      code: dedent`
        local useMemo = React.useMemo
        local function Component(props)
          local sortItems = function()
            table.sort(props.items)
            props.changed = true
            local copy = table.clone(props.items)
            table.sort(copy)
            return copy
          end
          local alias = sortItems
          local items = useMemo(alias, { props.items })
          local function removeItem()
            table.remove(props.items)
            return items
          end
          React.useMemo(removeItem, { props.items })
          local reassigned
          reassigned = function()
            table.clear(props.items)
            return items
          end
          React.useMemo(reassigned, { props.items })
          local function unused()
            table.sort(props.items)
          end
          local function deferred()
            table.sort(props.items)
          end
          React.useCallback(deferred, { props.items })
          local function shadowed()
            table.sort(props.items)
          end
          do
            local shadowed = function() return {} end
            React.useMemo(shadowed, {})
          end
          local function replaced()
            table.sort(props.items)
          end
          replaced = function() return {} end
          React.useMemo(replaced, {})
          local function withParameter(shadowed)
            return React.useMemo(shadowed, {})
          end
          React.useMemo(withParameter, {})
          return React.createElement("Frame")
        end
      `,
      errors: [
        { line: 4, column: 5 },
        { line: 5, column: 5 },
        { line: 13, column: 5 },
        { line: 19, column: 5, message: "table.clear mutates an argument derived from props." },
        { line: 24, column: 5 },
        { line: 27, column: 5 },
        { line: 31, column: 5 },
        { line: 38, column: 5 },
      ],
    },
    {
      name: "prop mutation checks respect nested parameter shadowing and captured aliases",
      code: dedent`
        local React = require(script.Parent.React)
        local function Component(props)
          local items = props.items
          local function shadowed(props, items)
            props.changed = true
            table.sort(props.items)
            table.sort(items)
            local alias = props.items
            table.sort(alias)
          end
          local function captured(props)
            table.sort(items)
          end
          React.useEffect(function()
            props.changed = true
            table.sort(items)
          end, { props.items })
          return React.createElement("TextButton", { [React.Event.Activated] = function() table.sort(props.items) end })
        end
      `,
      errors: [
        { line: 12, column: 5 },
        { line: 15, column: 5 },
        { line: 16, column: 5 },
        { line: 18, column: 83 },
      ],
    },
    {
      name: "ref props get forwarding advice instead of generic prop mutation advice",
      code: dedent`
        local function Component(props)
          return React.createElement("Frame", { ref = function(instance) props.frameRef.current = instance end })
        end
        local function Registered(props)
          React.useEffect(function() table.insert(props.registry.current, props.value) end, {})
          return nil
        end
        return { Component = Component, Registered = Registered }
      `,
      errors: [
        { line: 2, column: 66, message: "Component writes to a ref passed through props", help: "Wrap the component in React.forwardRef so the parent can pass a normal ref, or pass the Instance to the parent through a callback prop", fixPreview: {"kind":"pattern","before":"local function Child(props)\n\treturn React.createElement(\"Frame\", {\n\t\tref = function(instance)\n\t\t\tprops.frameRef.current = instance\n\t\tend,\n\t})\nend","after":"local Child = React.forwardRef(function(props, ref)\n\treturn React.createElement(\"Frame\", {\n\t\tref = ref,\n\t})\nend)","note":"The parent then passes its ref as ref instead of through the frameRef prop. Pass the Instance through a callback prop instead if the parent only needs it at certain moments"} },
        { line: 5, column: 30, help: "Give the parent a callback prop that registers the value and returns a function to unregister it, then call that function from the effect cleanup", fixPreview: {"kind":"pattern","before":"React.useEffect(function()\n\ttable.insert(props.registry.current, instance)\nend, { instance })","after":"React.useEffect(function()\n\treturn props.register(instance)\nend, { instance })","note":"register adds the value in the parent and returns a function that removes it, so unmounted children leave the list"} },
      ],
    },
  ],
});
