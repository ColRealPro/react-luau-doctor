import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/exhaustive-deps", {
  valid: [
    {
      name: "recognizes aliases, assigned custom hooks, and memo-wrapped components",
      code: dedent`
        local ReplicatedStorage = game:GetService("ReplicatedStorage")
        local React = require(ReplicatedStorage.Client.Modules.React)
        local createElement = React.createElement
        local memo = React.memo
        local useEffect = React.useEffect
        local useThing = function(value)
          local state, setState = React.useState(value)
          React.useEffect(function() print(state) end, { state })
          return state, setState
        end
        local lowerCaseComponent = function(props) local value = useThing(props.value) return createElement("TextLabel", { Text = tostring(value) }) end
        local MemoComponent = memo(function(props) useEffect(function() print(props.name) end, { props }) return createElement(lowerCaseComponent, { value = 1 }) end)
        return MemoComponent
      `,
    },
    {
      name: "dependency analysis respects nested shadowing and hook bindings are scoped per function",
      code: dedent`
        local function FirstComponent()
          local ref = React.useRef(nil)
        end
        local function SecondComponent(props)
          local value = props.value
          local ref = props.externalRef
          React.useEffect(function()
            local function consume(value)
              print(value)
            end
            consume(1)
            print(props.title)
            print(ref.current)
          end, { props.title, ref.current })
        end
      `,
    },
    {
      name: "dependency analysis ignores generic and annotation-only type identifiers",
      code: dedent`
        local function useTypedMemo<T>(value: T)
          local callback = React.useCallback(function(nextValue: T): T return nextValue end, {})
          return React.useMemo(function(): T
            local copy = value :: T
            callback(copy)
            return copy
          end, { value, callback })
        end
      `,
    },
    {
      name: "dependency tables recognize immutable transparent aliases (Alias)",
      code: dedent`
        local React = require(script.Parent.React)
        local function Alias(props)
          local store = props.store
          React.useMemo(function() return props.store:getState() end, { store })
        end
      `,
    },
    {
      name: "dependency tables recognize immutable transparent aliases (AliasChain)",
      code: dedent`
        local React = require(script.Parent.React)
        local function AliasChain(props)
          local source = props
          local store = source.store
          React.useMemo(function() return props.store:getState() end, { store })
        end
      `,
    },
    {
      name: "dependency tables normalize transparent casts and optional false sentinels (Normalized)",
      code: dedent`
        local function Normalized(plugin: Plugin, menu: PluginMenu?)
          React.useEffect(function() print(plugin, menu) end, { (plugin :: any), menu or false })
        end
      `,
    },
    {
      name: "context memo includes its state dependency",
      code: dedent`
        local StableContext = React.createContext(nil)
        local function AdvancedValid(props)
          local count, setCount = React.useState(0)
          local contextValue = React.useMemo(function() return { count = count } end, { count })
          return React.createElement(StableContext.Provider, { value = contextValue })
        end
      `,
    },
    {
      name: "animation effect includes binding and setter dependencies",
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
    {
      name: "functional event updates do not need dependency tables",
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
      name: "dependency table contents: Complete",
      code: dedent`
        local function Component(props)
          local dependencies = { props.query, props.category }
          React.useEffect(function() search(props.query, props.category) end, dependencies)
        end
      `,
    },
    {
      name: "dependency table contents: Conditional",
      code: dedent`
        local function Component(props)
          local dependencies = { props.query }
          if props.enabled then dependencies = {} end
          React.useEffect(function() search(props.query, props.category) end, dependencies)
        end
      `,
    },
    {
      name: "dependency table contents: Escaped",
      code: dedent`
        local function Component(props)
          local dependencies = { props.query }
          updateDependencies(dependencies)
          React.useEffect(function() search(props.query, props.category) end, dependencies)
        end
      `,
    },
    {
      name: "dependency table contents: Mutated",
      code: dedent`
        local function Component(props)
          local dependencies = { props.query }
          table.insert(dependencies, props.category)
          React.useEffect(function() search(props.query, props.category) end, dependencies)
        end
      `,
    },
    {
      name: "dependency table contents: Shadowed",
      code: dedent`
        local function Component(props)
          local dependencies = { props.query }
          do
            local dependencies = { props.query, props.category }
            React.useEffect(function() search(props.query, props.category) end, dependencies)
          end
        end
      `,
    },
    {
      name: "dependency table contents: Written",
      code: dedent`
        local function Component(props)
          local dependencies = { props.query }
          local alias = dependencies
          alias[2] = props.category
          React.useEffect(function() search(props.query, props.category) end, dependencies)
        end
      `,
    },
    {
      name: "useCallback captured by a dependency hook is unobserved only when its captures are stable",
      files: {
        "Component.luau": dedent`
          local function Component(props)
            local open, setOpen = React.useState(false)
            local close = React.useCallback(function() setOpen(false) end, {})
            local notify = React.useCallback(function() props.onClose() end, { props.onClose })
            local reset = React.useCallback(function() setOpen(false) end, { setOpen })
            React.useEffect(function()
              if not props.visible then
                close()
                notify()
                reset()
              end
            end, { props.visible, notify })
          end
        `,
        "Plain.luau": dedent`
          local function Plain(props)
            local open, setOpen = React.useState(false)
            local close = function() setOpen(false) end
            local notify = function() props.onClose() end
            React.useEffect(function()
              if not props.visible then
                close()
                notify()
              end
            end, { props.visible, props.onClose })
          end
          return Plain
        `,
      },
    },
    {
      name: "type annotations in multi-name locals are not treated as declared names",
      code: dedent`
        local function Component()
          local value: Value, setValue = React.useState(0)
          local increment = React.useCallback(function() setValue(1) end, {})
          return React.createElement("TextButton", { Text = tostring(value), [React.Event.Activated] = increment })
        end
      `,
    },
  ],
  invalid: [
    {
      name: "dependency analysis resolves shadowed module locals inside initializers without hiding later reactive reads",
      code: dedent`
        local React = require(script.Parent.React)
        local catalog = require(script.Parent.Catalog)
        local function Component(props)
          local catalog = React.useMemo(function() return catalog[props.id] end, { props.id })
          React.useEffect(function() consume(catalog) end, {})
        end
      `,
      errors: [
        { line: 5, column: 52, message: "React.useEffect dependency table is missing catalog." },
      ],
    },
    {
      name: "effect omits captured state",
      code: dedent`
        local function Component(props)
          local count = React.useState(0)
          React.useEffect(function() print(count) end, {})
        end
      `,
      errors: [
        { line: 3, column: 48, message: "React.useEffect dependency table is missing count." },
      ],
    },
    {
      name: "effect omits a captured prop",
      code: dedent`
        local function Component(props)
          React.useEffect(function() print(props.title) end, {})
        end
      `,
      errors: [
        { line: 2, column: 54, message: "React.useEffect dependency table is missing props.title." },
      ],
    },
    {
      name: "dependency tables recognize immutable transparent aliases (DerivedValue)",
      code: dedent`
        local React = require(script.Parent.React)
        local function DerivedValue(props)
          local hasStore = props.store ~= nil
          React.useMemo(function() return props.store end, { hasStore })
        end
      `,
      errors: [
        { line: 4, column: 52, message: "React.useMemo dependency table is missing props.store." },
      ],
    },
    {
      name: "dependency tables recognize immutable transparent aliases (MutableAlias)",
      code: dedent`
        local React = require(script.Parent.React)
        local function MutableAlias(props)
          local store = props.store
          store = props.otherStore
          React.useMemo(function() return props.store:getState() end, { store })
        end
      `,
      errors: [
        { line: 5, column: 63 },
      ],
    },
    {
      name: "dependency tables normalize transparent casts and optional false sentinels (UnsafeFallback)",
      code: dedent`
        local function UnsafeFallback(value, fallback)
          React.useEffect(function() print(value) end, { value or fallback })
        end
      `,
      errors: [
        { line: 2, column: 48, message: "React.useEffect dependency table is missing value." },
      ],
    },
    {
      name: "dependency analysis excludes mutable Roblox leaf values, refs, and bindings while keeping reactive identity",
      code: dedent`
        local function DependencyReactivity(props)
          local ref = React.useRef(nil)
          local binding = React.useBinding(0)
          local numberValue = React.useMemo(function() return Instance.new("NumberValue") end, {})
          React.useEffect(function()
            print(ref.current)
            print(binding:getValue())
            print(numberValue.Value)
            numberValue.Changed:Connect(function() print(numberValue.Value) end)
            print(props.Instance.CFrame)
            print(props.value)
            return function() numberValue:Destroy() end
          end, {})
        end
      `,
      errors: [
        { line: 13, column: 8, message: "React.useEffect dependency table is missing props.Instance, props.value." },
      ],
    },
    {
      name: "dynamic unpack dependency tables are reported as partial-analysis suggestions",
      code: dedent`
        local function useDynamicEffect(callback, bindings, deps)
          React.useEffect(function() callback(bindings) end, { unpack(bindings), unpack(deps or {}) })
        end
        local function DependencyConfidence(props)
          local memoizedValue = React.useMemo(function() return props.value * 2 end, { props.value })
          local memoizedCallback = React.useCallback(function() print(props.enabled) end, { props.enabled })
          React.useEffect(function()
            print(memoizedValue)
            memoizedCallback()
          end, { props.value, props.enabled })
          React.useEffect(function() print(memoizedValue) end, {})
          local derivedValue = props.value or 0
          local isComplete = props.count >= props.total
          local h, s = props.color:ToHSV()
          React.useEffect(function() print(derivedValue, h, s) end, { props.value, props.color })
          React.useEffect(function() print(isComplete) end, { props.count })
        end
        return {
          useDynamicEffect = useDynamicEffect,
          DependencyConfidence = DependencyConfidence,
        }
      `,
      errors: [
        { line: 2, column: 54, message: "React.useEffect uses dynamic unpack(...) dependencies, so exhaustive dependency analysis is partial.", severity: "suggestion" },
        { line: 10, column: 8, message: "React.useEffect captures memoized value memoizedCallback, memoizedValue without listing them directly, but their memo dependencies are already covered.", severity: "suggestion" },
        { line: 11, column: 56, message: "React.useEffect dependency table is missing memoizedValue.", severity: "warning" },
        { line: 16, column: 53, message: "React.useEffect dependency table is missing props.total.", severity: "warning" },
      ],
    },
    {
      name: "dependency table contents: Alias",
      code: dedent`
        local React = require(script.Parent.React)
        local function Component(props)
          local dependencies = { props.query }
          React.useEffect(function() search(props.query, props.category) end, dependencies)
        end
      `,
      errors: [
        { line: 4, column: 71, message: "React.useEffect dependency table is missing props.category." },
      ],
    },
    {
      name: "dependency table contents: Chain",
      code: dedent`
        local function Component(props)
          local dependencies = { props.query }
          local alias = (dependencies :: { any })
          React.useEffect(function() search(props.query, props.category) end, alias)
        end
      `,
      errors: [
        { line: 4, column: 71 },
      ],
    },
    {
      name: "dependency table contents: Inline",
      code: dedent`
        local function Component(props)
          React.useEffect(function() search(props.query, props.category) end, { props.query })
        end
      `,
      errors: [
        { line: 2, column: 71 },
      ],
    },
    {
      name: "dependency table contents: Memo",
      code: dedent`
        local function Component(props)
          local producerDependencies = { props.query }
          local result = React.useMemo(function() return transform(props.query) end, producerDependencies)
          local dependencies = { props.query }
          React.useEffect(function() consume(result) end, dependencies)
        end
      `,
      errors: [
        { line: 5, column: 51, message: "React.useEffect captures memoized value result without listing it directly, but its memo dependencies are already covered.", severity: "suggestion" },
      ],
    },
    {
      name: "dependency table contents: Reassigned",
      code: dedent`
        local function Component(props)
          local dependencies = {}
          dependencies = { props.query }
          React.useEffect(function() search(props.query, props.category) end, dependencies)
        end
      `,
      errors: [
        { line: 4, column: 71 },
      ],
    },
    {
      name: "dependency table contents: Reused",
      code: dedent`
        local function Component(props)
          local dependencies = { props.query }
          React.useCallback(function() return props.query end, dependencies)
          React.useEffect(function() search(props.query, props.category) end, dependencies)
        end
      `,
      errors: [
        { line: 4, column: 71 },
      ],
    },
  ],
});
