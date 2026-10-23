import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/prefer-binding-over-state", {
  valid: [
    {
      name: "binding-over-state keeps measurement state when an effect performs behavioral work",
      files: {
        "Consumer.luau": dedent`
          local useObservedGuiMetric = require(script.Parent.useObservedGuiMetric)
          local function Consumer(props)
            local ref = React.useRef(nil)
            local measuredSize = useObservedGuiMetric(ref, "AbsoluteSize")
            React.useEffect(function()
              if measuredSize then
                props.onMeasured(measuredSize)
              end
            end, { measuredSize, props.onMeasured })
            return React.createElement("Frame", { ref = ref })
          end
        `,
        "useObservedGuiMetric.luau": dedent`
          local function useObservedGuiMetric(targetRef, observedKey)
            local value, setValue = React.useState(nil)
            React.useEffect(function()
              local instance = targetRef.current
              instance:GetPropertyChangedSignal(observedKey):Connect(function() setValue(instance[observedKey]) end)
            end, { targetRef, observedKey })
            return value
          end
          return useObservedGuiMetric
        `,
      },
    },
    {
      name: "binding-over-state infers dual-mode measurement hooks and skips calls already using binding mode (BindingConsumer)",
      files: {
        "BindingConsumer.luau": dedent`
          local useObservedMetric = require(script.Parent.useObservedMetric)
          local function BindingConsumer()
            local ref = React.useRef(nil)
            local measuredSize = useObservedMetric(ref, "AbsoluteSize", {}, true)
            return React.createElement("Frame", { ref = ref, Size = measuredSize })
          end
        `,
        "useObservedMetric.luau": dedent`
          local function useObservedMetric(targetRef, observedKey, dependencies, preferBinding)
            local value, updateValue
            if preferBinding then
              value, updateValue = React.useBinding(nil)
            else
              value, updateValue = React.useState(nil)
            end
            React.useEffect(function()
              local instance = targetRef.current
              instance:GetPropertyChangedSignal(observedKey):Connect(function() updateValue(instance[observedKey]) end)
            end, { targetRef, observedKey, unpack(dependencies or {}) })
            return value
          end
          return useObservedMetric
        `,
      },
    },
    {
      name: "binding-over-state keeps semantic external snapshots in React state",
      files: {
        "Consumer.luau": dedent`
          local useSnapshot = require(script.Parent.useSnapshot)
          local function Consumer(props)
            local snapshot = useSnapshot(props.replicator)
            local text = snapshot and snapshot.Ammo or 0
            return React.createElement("TextLabel", { Text = text })
          end
        `,
        "useSnapshot.luau": dedent`
          local function useSnapshot(replicator)
            local state, setState = React.useState(nil)
            React.useEffect(function()
              replicator.Changed:Connect(function() setState(table.clone(replicator.State)) end)
              setState(replicator.State)
            end, { replicator })
            return state
          end
          return useSnapshot
        `,
      },
    },
    {
      name: "binding-over-state does not invent a binding alternative from a method name alone",
      files: {
        "Consumer.luau": dedent`
          local StateStore = require(script.Parent.StateStore)
          local function Consumer()
            local rotation = StateStore:GetReactState(function(state) return state.rotation end)
            return React.createElement("Frame", { Rotation = rotation })
          end
        `,
        "StateStore.luau": dedent`
          local StateStore = {}
          function StateStore:GetReactState(selector)
            return nil
          end
          return StateStore
        `,
      },
    },
    {
      name: "binding-over-state keeps arbitrary named signal state and structural high-frequency state",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function Consumer(props)
          local position, setPosition = React.useState(UDim2.fromOffset(0, 0))
          local hoverResizeEdge, setHoverResizeEdge = React.useState(nil)
          React.useEffect(function()
            local function update()
              setPosition(UDim2.fromOffset(1, 1))
            end
            local changed = props.signal:Connect(update)
            local heartbeat = RunService.Heartbeat:Connect(function()
              local nextEdge = nil
              if hoverResizeEdge ~= nextEdge then
                setHoverResizeEdge(nextEdge)
              end
            end)
            return function()
              changed:Disconnect()
              heartbeat:Disconnect()
            end
          end, { hoverResizeEdge })
          return React.createElement("Frame", { Position = position }, {
            child = hoverResizeEdge and React.createElement("Frame") or nil,
          })
        end
      `,
    },
    {
      name: "binding-over-state keeps host measurements in state when they determine React structure",
      code: dedent`
        local function Component()
          local absoluteSize, setAbsoluteSize = React.useState(Vector2.zero)
          local children = {}
          if absoluteSize.X > 300 then
            children.sidebar = React.createElement("Frame")
          end
          return React.createElement("Frame", {
            [React.Change.AbsoluteSize] = function(instance) setAbsoluteSize(instance.AbsoluteSize) end,
          }, children)
        end
      `,
    },
    {
      name: "binding-over-state keeps imported constant event transitions in React state",
      files: {
        "Consumer.luau": dedent`
          local React = require(script.Parent.React)
          local useOpenedState = require(script.Parent.useOpenedState)
          local function Consumer(props)
            local visible = useOpenedState(props.opened)
            return React.createElement("Frame", { Visible = visible })
          end
        `,
        "useOpenedState.luau": dedent`
          local React = require(script.Parent.React)
          local function useOpenedState(signal)
            local visible, setVisible = React.useState(false)
            React.useEffect(function()
              signal:Connect(function() setVisible(true) end)
            end, { signal })
            return visible
          end
          return useOpenedState
        `,
      },
    },
    {
      name: "binding-over-state keeps event-driven constant state transitions in React state",
      code: dedent`
        local function Component(props)
          local visible, setVisible = React.useState(false)
          React.useEffect(function()
            props.opened:Connect(function() setVisible(true) end)
          end, { props.opened })
          return React.createElement("Frame", { Visible = visible })
        end
      `,
    },
    {
      name: "binding-over-state keeps reducer-style external updates in React state",
      code: dedent`
        local function Component(props)
          local count, setCount = React.useState(0)
          React.useEffect(function()
            props.incremented:Connect(function() setCount(function(previous) return previous + 1 end) end)
          end, { props.incremented })
          return React.createElement("TextLabel", { Text = tostring(count) })
        end
      `,
    },
    {
      name: "binding-over-state ignores one-shot external callbacks",
      code: dedent`
        local function Component(props)
          local rotation, setRotation = React.useState(0)
          React.useEffect(function() return props.ready:Once(function(value) setRotation(value) end) end, { props.ready })
          return React.createElement("Frame", { Rotation = rotation })
        end
      `,
    },
    {
      name: "binding-over-state keeps store snapshot subscriptions semantic",
      files: {
        "Consumer.luau": dedent`
          local useStoreState = require(script.Parent.useStoreState)
          local function Consumer(props)
            local state = useStoreState(props.store)
            return React.createElement("TextLabel", { Text = tostring(state.count) })
          end
        `,
        "useStoreState.luau": dedent`
          local function useStoreState(store)
            local state, setState = React.useState(store:getState())
            React.useEffect(function() return store:subscribe(function() setState(store:getState()) end) end, { store })
            return state
          end
          return useStoreState
        `,
      },
    },
    {
      name: "continuous presentation updates already use bindings",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function AdvancedValid(props)
          local animated, setAnimated = React.useBinding(0)
          React.useEffect(function()
            RunService.RenderStepped:Connect(function(dt) setAnimated(animated:getValue() + dt) end)
          end, { animated, setAnimated })
          return React.createElement("Frame", { Rotation = animated })
        end
      `,
    },
    {
      name: "event driven state remains state",
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
      name: "state determines child structure",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function TreeState()
          local visible, setVisible = React.useState(false)
          React.useEffect(function()
            RunService.RenderStepped:Connect(function(dt) setVisible(dt > 0) end)
          end, {})
          return React.createElement("Frame", {}, { child = visible and React.createElement("TextLabel") or nil })
        end
      `,
    },
    {
      name: "custom prop transforms the value instead of forwarding a binding",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function Child(props)
          return React.createElement("TextLabel", { Text = tostring(props.Value) })
        end
        local function CustomPropState()
          local currentTime, setCurrentTime = React.useState(0)
          React.useEffect(function()
            RunService.RenderStepped:Connect(function(dt) setCurrentTime(dt) end)
          end, {})
          return React.createElement(Child, { Value = currentTime })
        end
      `,
    },
    {
      name: "binding candidate surfaces measurement effects that only derive presentation state",
      files: {
        "Consumer.luau": dedent`
          local useObservedGuiMetric = require(script.Parent.useObservedGuiMetric)
          local function Consumer()
            local ref = React.useRef(nil)
            local measuredSize = useObservedGuiMetric(ref, "AbsoluteSize")
            local size, setSize = React.useState(UDim2.fromOffset(0, 0))
            React.useEffect(function()
              if measuredSize then
                setSize(UDim2.fromOffset(measuredSize.X, measuredSize.Y))
              end
            end, { measuredSize })
            return React.createElement("Frame", { ref = ref, Size = size })
          end
        `,
        "useObservedGuiMetric.luau": dedent`
          local function useObservedGuiMetric(targetRef, observedKey)
            local value, setValue = React.useState(nil)
            React.useEffect(function()
              local instance = targetRef.current
              instance:GetPropertyChangedSignal(observedKey):Connect(function() setValue(instance[observedKey]) end)
            end, { targetRef, observedKey })
            return value
          end
          return useObservedGuiMetric
        `,
      },
      config: {"rules":{"react-luau/prefer-binding-over-state-candidate":"suggestion"}},
    },
    {
      name: "binding candidate recognizes explicit state-to-binding API alternatives without upgrading semantic state to a warning",
      files: {
        "Consumer.luau": dedent`
          local VisualState = require(script.Parent.VisualState)
          local function Consumer()
            local transparency = VisualState:GetReactState(function(state) return state.transparency end)
            local enabled = VisualState:GetReactState(function(state) return state.enabled end)
            local mixed = VisualState:GetReactState(function(state) return state.mixed end)
            return React.createElement("Frame", {
              BackgroundTransparency = transparency,
              Rotation = mixed,
            }, {
              child = enabled and React.createElement("Frame") or nil,
              mixedChild = mixed > 0 and React.createElement("Frame") or nil,
            })
          end
        `,
        "VisualState.luau": dedent`
          local VisualState = {}
          function VisualState:GetReactState(selector)
            return nil
          end
          function VisualState:GetReactBinding(selector)
            return nil
          end
          return VisualState
        `,
      },
      config: {"rules":{"react-luau/prefer-binding-over-state-candidate":"suggestion"}},
    },
    {
      name: "binding candidate surfaces arbitrary external mirrors without calling them high-frequency",
      files: {
        "Consumer.luau": dedent`
          local useSignalBridge = require(script.Parent.useSignalBridge)
          local function Consumer(props)
            local position, setPosition = React.useState(UDim2.fromOffset(0, 0))
            useSignalBridge(props.changed, function(nextPosition) setPosition(nextPosition) end, { props.changed })
            return React.createElement("Frame", { Position = position })
          end
        `,
        "useSignalBridge.luau": dedent`
          local function useSignalBridge(event, handler, dependencies)
            React.useEffect(function()
              event:Connect(handler)
            end, dependencies)
          end
          return useSignalBridge
        `,
      },
      config: {"rules":{"react-luau/prefer-binding-over-state-candidate":"suggestion"}},
    },
    {
      name: "binding-over-state does not prove custom props binding-compatible through nested callbacks",
      files: {
        "Child.luau": dedent`
          local function Child(props)
            local base = React.useBinding(0)
            return React.createElement("Frame", { Size = props.Size }, {
              inner = React.createElement("Frame", {
                Position = base:map(function() return UDim2.fromOffset(props.Size.X.Offset, 0) end),
              }),
            })
          end
          return Child
        `,
        "Consumer.luau": dedent`
          local RunService = game:GetService("RunService")
          local Child = require(script.Parent.Child)
          local function Consumer()
            local size, setSize = React.useState(UDim2.fromOffset(0, 0))
            React.useEffect(function()
              RunService.RenderStepped:Connect(function(dt) setSize(UDim2.fromOffset(dt, 0)) end)
            end, {})
            return React.createElement(Child, { Size = size })
          end
          return Consumer
        `,
      },
      config: {"rules":{"react-luau/prefer-binding-over-state-candidate":"suggestion"}},
    },
    {
      name: "binding candidate rule ignores analyzed structural custom-component consumers",
      files: {
        "Consumer.luau": dedent`
          local useObservedValue = require(script.Parent.useObservedValue)
          local StructuralThing = require(script.Parent.StructuralThing)
          local function Consumer()
            local value = useObservedValue()
            return React.createElement(StructuralThing, { rotation = value })
          end
        `,
        "StructuralThing.luau": dedent`
          local function StructuralThing(props)
            return React.createElement("Frame", nil, { child = props.rotation > 0 and React.createElement("Frame") or nil })
          end
          return StructuralThing
        `,
        "useObservedValue.luau": dedent`
          local RunService = game:GetService("RunService")
          local function useObservedValue()
            local value, setValue = React.useState(0)
            React.useEffect(function()
              RunService.RenderStepped:Connect(setValue)
            end, {})
            return value
          end
          return useObservedValue
        `,
      },
      config: {"rules":{"react-luau/prefer-binding-over-state-candidate":"suggestion"}},
    },
    {
      name: "binding candidate keeps unresolved visual custom props optional",
      code: dedent`
        local RunService = game:GetService("RunService")
        local UnknownChild = require(script.Parent.UnknownChild)
        local function Consumer()
          local rotation, setRotation = React.useState(0)
          React.useEffect(function()
            RunService.RenderStepped:Connect(setRotation)
          end, {})
          return React.createElement(UnknownChild, { Rotation = rotation })
        end
      `,
      config: {"rules":{"react-luau/prefer-binding-over-state-candidate":"suggestion"}},
    },
    {
      name: "binding candidate ignores mixed consumers when an analyzed child prop still needs reconciliation",
      files: {
        "Consumer.luau": dedent`
          local MeasuredPanel = require(script.Parent.MeasuredPanel)
          local useProperty = require(script.Parent.useProperty)
          local function Consumer()
            local ref = React.useRef(nil)
            local measuredSize = useProperty(ref, "AbsoluteSize") or Vector2.zero
            local paddedWidth = measuredSize.X + 8
            return React.createElement(MeasuredPanel, { Width = paddedWidth })
          end
        `,
        "HostConsumer.luau": dedent`
          local MeasuredPanel = require(script.Parent.MeasuredPanel)
          local useProperty = require(script.Parent.useProperty)
          local function Consumer()
            local ref = React.useRef(nil)
            local measuredSize = useProperty(ref, "AbsoluteSize") or Vector2.zero
            local paddedWidth = measuredSize.X + 8
            return React.createElement("Frame", { Size = UDim2.fromOffset(paddedWidth, 24) }, {
              panel = React.createElement(MeasuredPanel, { Width = paddedWidth }),
            })
          end
          return Consumer
        `,
        "MeasuredPanel.luau": dedent`
          local function MeasuredPanel(props)
            local width, setWidth = React.useState(0)
            React.useEffect(function() setWidth(props.Width) end, { props.Width })
            return React.createElement("Frame", { Size = UDim2.fromOffset(props.Width, 24) }, {
              indicator = React.createElement("Frame", { Size = UDim2.fromOffset(width, 4) }),
              layout = React.createElement("UIListLayout", { Padding = UDim.new(0, props.Gap or 0) }),
            })
          end
          return React.memo(MeasuredPanel)
        `,
        "PropConsumer.luau": dedent`
          local MeasuredPanel = require(script.Parent.MeasuredPanel)
          local useProperty = require(script.Parent.useProperty)
          local function Consumer()
            local ref = React.useRef(nil)
            local measuredSize = useProperty(ref, "AbsoluteSize") or Vector2.zero
            local paddedWidth = measuredSize.X + 8
            return React.createElement(MeasuredPanel, { Width = paddedWidth, Gap = measuredSize.Y * 0.1 })
          end
          return Consumer
        `,
        "StructuralConsumer.luau": dedent`
          local useProperty = require(script.Parent.useProperty)
          local function Consumer()
            local ref = React.useRef(nil)
            local measuredSize = useProperty(ref, "AbsoluteSize") or Vector2.zero
            local paddedWidth = measuredSize.X + 8
            return React.createElement("Frame", { Size = UDim2.fromOffset(paddedWidth, 24) }, {
              wide = if measuredSize.X > 100 then React.createElement("Frame") else nil,
            })
          end
          return Consumer
        `,
        "useProperty.luau": dedent`
          local function useProperty(ref, propertyName, asBinding)
            local value, setValue
            if asBinding then
              value, setValue = React.useBinding(nil)
            else
              value, setValue = React.useState(nil)
            end
            React.useEffect(function()
              local instance = ref.current
              instance:GetPropertyChangedSignal(propertyName):Connect(function() setValue(instance[propertyName]) end)
            end, { ref, propertyName })
            return value
          end
          return useProperty
        `,
      },
      config: {"rules":{"react-luau/prefer-binding-over-state-candidate":"suggestion"}},
    },
    {
      name: "binding candidate rule ignores project-proven binding API siblings for structural-only consumers",
      files: {
        "Consumer.luau": dedent`
          local Store = require(script.Parent.Store)
          local function Consumer()
            local visible = Store:GetReactState(function(state) return state.visible end)
            return React.createElement("Frame", nil, { child = visible and React.createElement("Frame") or nil })
          end
        `,
        "Store.luau": dedent`
          local Store = {}
          function Store:GetReactState(selector) return nil end
          function Store:GetReactBinding(selector) return nil end
          return Store
        `,
      },
      config: {"rules":{"react-luau/prefer-binding-over-state-candidate":"suggestion"}},
    },
    {
      name: "binding candidate keeps opaque helpers out of strong high-frequency warnings",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function Component(props)
          local value, setValue = React.useState(0)
          React.useEffect(function()
            RunService.RenderStepped:Connect(function(dt) setValue(dt) end)
          end, {})
          local rotation = props.transform(value)
          return React.createElement("Frame", { Rotation = rotation })
        end
      `,
      config: {"rules":{"react-luau/prefer-binding-over-state-candidate":"suggestion"}},
    },
    {
      name: "binding candidate treats non-measurement instance properties as optional even when a Binding mode exists",
      files: {
        "Consumer.luau": dedent`
          local useObservedProperty = require(script.Parent.useObservedProperty)
          local function Consumer()
            local ref = React.useRef(nil)
            local health = useObservedProperty(ref, "Health")
            return React.createElement("TextLabel", { ref = ref, Text = tostring(health or 0) })
          end
        `,
        "useObservedProperty.luau": dedent`
          local function useObservedProperty(targetRef, property, preferBinding)
            local value, updateValue
            if preferBinding then
              value, updateValue = React.useBinding(nil)
            else
              value, updateValue = React.useState(nil)
            end
            React.useEffect(function()
              local instance = targetRef.current
              instance:GetPropertyChangedSignal(property):Connect(function() updateValue(instance[property]) end)
            end, { targetRef, property })
            return value
          end
          return useObservedProperty
        `,
      },
      config: {"rules":{"react-luau/prefer-binding-over-state-candidate":"suggestion"}},
    },
    {
      name: "binding candidate follows generic signal mirrors through imported hooks",
      files: {
        "Consumer.luau": dedent`
          local React = require(script.Parent.React)
          local useSignalValue = require(script.Parent.useSignalValue)
          local function Consumer(props)
            local rotation = useSignalValue(props.changed)
            return React.createElement("Frame", { Rotation = rotation })
          end
        `,
        "useSignalValue.luau": dedent`
          local React = require(script.Parent.React)
          local function useSignalValue(signal)
            local value, setValue = React.useState(0)
            React.useEffect(function()
              signal:Connect(setValue)
            end, { signal })
            return value
          end
          return useSignalValue
        `,
      },
      config: {"rules":{"react-luau/prefer-binding-over-state-candidate":"suggestion"}},
    },
    {
      name: "binding candidate keeps unknown instance-property mirrors optional",
      code: dedent`
        local function Component(props)
          local alpha, setAlpha = React.useState(0)
          React.useEffect(function()
            props.source:GetPropertyChangedSignal("VisualAlpha"):Connect(function()
              setAlpha(props.source.VisualAlpha)
            end)
          end, { props.source })
          return React.createElement("Frame", { BackgroundTransparency = alpha })
        end
      `,
      config: {"rules":{"react-luau/prefer-binding-over-state-candidate":"suggestion"}},
    },
    {
      name: "binding candidate recognizes derived observable payload mirrors",
      code: dedent`
        local function Component(props)
          local alpha, setAlpha = React.useState(0)
          React.useEffect(function()
            return props.observable:Subscribe(function(value) setAlpha(math.clamp(value * props.scale, 0, 1)) end)
          end, { props.observable, props.scale })
          return React.createElement("Frame", { BackgroundTransparency = alpha })
        end
      `,
      config: {"rules":{"react-luau/prefer-binding-over-state-candidate":"suggestion"}},
    },
    {
      name: "high-frequency state requires a real RunService source",
      code: dedent`
        local function Component(props)
          local value, setValue = React.useState(0)
          React.useEffect(function()
            return props.Heartbeat:Connect(function(nextValue) setValue(nextValue) end)
          end, { props.Heartbeat })
          return React.createElement("Frame", { Rotation = value })
        end
      `,
      config: {"rules":{"react-luau/prefer-binding-over-state-candidate":"suggestion"}},
    },
  ],
  invalid: [
    {
      name: "binding-over-state recognizes imported custom hooks that return externally updated state",
      files: {
        "Consumer.luau": dedent`
          local React = require(script.Parent.React)
          local useTrackedHostValue = require(script.Parent.BindingHookModule)
          local function Consumer()
            local value = useTrackedHostValue()
            return React.createElement("Frame", { Rotation = value })
          end
        `,
        "BindingHookModule.luau": dedent`
          local React = require(script.Parent.React)
          local RunService = game:GetService("RunService")
          local function useTrackedHostValue()
            local value, setValue = React.useState(0)
            React.useEffect(function()
              RunService.RenderStepped:Connect(function(dt) setValue(dt) end)
            end, {})
            return value
          end
          return useTrackedHostValue
        `,
      },
      errors: [
        { line: 4, column: 17, message: "useTrackedHostValue returns state updated from a high-frequency source, and value only feeds presentation updates that do not need React reconciliation.", file: "Consumer.luau" },
      ],
    },
    {
      name: "handles large-codebase React-Luau patterns without known false positives",
      code: dedent`
        local RunService = game:GetService("RunService")
        return function(props)
          local position, setPosition = React.useState(UDim2.fromScale(0, 0))
          React.useEffect(function()
            local connection
            connection = RunService.Heartbeat:Connect(function()
              setPosition(UDim2.fromOffset(1, 1))
              setPosition(UDim2.fromOffset(2, 2))
              local count = 10
              count += 1
            end)
          end, {})
          return React.createElement("Frame", { Position = position })
        end
      `,
      errors: [
        { line: 3, column: 33, message: "State position is updated from a high-frequency callback and only feeds presentation updates that do not need React reconciliation." },
      ],
    },
    {
      name: "binding-over-state infers dual-mode measurement hooks and skips calls already using binding mode (StateConsumer)",
      files: {
        "StateConsumer.luau": dedent`
          local useObservedMetric = require(script.Parent.useObservedMetric)
          local function StateConsumer()
            local ref = React.useRef(nil)
            local measuredSize = useObservedMetric(ref, "AbsoluteSize")
            return React.createElement("Frame", { ref = ref, Size = measuredSize or UDim2.fromOffset(0, 0) })
          end
        `,
        "useObservedMetric.luau": dedent`
          local function useObservedMetric(targetRef, observedKey, dependencies, preferBinding)
            local value, updateValue
            if preferBinding then
              value, updateValue = React.useBinding(nil)
            else
              value, updateValue = React.useState(nil)
            end
            React.useEffect(function()
              local instance = targetRef.current
              instance:GetPropertyChangedSignal(observedKey):Connect(function() updateValue(instance[observedKey]) end)
            end, { targetRef, observedKey, unpack(dependencies or {}) })
            return value
          end
          return useObservedMetric
        `,
      },
      errors: [
        { line: 4, column: 24, message: "useObservedMetric mirrors AbsoluteSize through React state even though every analyzed use is presentation-only, so the measurement rerenders this consumer without needing reconciliation.", file: "StateConsumer.luau" },
      ],
    },
    {
      name: "binding-over-state warns for proven high-frequency input presentation state",
      code: dedent`
        local UserInputService = game:GetService("UserInputService")
        local function Component()
          local position, setPosition = React.useState(Vector2.zero)
          React.useEffect(function()
            UserInputService.InputChanged:Connect(function(input) setPosition(input.Position) end)
          end, {})
          return React.createElement("Frame", { Position = UDim2.fromOffset(position.X, position.Y) })
        end
      `,
      errors: [
        { line: 3, column: 33 },
      ],
    },
    {
      name: "binding-over-state propagates mouse movement pressure through imported hooks",
      files: {
        "Component.luau": dedent`
          local React = require(script.Parent.React)
          local useMousePosition = require(script.Parent.useMousePosition)
          local function Component()
            local position = useMousePosition()
            return React.createElement("Frame", { Position = UDim2.fromOffset(position.X, position.Y) })
          end
        `,
        "useMousePosition.luau": dedent`
          local React = require(script.Parent.React)
          local Players = game:GetService("Players")
          local mouse = Players.LocalPlayer:GetMouse()
          local function useMousePosition()
            local position, setPosition = React.useState(Vector2.zero)
            React.useEffect(function()
              mouse.Move:Connect(function() setPosition(Vector2.new(mouse.X, mouse.Y)) end)
            end, {})
            return position
          end
          return useMousePosition
        `,
      },
      errors: [
        { line: 4, column: 20, message: "useMousePosition returns state updated from a high-frequency source, and position only feeds presentation updates that do not need React reconciliation.", file: "Component.luau" },
      ],
    },
    {
      name: "binding-over-state recognizes React.Change host feedback without requiring a frame-rate source",
      code: dedent`
        local function Component()
          local absoluteSize, setAbsoluteSize = React.useState(Vector2.zero)
          return React.createElement("Frame", {
            [React.Change.AbsoluteSize] = function(instance) setAbsoluteSize(instance.AbsoluteSize) end,
            Size = UDim2.fromOffset(math.max(absoluteSize.X - 8, 0), absoluteSize.Y),
          })
        end
      `,
      errors: [
        { line: 2, column: 41, message: "State absoluteSize mirrors AbsoluteSize and only feeds presentation updates, so React reconciliation is acting as an unnecessary host-property feedback step." },
      ],
    },
    {
      name: "binding-over-state treats motion-style onStep mirrors as strong presentation streams",
      code: dedent`
        local function Component(props)
          local scale, setScale = React.useState(1)
          React.useEffect(function() return props.motor:onStep(function(value) setScale(value) end) end, { props.motor })
          return React.createElement("Frame", { Size = UDim2.fromScale(scale, scale) })
        end
      `,
      errors: [
        { line: 2, column: 27, message: "State scale is updated from a high-frequency callback and only feeds presentation updates that do not need React reconciliation." },
      ],
    },
    {
      name: "binding-over-state recognizes continuously mutable instance-property mirrors",
      code: dedent`
        local function Component(props)
          local cameraCFrame, setCameraCFrame = React.useState(CFrame.new())
          React.useEffect(function()
            props.camera:GetPropertyChangedSignal("CFrame"):Connect(function()
              setCameraCFrame(props.camera.CFrame)
            end)
          end, { props.camera })
          return React.createElement("Frame", { Rotation = cameraCFrame.LookVector.X * 30 })
        end
      `,
      errors: [
        { line: 2, column: 41, message: "State cameraCFrame mirrors continuously mutable CFrame and only feeds presentation updates that do not need React reconciliation." },
      ],
    },
    {
      name: "host property consumes continuous state",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function BindingCandidate()
          local position, setPosition = React.useState(UDim2.fromScale(0, 0))
          React.useEffect(function()
            RunService.RenderStepped:Connect(function(dt) setPosition(UDim2.fromScale(dt, dt)) end)
          end, {})
          return React.createElement("Frame", { Position = position })
        end
      `,
      errors: [
        { line: 3, column: 33 },
      ],
    },
    {
      name: "hook result is only used for host properties",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function useTrackedSize()
          local size, setSize = React.useState(Vector2.zero)
          React.useEffect(function()
            RunService.RenderStepped:Connect(function(dt) setSize(Vector2.new(dt, dt)) end)
          end, {})
          return size
        end
        local function HookBindingCandidate()
          local size = useTrackedSize()
          return React.createElement("Frame", { Size = UDim2.fromOffset(size.X, size.Y) })
        end
      `,
      errors: [
        { line: 3, column: 25, message: "Hook state size is updated from a high-frequency source and is only consumed by presentation properties at analyzed call sites." },
      ],
    },
    {
      name: "binding-over-state follows proven bindable props through custom components",
      files: {
        "Consumer.luau": dedent`
          local useObservedValue = require(script.Parent.useObservedValue)
          local VisualFrame = require(script.Parent.VisualFrame)
          local function Consumer()
            local rotation = useObservedValue()
            return React.createElement(VisualFrame, { rotation = rotation })
          end
        `,
        "useObservedValue.luau": dedent`
          local RunService = game:GetService("RunService")
          local function useObservedValue()
            local value, setValue = React.useState(0)
            React.useEffect(function()
              RunService.RenderStepped:Connect(setValue)
            end, {})
            return value
          end
          return useObservedValue
        `,
        "VisualFrame.luau": dedent`
          local function VisualFrame(props)
            return React.createElement("Frame", { Rotation = props.rotation })
          end
          return VisualFrame
        `,
      },
      config: {"rules":{"react-luau/prefer-binding-over-state-candidate":"suggestion"}},
      errors: [
        { file: "Consumer.luau", line: 4, column: 20, message: "useObservedValue returns state updated from a high-frequency source, and rotation only feeds presentation updates that do not need React reconciliation.", severity: "warning" },
      ],
    },
  ],
});
