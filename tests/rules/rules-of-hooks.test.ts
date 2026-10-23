import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/rules-of-hooks", {
  valid: [
    {
      name: "accepts binding-driven animation with owned cleanup",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function GoodCounter()
          local animatedCount, setAnimatedCount = React.useBinding(0)
          React.useEffect(function()
            local connection = RunService.RenderStepped:Connect(function(dt) setAnimatedCount(animatedCount:getValue() + dt) end)
            return function() connection:Disconnect() end
          end, { animatedCount, setAnimatedCount })
        end
      `,
    },
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
        local lowerCaseComponent = function(props: { value: number }) local value = useThing(props.value) return createElement("TextLabel", { Text = tostring(value) }) end
        local MemoComponent = memo(function(props: { name: string })
          useEffect(function() print(props.name) end, { props })
          return createElement(lowerCaseComponent, { value = 1 })
        end)
        return MemoComponent
      `,
    },
    {
      name: "handles large-codebase React-Luau patterns without known false positives",
      code: dedent`
        export type Props = { binding: typeof(React.useBinding(0)) }
        local RunService = game:GetService("RunService")
        return function(props: Props)
          local position, setPosition = React.useState(UDim2.fromScale(0, 0))
          React.useEffect(function()
            local connection
            connection = RunService.Heartbeat:Connect(function()
              setPosition(UDim2.fromOffset(1, 1))
              setPosition(UDim2.fromOffset(2, 2))
              local count = 10
              count += 1
            end)
            return function() connection:Disconnect() end
          end, {})
        end
      `,
    },
    {
      name: "rules of hooks accepts iteration over a directly exported static module table",
      files: {
        "Component.luau": dedent`
          local Config = require(script.Parent.Config)
          local function Component()
            local values = {}
            for name, initial in Config.Items do
              local value = React.useState(initial)
              values[name] = value
            end
          end
        `,
        "Config.luau": dedent`
          return {
            Items = {
              First = 1,
              Second = 2,
            },
          }
        `,
      },
    },
    {
      name: "rules of hooks accepts private module literal loops and keeps unsafe sources flagged (Direct)",
      code: dedent`
        local BUTTONS = { { name = "Decks" }, { name = "Loadout" } }
        local function Component(props)
          for i, buttonData in BUTTONS do
            React.useCallback(function() return buttonData end, { buttonData })
          end
        end
      `,
    },
    {
      name: "rules of hooks accepts private module literal loops and keeps unsafe sources flagged (Ipairs)",
      code: dedent`
        local BUTTONS = { { name = "Decks" }, { name = "Loadout" } }
        local function Component(props)
          for i, buttonData in ipairs(BUTTONS) do
            React.useCallback(function() return buttonData end, { buttonData })
          end
        end
      `,
    },
    {
      name: "rules of hooks accepts private module literal loops and keeps unsafe sources flagged (Pairs)",
      code: dedent`
        local BUTTONS = { { name = "Decks" }, { name = "Loadout" } }
        local function Component(props)
          for i, buttonData in pairs(BUTTONS) do
            React.useCallback(function() return buttonData end, { buttonData })
          end
        end
      `,
    },
    {
      name: "rules of hooks ignores an early return guarded only by an impossible nil check on a non-optional parameter",
      code: dedent`
        local function useThing(modifier: React.Binding<number>)
          if not modifier then
            return nil
          end
          return React.useCallback(function() return modifier end, { modifier })
        end
      `,
    },
    {
      name: "rules of hooks accepts parameter-controlled hook modes when every call site uses a stable mode",
      files: {
        "Component.luau": dedent`
          local useObservedValue = require(script.Parent.useObservedValue)
          local function Component()
            local first = useObservedValue(true)
            local second = useObservedValue(false)
            local third = useObservedValue()
            return React.createElement("Frame", { Name = tostring(first) .. tostring(second) .. tostring(third) })
          end
        `,
        "useObservedValue.luau": dedent`
          local function useObservedValue(binding: boolean?)
            local value
            if binding then
              value = React.useBinding(0)
            else
              value = React.useState(0)
            end
            return value
          end
          return useObservedValue
        `,
      },
    },
    {
      name: "rules of hooks leaves an unknown prop-controlled custom-hook mode unreported",
      files: {
        "Component.luau": dedent`
          local useObservedValue = require(script.Parent.useObservedValue)
          local function Component(props)
            local value = useObservedValue(props.binding)
            return React.createElement("Frame", { Name = tostring(value) })
          end
        `,
        "useObservedValue.luau": dedent`
          local function useObservedValue(binding: boolean?)
            local value
            if binding then
              value = React.useBinding(0)
            else
              value = React.useState(0)
            end
            return value
          end
          return useObservedValue
        `,
      },
    },
    {
      name: "rules of hooks leaves an uncalled parameter-controlled hook unreported",
      code: dedent`
        local function useObservedValue(binding: boolean?)
          if binding then
            return React.useBinding(0)
          end
          return React.useState(0)
        end
        return useObservedValue
      `,
    },
    {
      name: "rules of hooks does not assume an options-table prop changes without evidence",
      files: {
        "Component.luau": dedent`
          local useObservedValue = require(script.Parent.useObservedValue)
          local function Component(props)
            local value = useObservedValue({ binding = props.binding })
            return React.createElement("Frame", { Name = tostring(value) })
          end
        `,
        "useObservedValue.luau": dedent`
          local function useObservedValue(options)
            if options.binding then
              return React.useBinding(0)
            end
            return React.useState(0)
          end
          return useObservedValue
        `,
      },
    },
    {
      name: "rules of hooks keeps unresolved options-table mode properties unknown",
      files: {
        "Component.luau": dedent`
          local useObservedValue = require(script.Parent.useObservedValue)
          local function Component(props)
            local options = props.options
            local value = useObservedValue(options)
            return React.createElement("Frame", { Name = tostring(value) })
          end
        `,
        "useObservedValue.luau": dedent`
          local function useObservedValue(options)
            if options.binding then
              return React.useBinding(0)
            end
            return React.useState(0)
          end
          return useObservedValue
        `,
      },
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (ComponentProp)",
      code: dedent`
        local function Component(props)
          consume()
          local function Child()
            React.useState(0)
          end
          consume(React.createElement(Wrapper, { component = Child }))
          register(Child)
        end
      `,
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (Conditions)",
      code: dedent`
        local function Component(props)
          consume()
          if React.useState(false) then consume() end
          local choice = if React.useState(false) then 1 else 0
          for i = React.useState(0), 2 do consume() end
        end
      `,
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (ElseIfEquivalent)",
      code: dedent`
        local function Component(props)
          consume()
          if props.first then
            React.useState(0)
          elseif props.second then
            React.useState(1)
          else
            React.useState(2)
          end
        end
      `,
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (ForwardRef)",
      code: dedent`
        local function Component(props)
          consume()
          local Child = React.forwardRef(function() React.useState(0) end)
          consume(React.createElement(Child))
        end
      `,
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (InlineEquivalent)",
      code: dedent`
        local function Component(props)
          consume()
          local value = if props.enabled then React.useState(0) else React.useState(1)
        end
      `,
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (MemoComponent)",
      code: dedent`
        local function Component(props)
          consume()
          local Child = React.memo(function() React.useState(0) end)
          return React.createElement("Frame")
        end
      `,
    },
    {
      name: "rules of hooks accepts module-invariant conditions",
      code: dedent`
        local isLegacy = getLegacyMode()
        local function useThing()
          if isLegacy then
            return React.useState(0)
          else
            return React.useBinding(0)
          end
        end
      `,
    },
    {
      name: "rules of hooks accepts equivalent built-in hook topology across branches",
      code: dedent`
        local function Component(props)
          local value
          if props.alternate then
            value = React.useState(1)
          else
            value = React.useState(2)
          end
        end
      `,
    },
    {
      name: "rules of hooks does not propagate topology sensitivity when both custom-hook branches use the same built-in hooks",
      files: {
        "Component.luau": dedent`
          local useObservedValue = require(script.Parent.useObservedValue)
          local function Component()
            local binding, setBinding = React.useState(true)
            local value = useObservedValue(binding)
            React.useEffect(function() setBinding(false) end, {})
          end
        `,
        "useObservedValue.luau": dedent`
          local function useObservedValue(binding: boolean?)
            if binding then
              return React.useState(1)
            else
              return React.useState(2)
            end
          end
          return useObservedValue
        `,
      },
    },
    {
      name: "rules of hooks accepts stable modes for an anonymously exported custom hook",
      files: {
        "Component.luau": dedent`
          local useScale = require(script.Parent.useScale)
          local function Component()
            local scale = useScale(1, true)
            return React.createElement("Frame", { Size = scale })
          end
        `,
        "useScale.luau": dedent`
          return function(scale: number?, useBinding: boolean?)
            local value = scale or 1
            if useBinding then
              value = React.useBinding(value)
            end
            return value
          end
        `,
      },
    },
    {
      name: "rules of hooks follows a normalized local mode derived from a stable call-site argument",
      files: {
        "Component.luau": dedent`
          local useObservedValue = require(script.Parent.useObservedValue)
          local function Component()
            local value = useObservedValue()
            return React.createElement("Frame", { Name = tostring(value) })
          end
        `,
        "useObservedValue.luau": dedent`
          local function useObservedValue(state: boolean?)
            local useStateValue = if state == nil then true else state
            local value
            if useStateValue then
              value = React.useState(0)
            else
              value = React.useBinding(0)
            end
            return value
          end
          return useObservedValue
        `,
      },
    },
    {
      name: "rules of hooks accepts hook loops over an empty-dependency captured table passed through a local helper",
      code: dedent`
        local React = require(script.Parent.React)
        local useBinding = React.useBinding
        local useMemo = React.useMemo
        local function getStateContainer(defaults)
          local values = {}
          for name, initial in defaults do
            local binding = useBinding(initial)
            values[name] = binding
          end
          return values
        end
        local function useGroupValues(defaults)
          local capturedDefaults = useMemo(function() return defaults end, {})
          return getStateContainer(capturedDefaults)
        end
      `,
    },
    {
      name: "rules of hooks accepts fields of load-time module tables that nothing can rewrite (StableComponent)",
      files: {
        "StableComponent.luau": dedent`
          local Flags = require(script.Parent.Flags)
          local function Component(props)
            local value = if Flags.enabled then React.useMemo(function() return { size = props.size } end, { props.size }) else nil
            if not Flags.other then
              return nil
            end
            local count = React.useState(0)
          end
        `,
        "Flags.luau": dedent`
          local getFlag = require(script.Parent.getFlag)
          return {
            enabled = getFlag("Enabled"),
            other = getFlag("Other"),
          }
        `,
      },
    },
    {
      name: "hook expression: local left = React.useState(0) and props.enabled",
      code: dedent`
        local function Component(props)
          local left = React.useState(0) and props.enabled
        end
      `,
    },
    {
      name: "hook expression: local sum = React.useState(0) + props.offset",
      code: dedent`
        local function Component(props)
          local sum = React.useState(0) + props.offset
        end
      `,
    },
    {
      name: "hook expression: local stable = enabled and React.useState(0)",
      code: dedent`
        local enabled = getMode()
        local function Component(props)
          local stable = enabled and React.useState(0)
        end
      `,
    },
    {
      name: "project-proven non-React use APIs can be conditional",
      files: {
        "MatterSystem.luau": dedent`
          local React = require(script.Parent.React)
          local useMatterReact = require(script.Parent.useMatterReact)
          local function Child()
            return React.createElement("Frame")
          end
          local function mySystem(enabled)
            if enabled then
              useMatterReact({ Child = Child })
            end
          end
        `,
        "useMatterReact.luau": dedent`
          local Matter = require(script.Parent.Matter)
          local function cleanup(storage)
          end
          local function useMatterReact(discriminator)
            local storage = Matter.useHookState(discriminator, cleanup)
            return storage
          end
          return useMatterReact
        `,
      },
    },
    {
      name: "direct scans of non-React use APIs are valid",
      code: dedent`
        local Matter = require(script.Parent.Matter)
        local function cleanup(storage)
        end
        local function useMatterReact(discriminator)
          local storage = Matter.useHookState(discriminator, cleanup)
          return storage
        end
      `,
    },
  ],
  invalid: [
    {
      name: "hook inside a conditional branch",
      code: dedent`
        local function Component(props)
          if props.enabled then
            React.useEffect(function() print(props.title) end, {})
          end
        end
      `,
      errors: [
        { line: 3, column: 5, message: "Hook React.useEffect is called inside if statement, so the hook may be skipped on some renders" },
      ],
    },
    {
      name: "rules of hooks accepts private module literal loops and keeps unsafe sources flagged (Alias)",
      code: dedent`
        local React = require(script.Parent.React)
        local BUTTONS = { { name = "Decks" }, { name = "Loadout" } }
        local function Component(props)
          local alias = BUTTONS
          alias[1] = nil
          for i, buttonData in BUTTONS do
            React.useCallback(function() return buttonData end, { buttonData })
          end
        end
      `,
      errors: [
        { line: 7, column: 5, message: "Hook React.useCallback is called inside for statement whose size or iteration order may change between renders. If that happens, React will see a different hook sequence" },
      ],
    },
    {
      name: "rules of hooks accepts private module literal loops and keeps unsafe sources flagged (Escape)",
      code: dedent`
        local BUTTONS = { { name = "Decks" }, { name = "Loadout" } }
        local function Component(props)
          mutate(BUTTONS)
          for i, buttonData in BUTTONS do
            React.useCallback(function() return buttonData end, { buttonData })
          end
        end
      `,
      errors: [
        { line: 5, column: 5 },
      ],
    },
    {
      name: "rules of hooks accepts private module literal loops and keeps unsafe sources flagged (Insert)",
      code: dedent`
        local BUTTONS = { { name = "Decks" }, { name = "Loadout" } }
        local function Component(props)
          table.insert(BUTTONS, props.item)
          for i, buttonData in BUTTONS do
            React.useCallback(function() return buttonData end, { buttonData })
          end
        end
      `,
      errors: [
        { line: 5, column: 5 },
      ],
    },
    {
      name: "rules of hooks accepts private module literal loops and keeps unsafe sources flagged (Mutated)",
      code: dedent`
        local BUTTONS = { { name = "Decks" }, { name = "Loadout" } }
        local function Component(props)
          BUTTONS[1] = nil
          for i, buttonData in BUTTONS do
            React.useCallback(function() return buttonData end, { buttonData })
          end
        end
      `,
      errors: [
        { line: 5, column: 5 },
      ],
    },
    {
      name: "rules of hooks accepts private module literal loops and keeps unsafe sources flagged (Reassigned)",
      code: dedent`
        local BUTTONS = { { name = "Decks" }, { name = "Loadout" } }
        local function Component(props)
          BUTTONS = props.items
          for i, buttonData in BUTTONS do
            React.useCallback(function() return buttonData end, { buttonData })
          end
        end
      `,
      errors: [
        { line: 5, column: 5 },
      ],
    },
    {
      name: "rules of hooks accepts private module literal loops and keeps unsafe sources flagged (Shadowed)",
      code: dedent`
        local BUTTONS = { { name = "Decks" }, { name = "Loadout" } }
        local function Component(props)
          local BUTTONS = props.items
          for i, buttonData in BUTTONS do
            React.useCallback(function() return buttonData end, { buttonData })
          end
        end
      `,
      errors: [
        { line: 5, column: 5 },
      ],
    },
    {
      name: "rules of hooks still reports loops whose collection shape is runtime-dependent",
      code: dedent`
        local function Component(props)
          for _, initial in props.items do
            React.useState(initial)
          end
        end
      `,
      errors: [
        { line: 3, column: 5, message: "Hook React.useState is called inside for statement whose size or iteration order may change between renders. If that happens, React will see a different hook sequence", fixPreview: {"kind":"pattern","before":"for _, item in items do\n\tlocal value = React.useState(item)\nend","after":"local function Item(props)\n\tlocal value = React.useState(props.item)\n\treturn renderItem(value)\nend\n\nfor _, item in items do\n\tchildren[item.id] = React.createElement(Item, {\n\t\titem = item,\n\t})\nend","note":"When collection size can change, move the hook into a child component so each component instance owns a fixed hook sequence."} },
      ],
    },
    {
      name: "rules of hooks reports custom hooks iterated over a vararg-built table",
      code: dedent`
        local function useComponent(entity, component)
          local value = React.useState(0)
          return value
        end
        local function useEntity(entity, ...)
          local components = {...}
          local values = {}
          for i, component in ipairs(components) do
            values[i] = useComponent(entity, component)
          end
          return values
        end
      `,
      errors: [
        { line: 9, column: 17, message: "Hook useComponent is called inside for statement whose size or iteration order may change between renders. If that happens, React will see a different hook sequence" },
      ],
    },
    {
      name: "rules of hooks keeps early-return diagnostics when the guarded parameter is optional",
      code: dedent`
        local function useThing(modifier: React.Binding<number>?)
          if not modifier then
            return nil
          end
          return React.useCallback(function() return modifier end, { modifier })
        end
      `,
      errors: [
        { line: 5, column: 10, message: "Hook React.useCallback may run after an earlier reachable return, so some renders can execute fewer hooks." },
      ],
    },
    {
      name: "rules of hooks reports a custom-hook mode that is proven to change through state",
      files: {
        "Component.luau": dedent`
          local useObservedValue = require(script.Parent.useObservedValue)
          local function Component()
            local binding, setBinding = React.useState(true)
            local value = useObservedValue(binding)
            React.useEffect(function() setBinding(false) end, {})
          end
        `,
        "useObservedValue.luau": dedent`
          local function useObservedValue(binding: boolean?)
            if binding then
              return React.useBinding(0)
            end
            return React.useState(0)
          end
          return useObservedValue
        `,
      },
      errors: [
        { line: 4, column: 34, message: "Hook useObservedValue receives hook-topology mode binding from binding, which is updated between renders and can make the custom hook execute a different hook sequence.", file: "Component.luau" },
      ],
    },
    {
      name: "rules of hooks tracks topology modes stored in options-table properties",
      files: {
        "Component.luau": dedent`
          local useObservedValue = require(script.Parent.useObservedValue)
          local function Component()
            local binding, setBinding = React.useState(true)
            local value = useObservedValue({ binding = binding })
            React.useEffect(function() setBinding(false) end, {})
          end
        `,
        "useObservedValue.luau": dedent`
          local function useObservedValue(options)
            if options.binding then
              return React.useBinding(0)
            end
            return React.useState(0)
          end
          return useObservedValue
        `,
      },
      errors: [
        { line: 4, column: 46, message: "Hook useObservedValue receives hook-topology mode options.binding from binding, which is updated between renders and can make the custom hook execute a different hook sequence.", file: "Component.luau" },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (Break)",
      code: dedent`
        local function Component(props)
          consume()
          for i = 1, 2 do
            React.useState(0)
            if props.enabled then break end
          end
        end
      `,
      errors: [
        { line: 4, column: 5 },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (CapturedShadow)",
      code: dedent`
        local mode = getMode()
        local function Component(props)
          consume()
          local mode = props.enabled
          local function Child()
            if mode then React.useState(0) end
          end
          consume(React.createElement(Child))
        end
      `,
      errors: [
        { line: 6, column: 18, message: "Hook React.useState is called inside if statement, so the hook may be skipped on some renders" },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (Continue)",
      code: dedent`
        local function Component(props)
          consume()
          for i = 1, 2 do
            if props.enabled then continue end
            React.useState(0)
          end
        end
      `,
      errors: [
        { line: 5, column: 5 },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (DeferredCallback)",
      code: dedent`
        local function Component(props)
          consume()
          task.defer(function() React.useState(0) end)
          return React.createElement("Frame")
        end
      `,
      errors: [
        { line: 3, column: 25, message: "Hook React.useState is called outside a React component or custom hook" },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (EffectCallback)",
      code: dedent`
        local function Component(props)
          consume()
          React.useEffect(function() React.useState(0) end, {})
        end
      `,
      errors: [
        { line: 3, column: 30 },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (ElseIf)",
      code: dedent`
        local mode = getMode()
        local function Component(props)
          consume()
          if mode then
            consume()
          elseif props.enabled then
            React.useState(0)
          end
        end
      `,
      errors: [
        { line: 7, column: 5 },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (ElseIfConditionHook)",
      code: dedent`
        local function Component(props)
          consume()
          if props.first then
            React.useState(0)
          elseif React.useState(false) then
            React.useState(1)
          else
            React.useState(2)
          end
        end
      `,
      errors: [
        { line: 4, column: 5 },
        { line: 5, column: 10 },
        { line: 6, column: 5 },
        { line: 8, column: 5 },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (ElseIfTopology)",
      code: dedent`
        local function Component(props)
          consume()
          if props.first then
            React.useState(0)
          elseif props.second then
            React.useBinding(0)
          else
            React.useState(0)
          end
        end
      `,
      errors: [
        { line: 4, column: 5 },
        { line: 6, column: 5, message: "Hook React.useBinding is called inside if statement, so the hook may be skipped on some renders" },
        { line: 8, column: 5 },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (EventCallback)",
      code: dedent`
        local function Component(props)
          consume()
          local child = React.createElement("TextButton", { [React.Event.Activated] = function() React.useState(0) end })
        end
      `,
      errors: [
        { line: 3, column: 90 },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (ExclusiveReturn)",
      code: dedent`
        local function Component(props)
          consume()
          if props.enabled then return nil else React.useState(0) end
        end
      `,
      errors: [
        { line: 3, column: 41 },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (HookModeElseIf)",
      code: dedent`
        local mode = getMode()
        local function useValue(mode)
          consume()
          local enabled, setEnabled = React.useState(false)
          if mode then
            consume()
          elseif enabled then
            React.useState(0)
          end
          React.useEffect(function() setEnabled(true) end, {})
        end
      `,
      errors: [
        { line: 8, column: 5 },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (Inline)",
      code: dedent`
        local function Component(props)
          consume()
          local value = if props.enabled then React.useState(0) else nil
        end
      `,
      errors: [
        { line: 3, column: 39, message: "Hook React.useState is called inside if expression, so the hook may be skipped on some renders" },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (InlineElseIf)",
      code: dedent`
        local mode = getMode()
        local function Component(props)
          consume()
          local value = if mode then nil elseif props.enabled then React.useState(0) else nil
        end
      `,
      errors: [
        { line: 4, column: 60 },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (LoopGuardedReturn)",
      code: dedent`
        local mode = getMode()
        local function Component(props)
          consume()
          for _, item in props.items do
            if mode then return nil end
          end
          React.useState(0)
        end
      `,
      errors: [
        { line: 7, column: 3, message: "Hook React.useState may run after an earlier reachable return, so some renders can execute fewer hooks." },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (LoopReturn)",
      code: dedent`
        local function Component(props)
          consume()
          for i = 1, 2 do
            React.useState(0)
            if props.enabled then return nil end
          end
        end
      `,
      errors: [
        { line: 4, column: 5 },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (MemoCallback)",
      code: dedent`
        local function Component(props)
          consume()
          local value = React.useMemo(function() return React.useState(0) end, {})
        end
      `,
      errors: [
        { line: 3, column: 49 },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (NamedCallback)",
      code: dedent`
        local function Component(props)
          consume()
          local function calculate()
            return React.useState(0)
          end
          local alias = calculate
          React.useMemo(alias, {})
        end
      `,
      errors: [
        { line: 4, column: 12 },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (NestedLoop)",
      code: dedent`
        local function Component(props)
          consume()
          if props.enabled then
            for i = 1, 2 do React.useState(0) end
          end
        end
      `,
      errors: [
        { line: 4, column: 21 },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (NestedReturn)",
      code: dedent`
        local mode = getMode()
        local function Component(props)
          consume()
          if props.enabled then
            if mode then return nil end
          end
          React.useState(0)
        end
      `,
      errors: [
        { line: 7, column: 3 },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (NestedStatement)",
      code: dedent`
        local mode = getMode()
        local function Component(props)
          consume()
          if props.enabled then
            if mode then React.useState(0) end
          end
        end
      `,
      errors: [
        { line: 5, column: 18 },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (ReassignedLocal)",
      code: dedent`
        local function Component(props)
          consume()
          local enabled = true
          enabled = props.enabled
          if enabled then React.useState(0) end
        end
      `,
      errors: [
        { line: 5, column: 19 },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (RedeclaredLocal)",
      code: dedent`
        local function Component(props)
          consume()
          local enabled = true
          local enabled = props.enabled
          if enabled then React.useState(0) end
        end
      `,
      errors: [
        { line: 5, column: 19 },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (Repeat)",
      code: dedent`
        local function Component(props)
          consume()
          repeat React.useState(0) until props.enabled
        end
      `,
      errors: [
        { line: 3, column: 10, message: "Hook React.useState is called inside repeat statement whose size or iteration order may change between renders. If that happens, React will see a different hook sequence" },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (ShadowedModule)",
      code: dedent`
        local mode = getMode()
        local function Component(props)
          consume()
          local mode = props.enabled
          if mode then React.useState(0) end
        end
      `,
      errors: [
        { line: 5, column: 16 },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (ShadowedParameter)",
      code: dedent`
        local mode = getMode()
        local function Component(mode)
          consume()
          if mode then React.useState(0) end
        end
      `,
      errors: [
        { line: 4, column: 16 },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (TableKey)",
      code: dedent`
        local function Component(props)
          consume()
          local value = { [props.enabled and React.useState(0)] = true }
        end
      `,
      errors: [
        { line: 3, column: 38, message: "Hook React.useState is called inside short-circuit expression, so the hook may be skipped on some renders" },
      ],
    },
    {
      name: "rules of hooks checks every guard and reachable exit in Luau control flow (While)",
      code: dedent`
        local function Component(props)
          consume()
          while props.enabled do React.useState(0) end
        end
      `,
      errors: [
        { line: 3, column: 26, message: "Hook React.useState is called inside while statement whose size or iteration order may change between renders. If that happens, React will see a different hook sequence" },
      ],
    },
    {
      name: "rules of hooks still reports a helper hook loop when its table parameter is not lifetime-captured",
      code: dedent`
        local function getStateContainer(defaults)
          for _, initial in defaults do
            React.useBinding(initial)
          end
        end
        local function useGroupValues(defaults)
          getStateContainer(defaults)
        end
      `,
      errors: [
        { line: 3, column: 5, message: "Hook React.useBinding is called inside for statement whose size or iteration order may change between renders. If that happens, React will see a different hook sequence" },
      ],
    },
    {
      name: "Roact and RoactCompat namespaces are analyzed as React",
      code: dedent`
        local Roact = require(script.Parent.Roact)
        local useThing = require(script.Parent.useThing)
        local function Component(props)
          if props.enabled then
            useThing()
          end
          return Roact.createElement("Frame")
        end
      `,
      errors: [
        { line: 5, column: 5, message: "Hook useThing is called inside if statement, so the hook may be skipped on some renders" },
      ],
    },
    {
      name: "rules of hooks accepts fields of load-time module tables that nothing can rewrite (ExportedComponent)",
      files: {
        "ExportedComponent.luau": dedent`
          local Flags = require(script.Parent.ExportedFlags)
          local function Component(props)
            local value = if Flags.enabled then React.useMemo(function() return { size = props.size } end, { props.size }) else nil
            if not Flags.other then
              return nil
            end
            local count = React.useState(0)
          end
        `,
        "ExportedFlags.luau": dedent`
          local getFlag = require(script.Parent.getFlag)
          return {
            enabled = getFlag("Enabled"),
            other = getFlag("Other"),
          }
        `,
        "Package.luau": dedent`
          return { Flags = require(script.Parent.ExportedFlags) }
        `,
      },
      errors: [
        { line: 3, column: 39, message: "Hook React.useMemo is called inside if expression, so the hook may be skipped on some renders", file: "ExportedComponent.luau" },
        { line: 7, column: 17, file: "ExportedComponent.luau" },
      ],
    },
    {
      name: "rules of hooks accepts fields of load-time module tables that nothing can rewrite (ModuleComponent)",
      files: {
        "ModuleComponent.luau": dedent`
          local Flags = require(script.Parent.ModuleFlags)
          local function Component(props)
            local value = if Flags.enabled then React.useMemo(function() return { size = props.size } end, { props.size }) else nil
            if not Flags.other then
              return nil
            end
            local count = React.useState(0)
          end
        `,
        "ModuleFlags.luau": dedent`
          local getFlag = require(script.Parent.getFlag)
          local ModuleFlags = { enabled = getFlag("Enabled") }
          ModuleFlags.other = getFlag("Other")
          function ModuleFlags.toggle()
            ModuleFlags.enabled = not ModuleFlags.enabled
          end
          return ModuleFlags
        `,
      },
      errors: [
        { line: 3, column: 39, file: "ModuleComponent.luau" },
      ],
    },
    {
      name: "rules of hooks accepts fields of load-time module tables that nothing can rewrite (WrittenComponent)",
      files: {
        "WrittenComponent.luau": dedent`
          local Flags = require(script.Parent.WrittenFlags)
          local function Component(props)
            local value = if Flags.enabled then React.useMemo(function() return { size = props.size } end, { props.size }) else nil
            if not Flags.other then
              return nil
            end
            local count = React.useState(0)
          end
        `,
        "WrittenFlags.luau": dedent`
          local getFlag = require(script.Parent.getFlag)
          return {
            enabled = getFlag("Enabled"),
            other = getFlag("Other"),
          }
        `,
        "Debug.luau": dedent`
          local WrittenFlags = require(script.Parent.WrittenFlags)
          return function() WrittenFlags.other = true end
        `,
      },
      errors: [
        { line: 7, column: 17, file: "WrittenComponent.luau" },
      ],
    },
    {
      name: "rules-of-hooks explains hooks inside protected calls",
      code: dedent`
        local function Component(props)
          local ok, value = pcall(function() return React.useContext(props.context) end)
          return React.createElement("Frame", { Visible = ok and value })
        end
      `,
      errors: [
        { line: 2, column: 45, message: "Hook React.useContext is called inside a pcall callback, so an error can skip it on some renders" },
      ],
    },
    {
      name: "hook expression: local first = props.enabled and useState(0)",
      code: dedent`
        local React = require(script.Parent.React)
        local useState = React.useState
        local function Component(props)
          local first = props.enabled and useState(0)
        end
      `,
      errors: [
        { line: 4, column: 35 },
      ],
    },
    {
      name: "hook expression: local second = props.enabled or useValue()",
      code: dedent`
        local function useValue()
          return React.useState(0)
        end
        local function Component(props)
          local second = props.enabled or useValue()
        end
      `,
      errors: [
        { line: 5, column: 35, message: "Hook useValue is called inside short-circuit expression, so the hook may be skipped on some renders" },
      ],
    },
    {
      name: "hook expression: local nested = props.enabled and (true and React.useState(0))",
      code: dedent`
        local function Component(props)
          local nested = props.enabled and (true and React.useState(0))
        end
      `,
      errors: [
        { line: 2, column: 46 },
      ],
    },
    {
      name: "hook expression: return React.createElement(\"Frame\", {}, {",
      code: dedent`
        local function Component(props)
          return React.createElement("Frame", {}, {
            child = props.enabled and React.createElement("TextButton", { Activated = React.useCallback(function() end, {}) }),
          })
        end
      `,
      errors: [
        { line: 3, column: 79, message: "Hook React.useCallback is called inside short-circuit expression, so the hook may be skipped on some renders" },
      ],
    },
    {
      name: "hook calls do not turn nested callbacks into components",
      code: dedent`
        local function Component(props)
          local function useLabel(label)
            label.Text = props.text
          end
          return React.createElement("TextButton", {
            [React.Event.Activated] = function()
              task.spawn(function()
                local label = Instance.new("TextLabel")
                useLabel(label)
                label.Parent = props.container
              end)
            end,
            [React.Event.MouseEnter] = function()
              local hovered = React.useState(false)
              Instance.new("Part").Parent = props.container
            end,
          })
        end
      `,
      errors: [
        { file: "Component.luau", line: 9, column: 9, message: "Hook useLabel is called outside a React component or custom hook", severity: "error" },
        { file: "Component.luau", line: 14, column: 23, severity: "error" },
      ],
    },
    {
      name: "transitively imported React hooks stay conditional",
      files: {
        "BadReactComponent.luau": dedent`
          local React = require(script.Parent.React)
          local useOuter = require(script.Parent.useOuter)
          local function BadReactComponent(props)
            if props.enabled then
              useOuter()
            end
          end
        `,
        "useInner.luau": dedent`
          local React = require(script.Parent.React)
          local function useInner()
            return React.useState(0)
          end
          return useInner
        `,
        "useOuter.luau": dedent`
          local useInner = require(script.Parent.useInner)
          local function useOuter()
            return useInner()
          end
          return useOuter
        `,
      },
      errors: [
        { file: "BadReactComponent.luau", line: 5, column: 5, message: "Hook useOuter is called inside if statement, so the hook may be skipped on some renders" },
      ],
    },
  ],
});
