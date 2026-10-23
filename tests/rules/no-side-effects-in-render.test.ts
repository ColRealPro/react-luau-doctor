import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-side-effects-in-render", {
  valid: [
    {
      name: "handles large-codebase React-Luau patterns without known false positives",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function BuildObject()
          local folder = Instance.new("Folder")
          task.spawn(function() folder.Name = "Built" end)
          return folder
        end
        local function Component()
          local position, setPosition = React.useState(UDim2.fromScale(0, 0))
          React.useEffect(function()
            local folder = BuildObject()
            local connection = RunService.Heartbeat:Connect(function()
              setPosition(UDim2.fromOffset(1, 1))
              setPosition(UDim2.fromOffset(2, 2))
              local count = 10
              count += 1
            end)
            return function()
              folder:Destroy()
              connection:Disconnect()
            end
          end, {})
        end
      `,
    },
    {
      name: "source effect inference keeps fresh receiver and argument mutation local to render",
      files: {
        "Component.luau": dedent`
          local Mutator = require(script.Parent.Mutator)
          local function Component(props)
            local localValue = {}
            Mutator.mutateArgument(localValue)
            local instance = Mutator.make()
            instance:flushAll()
            return React.createElement("Frame", { Name = tostring(props.value) })
          end
        `,
        "Mutator.luau": dedent`
          local Mutator = {}
          function Mutator.make()
            return setmetatable({ items = { "value" } }, Mutator)
          end
          function Mutator:flushAll()
            self.items[1] = nil
          end
          function Mutator.mutateArgument(value)
            value.changed = true
          end
          return Mutator
        `,
      },
    },
    {
      name: "source effect inference does not confuse function-local imports or shadowed aliases",
      files: {
        "Component.luau": dedent`
          local React = require(script.Parent.React)
          local performWork = require(script.Parent.Wrapper)
          local function Component()
            performWork()
            return React.createElement("Frame")
          end
        `,
        "Wrapper.luau": dedent`
          local run = require(script.Parent.Impure)
          local function performWork()
            local run = require(script.Parent.Safe)
            run()
          end
          return performWork
        `,
        "Impure.luau": dedent`
          local stored = {}
          local function mutate()
            stored.changed = true
          end
          return mutate
        `,
        "Safe.luau": dedent`
          local function run()
            return 1
          end
          return run
        `,
      },
    },
    {
      name: "unknown opaque methods are not assumed to be render side effects",
      code: dedent`
        local function Component(props)
          props.service:DoSomething()
          return React.createElement("Frame")
        end
      `,
    },
    {
      name: "render side-effect source bindings respect lexical shadowing and sibling scopes",
      files: {
        "Component.luau": dedent`
          local Cleaner = require(script.Parent.Cleaner)
          local function useScale()
            return React.useBinding(1)
          end
          local function First()
            local scale = Cleaner.make()
            return React.createElement("Frame")
          end
          local function Second()
            local scale = useScale()
            scale:flushAll()
            return React.createElement("Frame")
          end
          local function Third()
            local Cleaner = { flushAll = function() return 1 end }
            Cleaner.flushAll()
            return React.createElement("Frame")
          end
          local function Reassigned()
            local scale = Cleaner.make()
            scale = useScale()
            scale:flushAll()
            return React.createElement("Frame")
          end
        `,
        "Cleaner.luau": dedent`
          local Cleaner = {}
          local function clearStoredItems(self)
            local items = self._items
            items[1] = nil
          end
          function Cleaner.make(): Cleaner
            return setmetatable({ _items = { "value" } }, Cleaner)
          end
          function Cleaner:flushAll()
            clearStoredItems(self)
          end
          return Cleaner
        `,
      },
    },
    {
      name: "opaque render methods are not treated as side effects by name alone",
      code: dedent`
        local function Component(props)
          local text = props.formatter:render(props.value)
          return React.createElement("TextLabel", { Text = text })
        end
      `,
    },
    {
      name: "source effect inference treats locally constructed tables as owned values",
      files: {
        "Component.luau": dedent`
          local Factory = require(script.Parent.Factory)
          local function Component()
            local value = Factory.new()
            return React.createElement("Frame", { Name = tostring(value.value) })
          end
        `,
        "Factory.luau": dedent`
          local Factory = {}
          function Factory.new()
            local self = setmetatable({}, Factory)
            self.value = 1
            return self
          end
          return Factory
        `,
      },
    },
    {
      name: "source effect inference does not escalate useRef latest-value mirrors at hook call sites",
      files: {
        "Component.luau": dedent`
          local useLatest = require(script.Parent.useLatest)
          local function Component(props)
            local latest = useLatest(props.value)
            return React.createElement("Frame", { Name = tostring(latest) })
          end
        `,
        "useLatest.luau": dedent`
          local function useLatest(value)
            local ref = React.useRef(value)
            ref.current = value
            return ref
          end
          return useLatest
        `,
      },
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
    },
  ],
  invalid: [
    {
      name: "render connects a frame callback",
      code: dedent`
        local RunService = game:GetService("RunService")
        local function Component(props)
          RunService.RenderStepped:Connect(function() print(props.title) end)
          return React.createElement("Frame")
        end
      `,
      errors: [
        { line: 3, column: 3, message: "RunService.RenderStepped:Connect performs a side effect directly during component render." },
      ],
    },
    {
      name: "render creates an Instance",
      code: dedent`
        local function Component(props)
          Instance.new("Frame")
          return React.createElement("Frame")
        end
      `,
      errors: [
        { line: 2, column: 3, message: "Instance.new performs a side effect directly during component render." },
      ],
    },
    {
      name: "render creates a tween",
      code: dedent`
        local TweenService = game:GetService("TweenService")
        local function Component(props)
          local tween = TweenService:Create(workspace, TweenInfo.new(1), {})
          return React.createElement("Frame")
        end
      `,
      errors: [
        { line: 3, column: 17, message: "TweenService:Create performs a side effect directly during component render." },
      ],
    },
    {
      name: "render plays an existing tween",
      code: dedent`
        local TweenService = game:GetService("TweenService")
        local tween = TweenService:Create(workspace, TweenInfo.new(1), {})
        local function Component(props)
          tween:Play()
          return React.createElement("Frame")
        end
      `,
      errors: [
        { line: 4, column: 3, message: "tween:Play performs a side effect directly during component render." },
      ],
    },
    {
      name: "source effect inference flags mutation of persistent factory instances",
      files: {
        "Component.luau": dedent`
          local Mutator = require(script.Parent.Mutator)
          local function Component()
            local instance = React.useMemo(function() return Mutator.make() end, {})
            instance:flushAll()
            return React.createElement("Frame")
          end
        `,
        "Mutator.luau": dedent`
          local Mutator = {}
          local function clearStoredItems(value)
            value.items[1] = nil
          end
          function Mutator.make()
            return setmetatable({ items = { "value" } }, Mutator)
          end
          function Mutator:flushAll()
            clearStoredItems(self)
          end
          return Mutator
        `,
      },
      errors: [
        { line: 4, column: 3, message: "instance:flushAll runs during render, and code it calls eventually changes state outside the current render.", file: "Component.luau" },
      ],
    },
    {
      name: "source effect inference propagates through imported source-visible functions",
      files: {
        "Component.luau": dedent`
          local React = require(script.Parent.React)
          local performWork = require(script.Parent.Wrapper)
          local function Component()
            performWork()
            return React.createElement("Frame")
          end
        `,
        "Wrapper.luau": dedent`
          local mutateStored = require(script.Parent.Mutator)
          local function performWork()
            mutateStored()
          end
          return performWork
        `,
        "Mutator.luau": dedent`
          local stored = {}
          local function mutateStored()
            stored.changed = true
          end
          return mutateStored
        `,
      },
      errors: [
        { line: 4, column: 3, message: "performWork runs during render, and code it calls eventually changes state outside the current render.", file: "Component.luau" },
      ],
    },
    {
      name: "source-visible custom hooks are only flagged when they directly perform render-time effects",
      files: {
        "Component.luau": dedent`
          local useSafeValue = require(script.Parent.useSafeValue)
          local useImpureValue = require(script.Parent.useImpureValue)
          local function Component()
            useSafeValue()
            useImpureValue()
            return React.createElement("Frame")
          end
        `,
        "useImpureValue.luau": dedent`
          local shared = {}
          local function useImpureValue()
            shared.renderCount = (shared.renderCount or 0) + 1
            return shared.renderCount
          end
          return useImpureValue
        `,
        "useSafeValue.luau": dedent`
          local function useSafeValue()
            local value, setValue = React.useState(0)
            React.useEffect(function() setValue(1) end, {})
            return value
          end
          return useSafeValue
        `,
      },
      errors: [
        { line: 5, column: 3, message: "useImpureValue runs during render, and code it calls eventually changes state outside the current render.", file: "Component.luau" },
      ],
    },
    {
      name: "render side effect rules check useMemo callbacks as render code",
      code: dedent`
        local function Component(props)
          local folder = React.useMemo(function() return Instance.new("Folder") end, {})
          local label = React.useMemo(function() return string.upper(props.text) end, { props.text })
          local create = React.useCallback(function() return Instance.new("Folder") end, {})
          React.useEffect(function() return function() folder:Destroy() end end, { folder })
          return React.createElement("TextButton", { Text = label, [React.Event.Activated] = create })
        end
      `,
      errors: [
        { line: 2, column: 50, message: "Instance.new performs a side effect inside a useMemo callback, which runs during render" },
      ],
    },
    {
      name: "source effects ignore writes that only fill an empty cache slot",
      files: {
        "Component.luau": dedent`
          local Lookup = require(script.Parent.Lookup)
          local function Component(props)
            local entry = Lookup.get(props.key)
            local shared = Lookup.shared()
            local count = Lookup.count()
            return React.createElement("TextLabel", { Text = entry.key .. tostring(shared) .. count })
          end
        `,
        "Lookup.luau": dedent`
          local cache = {}
          local shared = nil
          local count = 0
          local Lookup = {}
          function Lookup.get(key)
            local cached = cache[key]
            if cached then
              return cached
            end
            cached = { key = key }
            cache[key] = cached
            return cached
          end
          function Lookup.shared()
            if shared == nil then
              shared = {}
            end
            return shared
          end
          function Lookup.count()
            count += 1
            return count
          end
          return Lookup
        `,
      },
      errors: [
        { line: 5, column: 17, message: "Lookup.count runs during render, and code it calls eventually changes state outside the current render.", file: "Component.luau" },
      ],
    },
    {
      name: "source effects ignore private tables only filled by memoizing lookups",
      files: {
        "Component.luau": dedent`
          local Registry = require(script.Parent.Registry)
          local function Component(props)
            local label = React.useMemo(function()
              local entry = Registry.getByGroup(props.group, props.key)
              local recent = Registry.recentFor(props.group)
              Registry.markSeen(props.key)
              return tostring(entry) .. tostring(recent)
            end, { props.group, props.key })
            return React.createElement("TextLabel", { Text = label })
          end
        `,
        "Registry.luau": dedent`
          local byKey = setmetatable({}, { __mode = "k" })
          local keyByEntry = setmetatable({}, { __mode = "k" })
          local byGroup = {}
          local recent = {}
          local seen = {}
          local log = {}
          local Registry = {}
          function Registry.fromKey(key)
            if byKey[key] then
              return byKey[key]
            end
            local entry = { key = key }
            byKey[key] = entry
            keyByEntry[entry] = key
            if key.Group ~= nil then
              byGroup[key.Group] = byGroup[key.Group] or {}
              table.insert(byGroup[key.Group], entry)
            end
            return entry
          end
          function Registry.getByGroup(group, key)
            local list = byGroup[group]
            if not list then
              return Registry.fromKey(key)
            end
            for index = #list, 1, -1 do
              if not keyByEntry[list[index]].Parent then
                table.remove(list, index)
              end
            end
            if #list == 0 then
              byGroup[group] = nil
              return Registry.fromKey(key)
            end
            return list[1]
          end
          function Registry.track(group, entry)
            recent[group] = recent[group] or {}
            table.insert(recent[group], entry)
          end
          function Registry.recentFor(group)
            local list = recent[group]
            if list and #list > 10 then
              table.remove(list, 1)
            end
            return list
          end
          function Registry.markSeen(key)
            if seen[key] then
              return
            end
            seen[key] = true
            table.insert(log, key)
          end
          return Registry
        `,
      },
      errors: [
        { line: 5, column: 20, message: "Registry.recentFor runs during render, and code it calls eventually changes state outside the current render.", file: "Component.luau" },
        { line: 6, column: 5, message: "Registry.markSeen runs during render, and code it calls eventually changes state outside the current render.", file: "Component.luau" },
      ],
    },
    {
      name: "source effects ignore fresh engine values and lazy defaults but not parenting or world writes",
      files: {
        "Component.luau": dedent`
          local Lib = require(script.Parent.Lib)
          local function Component(props)
            Lib.sortedPlayers()
            Lib.decode(props.json)
            Lib.withParent(props.parent)
            Lib.getShared()
            Lib.lookup(props.key)
            Lib.makeLabel(props.text)
            Lib.mountLabel(props.text, props.parent)
            Lib.create("Frame", { Parent = props.parent })
            Lib.renameTarget()
            return React.createElement("Frame")
          end
        `,
        "Lib.luau": dedent`
          local Players = game:GetService("Players")
          local HttpService = game:GetService("HttpService")
          local Lib = {}
          local shared = nil
          local byKey = {}
          function Lib.sortedPlayers()
            local players = Players:GetPlayers()
            table.sort(players, function(a, b) return a.Name < b.Name end)
            return players
          end
          function Lib.decode(text)
            local data = HttpService:JSONDecode(text)
            data.decoded = true
            return data
          end
          function Lib.withParent(parent)
            local list = parent:GetChildren()
            table.insert(list, parent)
            return list
          end
          function Lib.getShared()
            shared = shared or {}
            return shared
          end
          function Lib.lookup(key)
            byKey[key] = byKey[key] or { key = key }
            return byKey[key]
          end
          function Lib.makeLabel(text)
            local label = Instance.new("TextLabel")
            label.Text = text
            return label
          end
          function Lib.mountLabel(text, parent)
            local label = Instance.new("TextLabel")
            label.Text = text
            label.Parent = parent
            return label
          end
          function Lib.create(className, properties)
            local object = Instance.new(className)
            for key, value in properties do
              object[key] = value
            end
            return object
          end
          local function renameWorld()
            local target = workspace:FindFirstChild("Target")
            target.Name = "Renamed"
          end
          function Lib.renameTarget()
            renameWorld()
          end
          return Lib
        `,
      },
      errors: [
        { file: "Component.luau", line: 9, column: 3, message: "Lib.mountLabel runs during render, and code it calls eventually changes state outside the current render.", severity: "error", explanation: "Doctor followed the code behind this call. Lib.mountLabel changes state outside the render at Lib.luau:37 (`label.Parent = parent`). If React abandons this render, that change still happens" },
        { file: "Component.luau", line: 10, column: 3, message: "Lib.create runs during render, and code it calls eventually changes state outside the current render.", severity: "error", explanation: "Doctor followed the code behind this call. Lib.create changes state outside the render at Lib.luau:43 (`object[key] = value`). If React abandons this render, that change still happens" },
        { file: "Component.luau", line: 11, column: 3, message: "Lib.renameTarget runs during render, and code it calls eventually changes state outside the current render.", severity: "error", explanation: "Doctor followed the code behind this call. Lib.renameTarget calls renameWorld at Lib.luau:52, then renameWorld changes state outside the render at Lib.luau:49 (`target.Name = \"Renamed\"`). If React abandons this render, that change still happens" },
      ],
    },
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
      errors: [
        { file: "Component.luau", line: 7, column: 58, message: "bump runs during render, and code it calls eventually changes state outside the current render.", severity: "error" },
      ],
    },
  ],
});
