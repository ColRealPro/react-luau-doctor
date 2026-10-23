import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/prefer-binding-over-state-candidate", {
  valid: [
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
  ],
  invalid: [
    {
      name: "binding candidate rule surfaces mixed visual and structural state but ignores structural-only state",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function Consumer()
          local position, setPosition = React.useState(UDim2.fromOffset(0, 0))
          local selected, setSelected = React.useState(false)
          React.useEffect(function()
            RunService.RenderStepped:Connect(function(dt)
              setPosition(UDim2.fromOffset(dt, 0))
              setSelected(dt > 0)
            end)
          end, {})
          return React.createElement("Frame", { Position = position }, {
            mixedChild = position.X.Offset > 0 and React.createElement("Frame") or nil,
            selectedChild = selected and React.createElement("Frame") or nil,
          })
        end
      `,
      config: {"rules":{"react-luau/prefer-binding-over-state-candidate":"suggestion"}},
      errors: [
        { line: 3, column: 33, message: "State position has presentation-oriented consumers, but other uses still appear to need React reconciliation.", severity: "suggestion" },
      ],
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
      errors: [
        { file: "Consumer.luau", line: 4, column: 24, message: "useObservedGuiMetric mirrors AbsoluteSize through React state, and the dependent React effect only derives presentation state or Bindings from measuredSize.", severity: "suggestion" },
      ],
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
      errors: [
        { file: "Consumer.luau", line: 3, column: 24, message: "VisualState:GetReactState subscribes transparency through React state for transparency, while GetReactBinding is also available and every analyzed consumer is presentation-only.", severity: "suggestion" },
      ],
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
      errors: [
        { file: "Consumer.luau", line: 3, column: 33, message: "State position mirrors an external reactive value and only feeds presentation updates, but Doctor cannot prove the source changes frequently enough for Binding to be clearly preferable.", severity: "suggestion" },
      ],
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
      errors: [
        { file: "Component.luau", line: 4, column: 33, message: "State rotation has presentation-oriented consumers, but other uses still appear to need React reconciliation.", severity: "suggestion" },
      ],
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
      errors: [
        { file: "StructuralConsumer.luau", line: 4, column: 24, message: "useProperty updates measuredSize through React state and some consumers are presentation-only, but other consumers may still require React reconciliation.", severity: "suggestion" },
      ],
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
      errors: [
        { file: "Component.luau", line: 3, column: 27, message: "State value has presentation-oriented consumers, but other uses still appear to need React reconciliation.", severity: "suggestion" },
      ],
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
      errors: [
        { file: "Consumer.luau", line: 4, column: 18, message: "useObservedProperty has a Binding-returning mode and health is only used for presentation, but Doctor cannot prove the updates are frequent enough to make the Binding version clearly preferable.", severity: "suggestion" },
      ],
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
      errors: [
        { file: "Consumer.luau", line: 4, column: 20, message: "useSignalValue mirrors an external reactive value through React state, and rotation is only used for presentation.", severity: "suggestion" },
      ],
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
      errors: [
        { file: "Component.luau", line: 2, column: 27, message: "State alpha mirrors an external reactive value and only feeds presentation updates, but Doctor cannot prove the source changes frequently enough for Binding to be clearly preferable.", severity: "suggestion" },
      ],
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
      errors: [
        { file: "Component.luau", line: 2, column: 27, severity: "suggestion" },
      ],
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
      errors: [
        { file: "Component.luau", line: 2, column: 27, message: "State value mirrors an external reactive value and only feeds presentation updates, but Doctor cannot prove the source changes frequently enough for Binding to be clearly preferable.", severity: "suggestion" },
      ],
    },
  ],
});
