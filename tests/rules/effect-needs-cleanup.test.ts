import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/effect-needs-cleanup", {
  valid: [
    {
      name: "effect cleanup recognizes named cleanup functions and Maid-style ownership: local connection = RunService.Heartbeat:Connect(function()",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function CleanupPatterns(props)
          React.useEffect(function()
            local connection = RunService.Heartbeat:Connect(function() print(props.value) end)
            local function cleanup()
              connection:Disconnect()
            end
            return cleanup
          end, { props })
        end
      `,
    },
    {
      name: "effect cleanup recognizes named cleanup functions and Maid-style ownership: props.maid:GiveTask(RunService.Heartbeat:Connect(function()",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function CleanupPatterns(props)
          React.useEffect(function()
            props.maid:GiveTask(RunService.Heartbeat:Connect(function() print("managed") end))
          end, { props })
        end
      `,
    },
    {
      name: "effect cleanup recognizes named cleanup functions and Maid-style ownership: props.trove:Add(RunService.Heartbeat:Connect(function()",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function CleanupPatterns(props)
          React.useEffect(function()
            props.trove:Add(RunService.Heartbeat:Connect(function() print("managed by trove") end))
          end, { props })
        end
      `,
    },
    {
      name: "effect cleanup recognizes destroying a proven Instance as connection cleanup",
      code: dedent`
        local function InstanceDestroyCleanup()
          local numberValue = React.useMemo(function() return Instance.new("NumberValue") end, {})
          local transparencyValue = React.useMemo(function()
            local value = Instance.new("NumberValue")
            return value
          end, {})
          React.useEffect(function()
            local createdInsideEffect = Instance.new("BindableEvent")
            createdInsideEffect.Event:Connect(function() print("inside") end)
            numberValue.Changed:Connect(function(value) print(value) end)
            transparencyValue:GetPropertyChangedSignal("Value"):Connect(function() print(transparencyValue.Value) end)
            return function()
              createdInsideEffect:Destroy()
              numberValue:Destroy()
              transparencyValue:Destroy()
            end
          end, { numberValue, transparencyValue })
        end
      `,
    },
    {
      name: "effect cleanup tracks outliving tasks and paired Roblox binding APIs: task.spawn(function()",
      code: dedent`
        local function EffectLifetimeValid(props)
          React.useEffect(function() task.spawn(function() print("finishes immediately") end) end, {})
        end
      `,
    },
    {
      name: "effect cleanup tracks outliving tasks and paired Roblox binding APIs: local thread",
      code: dedent`
        local function EffectLifetimeValid(props)
          React.useEffect(function()
            local thread
            thread = task.spawn(function()
              task.wait(1)
              print("later")
            end)
            return function() pcall(task.cancel, thread) end
          end, {})
        end
      `,
    },
    {
      name: "effect cleanup tracks outliving tasks and paired Roblox binding APIs: local cancelled = false",
      code: dedent`
        local function EffectLifetimeValid(props)
          React.useEffect(function()
            local cancelled = false
            task.spawn(function()
              while not cancelled do
                task.wait()
              end
            end)
            return function() cancelled = true end
          end, {})
        end
      `,
    },
    {
      name: "effect cleanup tracks outliving tasks and paired Roblox binding APIs: local animationMaid = props.maid",
      code: dedent`
        local function EffectLifetimeValid(props)
          React.useEffect(function()
            local animationMaid = props.maid
            animationMaid:Add(task.spawn(function() task.wait(1) end))
          end, { props })
        end
      `,
    },
    {
      name: "effect cleanup tracks outliving tasks and paired Roblox binding APIs: local cancelled = false",
      code: dedent`
        local function EffectLifetimeValid(props)
          React.useEffect(function()
            local cancelled = false
            task.spawn(function()
              task.wait(1)
              if not cancelled then
                print("still mounted")
              end
            end)
            return function() cancelled = true end
          end, {})
        end
      `,
    },
    {
      name: "effect cleanup tracks outliving tasks and paired Roblox binding APIs: ContextActionService:BindActivate(Enum.UserInputType.Gamepad1, Enum.KeyCode.ButtonA)",
      code: dedent`
        local ContextActionService = game:GetService("ContextActionService")
        local function EffectLifetimeValid(props)
          React.useEffect(function()
            ContextActionService:BindActivate(Enum.UserInputType.Gamepad1, Enum.KeyCode.ButtonA)
            return function()
              ContextActionService:UnbindActivate(Enum.UserInputType.Gamepad1, Enum.KeyCode.ButtonA)
            end
          end, {})
        end
      `,
    },
    {
      name: "effect cleanup tracks outliving tasks and paired Roblox binding APIs: local connection = RunService:BindToSimulation(function()",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function EffectLifetimeValid(props)
          React.useEffect(function()
            local connection = RunService:BindToSimulation(function() print("simulation") end)
            return function() connection:Disconnect() end
          end, {})
        end
      `,
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
            return function() connection:Disconnect() end
          end, {})
        end
      `,
    },
    {
      name: "effect cleanup follows connections stored in ref fields and collections (useConnections)",
      code: dedent`
        local function useConnections(instance, names)
          local listener = React.useRef(nil)
          local named = React.useRef({})
          React.useEffect(function()
            local connections = {}
            table.insert(connections, instance.Changed:Connect(print))
            listener.current = instance.Destroying:Connect(print)
            for _, name in names do
              named.current[name] = instance:GetPropertyChangedSignal(name):Connect(print)
            end
            return function()
              for _, connection in connections do
                connection:Disconnect()
              end
              listener.current:Disconnect()
              for _, connection in pairs(named.current) do
                connection:Disconnect()
              end
            end
          end, { instance, names })
        end
      `,
    },
    {
      name: "effect cleanup accepts destroying an ancestor of a connected Instance (useAncestor)",
      code: dedent`
        local function useLength(setLength)
          React.useEffect(function()
            local container = Instance.new("Folder")
            local sound = Instance.new("Sound")
            sound.Parent = container
            sound:GetPropertyChangedSignal("TimeLength"):Connect(function() setLength(sound.TimeLength) end)
            return function() container:Destroy() end
          end, {})
        end
      `,
    },
    {
      name: "effect cleanup accepts tasks that check a flag the cleanup changes (useCancelled)",
      code: dedent`
        local function useLoaded(id)
          local loaded, setLoaded = React.useState(false)
          React.useEffect(function()
            local cancelled = false
            task.spawn(function()
              task.wait(1)
              if cancelled then return end
              setLoaded(true)
            end)
            return function() cancelled = true end
          end, { id })
          return loaded
        end
      `,
    },
    {
      name: "effect cleanup accepts tasks that check a flag the cleanup changes (useMounted)",
      code: dedent`
        local function useLoaded(id)
          local loaded, setLoaded = React.useState(false)
          React.useEffect(function()
            local isMounted = true
            task.spawn(function()
              task.wait(1)
              if isMounted and id then setLoaded(true) end
            end)
            return function() isMounted = false end
          end, { id })
          return loaded
        end
      `,
    },
    {
      name: "binding animation owns its connection cleanup",
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
      name: "connection outlives its effect",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function Component(props)
          React.useEffect(function()
            local connection = RunService.Heartbeat:Connect(function() print(props.title) end)
          end, { props.title })
        end
      `,
      errors: [
        { line: 4, column: 24, endLine: 4, endColumn: 52, message: "Effect creates connection/subscription without matching returned cleanup.", highlights: [{"line":4,"column":24,"endLine":4,"endColumn":52}] },
      ],
    },
    {
      name: "arbitrary Destroy method does not prove connection ownership",
      code: dedent`
        local function UnprovenDestroy(props)
          React.useEffect(function()
            props.customSignal.Changed:Connect(function() print("custom") end)
            return function() props.customSignal:Destroy() end
          end, { props })
        end
      `,
      errors: [
        { line: 3, column: 5 },
      ],
    },
    {
      name: "arbitrary Add method does not prove cleanup ownership",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function CleanupManagerInvalid(props)
          React.useEffect(function()
            props.list:Add(RunService.Heartbeat:Connect(function() print("not a cleanup manager") end))
          end, { props })
        end
      `,
      errors: [
        { line: 4, column: 20 },
      ],
    },
    {
      name: "effect cleanup downgrades low-risk one-shot scheduled work but keeps outliving tasks as warnings: task.spawn(function()",
      code: dedent`
        local function EffectLifetimeInvalid()
          React.useEffect(function()
            task.spawn(function()
              task.wait(1)
              print("outlives effect")
            end)
          end, {})
        end
      `,
      errors: [
        { line: 3, column: 5, message: "Effect creates yielding spawned task without matching returned cleanup.", severity: "warning", help: "The task can outlive the effect because it yields at task.wait. Cancel the task in returned cleanup if it must stop with the effect." },
      ],
    },
    {
      name: "effect cleanup downgrades low-risk one-shot scheduled work but keeps outliving tasks as warnings: task.defer(function()",
      code: dedent`
        local function EffectLifetimeInvalid()
          React.useEffect(function() task.defer(function() print("deferred") end) end, {})
        end
      `,
      errors: [
        { line: 2, column: 30, message: "Effect creates deferred task without matching returned cleanup.", severity: "suggestion", help: "The task is scheduled to run after the effect callback can finish. Cancel the task in returned cleanup if it must stop with the effect." },
      ],
    },
    {
      name: "effect cleanup downgrades low-risk one-shot scheduled work but keeps outliving tasks as warnings: task.delay(1, function()",
      code: dedent`
        local function EffectLifetimeInvalid()
          React.useEffect(function() task.delay(1, function() print("delayed") end) end, {})
        end
      `,
      errors: [
        { line: 2, column: 30, message: "Effect creates delayed task without matching returned cleanup.", severity: "warning", help: "The task is scheduled to run after the effect callback can finish. Cancel the task in returned cleanup if it must stop with the effect." },
      ],
    },
    {
      name: "effect cleanup downgrades low-risk one-shot scheduled work but keeps outliving tasks as warnings: ContextActionService:BindActivate(Enum.UserInputType.Gamepad1, Enum.KeyCode.ButtonA)",
      code: dedent`
        local ContextActionService = game:GetService("ContextActionService")
        local function EffectLifetimeInvalid()
          React.useEffect(function()
            ContextActionService:BindActivate(Enum.UserInputType.Gamepad1, Enum.KeyCode.ButtonA)
          end, {})
        end
      `,
      errors: [
        { line: 4, column: 5, message: "Effect creates ContextAction activation binding without matching returned cleanup.", severity: "warning", help: "Call UnbindActivate with the same input type in cleanup." },
      ],
    },
    {
      name: "effect cleanup downgrades low-risk one-shot scheduled work but keeps outliving tasks as warnings: RunService:BindToSimulation(function()",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function EffectLifetimeInvalid()
          React.useEffect(function() RunService:BindToSimulation(function() print("simulation") end) end, {})
        end
      `,
      errors: [
        { line: 3, column: 30, message: "Effect creates BindToSimulation connection without matching returned cleanup.", severity: "warning", help: "Disconnect the returned connection in cleanup." },
      ],
    },
    {
      name: "effect cleanup follows connections stored in ref fields and collections (useLeak)",
      code: dedent`
        local function useLeak(instance)
          local listener = React.useRef(nil)
          React.useEffect(function()
            listener.current = instance.Changed:Connect(print)
            return function() listener:Disconnect() end
          end, { instance })
        end
      `,
      errors: [
        { line: 4, column: 24 },
      ],
    },
    {
      name: "effect cleanup accepts destroying an ancestor of a connected Instance (useUnrelated)",
      code: dedent`
        local function useLength(setLength)
          React.useEffect(function()
            local container = Instance.new("Folder")
            local sound = Instance.new("Sound")
            sound.Parent = container
            sound:GetPropertyChangedSignal("TimeLength"):Connect(function() setLength(sound.TimeLength) end)
            return function() Instance.new("Folder"):Destroy() end
          end, {})
        end
      `,
      errors: [
        { line: 6, column: 5 },
      ],
    },
    {
      name: "effect cleanup accepts tasks that check a flag the cleanup changes (useIgnored)",
      code: dedent`
        local function useLoaded(id)
          local loaded, setLoaded = React.useState(false)
          React.useEffect(function()
            local done = false
            task.spawn(function()
              task.wait(1)
              done = true
              setLoaded(true)
            end)
            return function() done = true end
          end, { id })
          return loaded
        end
      `,
      errors: [
        { line: 5, column: 5 },
      ],
    },
    {
      name: "effects that return a resource instead of a cleanup function are errors",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function Direct()
          React.useEffect(function() return RunService.Heartbeat:Connect(function() end) end, {})
          return nil
        end
        local function Named()
          React.useEffect(function()
            local connection = RunService.Heartbeat:Connect(function() end)
            return connection
          end, {})
          return nil
        end
        return { Direct = Direct, Named = Named }
      `,
      errors: [
        { line: 3, column: 37, message: "Effect returns a connection/subscription instead of a cleanup function", severity: "error", fixPreview: {"kind":"pattern","before":"return signal:Connect(onChanged)","after":"local connection = signal:Connect(onChanged)\n\nreturn function()\n\tconnection:Disconnect()\nend","note":"React calls the returned value when the effect cleans up, so it has to be a function"} },
        { line: 8, column: 24, severity: "error", fixPreview: {"kind":"pattern","before":"return signal:Connect(onChanged)","after":"local connection = signal:Connect(onChanged)\n\nreturn function()\n\tconnection:Disconnect()\nend","note":"React calls the returned value when the effect cleans up, so it has to be a function"} },
      ],
    },
  ],
});
