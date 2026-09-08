import type { FixPreview } from "./types";

const examples: Record<string, FixPreview> = {
  "react-luau/parse-error": {
    before: `return React.createElement("Frame", {
\tVisible = true,
)`,
    after: `return React.createElement("Frame", {
\tVisible = true,
})`,
    note: "Close the props table before closing the call. Parse errors can also come from unsupported syntax; inspect the reported location before applying a repair.",
  },
  "react-luau/rules-of-hooks": {
    before: `if enabled then
\tlocal value = React.useMemo(function()
\t\treturn computeValue()
\tend, {})
end`,
    after: `local value = React.useMemo(function()
\treturn computeValue()
end, {})

if enabled then
\t-- use value here
end`,
    note: "Keep hook calls at the top level, then branch on their results.",
  },
  "react-luau/exhaustive-deps": {
    before: `React.useEffect(function()
\tprint(value)
end, {})`,
    after: `React.useEffect(function()
\tprint(value)
end, { value })`,
    note: "Make the dependency table match the reactive values captured by the hook callback.",
  },
  "react-luau/effect-needs-cleanup": {
    before: `React.useEffect(function()
\tlocal connection = signal:Connect(onChanged)
end, { signal, onChanged })`,
    after: `React.useEffect(function()
\tlocal connection = signal:Connect(onChanged)
\treturn function()
\t\tconnection:Disconnect()
\tend
end, { signal, onChanged })`,
    note: "Return cleanup from the same effect that creates the owned resource.",
  },
  "react-luau/no-derived-state-effect": {
    before: `local value, setValue = React.useState(0)

React.useEffect(function()
\tsetValue(input * scale)
end, { input, scale })`,
    after: `local value = input * scale`,
    note: "Compute render-known derived values during render instead of synchronizing another state cell.",
  },
  "react-luau/no-self-updating-effect": {
    before: `React.useEffect(function()
\tsetCount(count + 1)
end, { count })`,
    after: `local function increment()
\tsetCount(function(previous)
\t\treturn previous + 1
\tend)
end`,
    note: "Move the update to the event that owns it, or add a real convergence guard when an effect is required.",
  },
  "react-luau/no-effect-with-fresh-deps": {
    before: `local options = { enabled = enabled }

React.useEffect(function()
\tapplyOptions(options)
end, { options })`,
    after: `React.useEffect(function()
\tlocal options = { enabled = enabled }
\tapplyOptions(options)
end, { enabled })`,
    note: "Depend on stable reactive inputs rather than an object or function recreated every render.",
  },
  "react-luau/no-mutable-in-deps": {
    before: `React.useEffect(function()
\tuseValue(ref.current)
end, { ref.current })`,
    after: `React.useEffect(function()
\tuseValue(ref.current)
end, {})`,
    note: "This effect reads the ref after mount only. A ref mutation cannot schedule another effect; use state or a subscription if changes must trigger work. Keep other reactive dependencies in the table.",
  },
  "react-luau/prefer-binding-over-state": {
    before: `local value, setValue = React.useState(0)`,
    after: `local value, setValue = React.useBinding(0)`,
    note: "Use a Binding when updates only need to flow into Binding-aware visual consumers.",
  },
  "react-luau/prefer-binding-over-state-candidate": {
    before: `local value, setValue = React.useState(0)
signal:Connect(setValue)
-- value is used for presentation`,
    after: `local value, setValue = React.useBinding(0)
signal:Connect(setValue)
-- keep separate React state too if structure depends on it`,
    note: "Use a Binding when this is really an external presentation stream. Keep or split React state when the event represents semantic UI state or needs reconciliation.",
  },
  "react-luau/rerender-unstable-memo-props": {
    before: `return React.createElement(MemoizedButton, {
\tonClick = function()
\t\tdoSomething()
\tend,
})`,
    after: `local onClick = React.useCallback(function()
\tdoSomething()
end, {})

return React.createElement(MemoizedButton, {
\tonClick = onClick,
})`,
    note: "Stabilize identity only when the memoized child is worth skipping. Moving construction into the child or removing ineffective memoization can also be better.",
  },
  "react-luau/rerender-high-frequency-state": {
    before: `local transparency, setTransparency = React.useState(0)
React.useEffect(function()
\tlocal connection = RunService.RenderStepped:Connect(function()
\t\tsetTransparency(readTransparency())
\tend)
\treturn function() connection:Disconnect() end
end, { readTransparency })
return React.createElement("Frame", {
\tBackgroundTransparency = transparency,
})`,
    after: `local transparency, setTransparency = React.useBinding(0)
React.useEffect(function()
\tlocal connection = RunService.RenderStepped:Connect(function()
\t\tsetTransparency(readTransparency())
\tend)
\treturn function() connection:Disconnect() end
end, { readTransparency })
return React.createElement("Frame", {
\tBackgroundTransparency = transparency,
})`,
    note: "A Binding updates this host property without scheduling component renders. Keep state for values that control child structure, and keep the subscription cleanup.",
  },
  "react-luau/rerender-unnecessary-usememo": {
    before: `local doubled = React.useMemo(function()
\treturn value * 2
end, { value })`,
    after: `local doubled = value * 2`,
    note: "Compute cheap derived values directly when stable identity is not observed.",
  },
  "react-luau/rerender-unnecessary-usecallback": {
    before: `local functionName = React.useCallback(function()
\tdoSomething()
end, {})`,
    after: `local function functionName()
\tdoSomething()
end`,
    note: "Use a normal local function when nothing observes the callback's identity.",
  },
  "react-luau/rerender-static-discovery-in-render": {
    before: `local function Component()
\tlocal modules = ReplicatedStorage.Modules:GetChildren()
\treturn renderModules(modules)
end`,
    after: `local modules = ReplicatedStorage.Modules:GetChildren()

local function Component()
\treturn renderModules(modules)
end`,
    note: "Move truly static discovery to module scope. If the source can change, cache or subscribe to the real changing input instead.",
  },
  "react-luau/rerender-repeated-collection-scan": {
    before: `for _, item in items do
\tbuildRow(item)
end

for _, item in items do
\tbuildLookup(item)
end`,
    after: `for _, item in items do
\tbuildRow(item)
\tbuildLookup(item)
end`,
    note: "Combine passes when they iterate the same collection and can safely share one traversal.",
  },
  "react-luau/rerender-static-state": {
    before: `local value, setValue = React.useState(computeValue())
-- setValue is never used`,
    after: `local valueRef = React.useRef(nil)
if valueRef.current == nil then
\tvalueRef.current = computeValue()
end
local value = valueRef.current`,
    note: "This preserves a pure, non-nil initial value without a state setter. Derive a local value directly only when recomputing on every render is intended.",
  },
  "react-luau/prefer-use-ref-for-mutable-cell": {
    before: `local cell = React.useMemo(function()
\treturn { current = initialValue }
end, {})`,
    after: `local cell = React.useRef(initialValue)`,
    note: "useRef directly expresses a stable mutable current cell.",
  },
  "react-luau/rerender-functional-setstate": {
    before: `setCount(count + 1)`,
    after: `setCount(function(previous)
\treturn previous + 1
end)`,
    note: "Use the previous value supplied by React when a retained callback computes the next state from old state.",
  },
  "react-luau/rerender-lazy-state-init": {
    before: `local value, setValue = React.useState(buildExpensiveValue())`,
    after: `local value, setValue = React.useState(function()
\treturn buildExpensiveValue()
end)`,
    note: "Pass a lazy initializer function so expensive construction only runs when the state is first created.",
  },
  "react-luau/rerender-lazy-ref-init": {
    before: `local valueRef = React.useRef(buildExpensiveValue())`,
    after: `local valueRef = React.useRef(nil)
if valueRef.current == nil then
\tvalueRef.current = buildExpensiveValue()
end`,
    note: "Use nil-guarded lazy initialization only for pure construction. Owned resources with cleanup usually belong in an effect.",
  },
  "react-luau/rerender-state-only-in-handlers": {
    before: `local value, setValue = React.useState(0)

local function onInput()
\tprint(value)
end`,
    after: `local valueRef = React.useRef(0)

local function onInput()
\tprint(valueRef.current)
end`,
    note: "Use a ref when updates do not need to participate in rendering or hook dependencies.",
  },
  "react-luau/no-set-state-in-render": {
    before: `local value, setValue = React.useState(0)
setValue(nextValue)`,
    after: `local value, setValue = React.useState(0)

React.useEffect(function()
\tsetValue(nextValue)
end, { nextValue })`,
    note: "Move the update to the event or effect that owns it. Prefer deriving the value directly when no state synchronization is needed.",
  },
  "react-luau/no-direct-state-mutation": {
    before: `items[index] = nextItem
setItems(items)`,
    after: `local nextItems = table.clone(items)
nextItems[index] = nextItem
setItems(nextItems)`,
    note: "Create a new table identity before updating React state.",
  },
  "react-luau/no-ref-current-in-render": {
    before: `latest.current = value`,
    after: `React.useEffect(function()
\tlatest.current = value
end, { value })`,
    note: "When committed-versus-uncommitted values matter, update the latest-value ref after commit.",
  },
  "react-luau/no-create-context-in-render": {
    before: `local function Component()
\tlocal Context = React.createContext(nil)
\treturn React.createElement(Context.Provider)
end`,
    after: `local Context = React.createContext(nil)

local function Component()
\treturn React.createElement(Context.Provider)
end`,
    note: "Create the Context once at module scope so its identity is stable.",
  },
  "react-luau/no-nested-component-definition": {
    before: `local function Parent()
\tlocal function Child()
\t\treturn React.createElement("Frame")
\tend
\treturn React.createElement(Child)
end`,
    after: `local function Child()
\treturn React.createElement("Frame")
end

local function Parent()
\treturn React.createElement(Child)
end`,
    note: "Move component definitions out of render so React sees a stable component identity.",
  },
  "react-luau/no-random-key": {
    before: `React.createElement(Row, {
\tkey = HttpService:GenerateGUID(false),
})`,
    after: `React.createElement(Row, {
\tkey = item.id,
})`,
    note: "Use identity that remains stable for the lifetime of the logical item.",
  },
  "react-luau/no-yield-in-render": {
    before: `local function Component(props)
\tlocal result = props.remote:InvokeServer()
\treturn React.createElement("TextLabel", { Text = tostring(result) })
end`,
    after: `local function Component(props)
\tlocal result, setResult = React.useState("Loading...")
\tReact.useEffect(function()
\t\tlocal active = true
\t\ttask.spawn(function()
\t\t\tlocal ok, value = pcall(function()
\t\t\t\treturn props.remote:InvokeServer()
\t\t\tend)
\t\t\tif active then
\t\t\t\tsetResult(if ok then tostring(value) else "Request failed")
\t\t\tend
\t\tend)
\t\treturn function() active = false end
\tend, { props.remote })
\treturn React.createElement("TextLabel", { Text = result })
end`,
    note: "Start yielding work after commit and ignore stale results after cleanup. This does not cancel the server request. Production data loading may also need retries or request deduplication.",
  },
  "react-luau/no-task-spawn-in-render": {
    before: `local function Component()
\ttask.spawn(doWork)
\treturn React.createElement("Frame")
end`,
    after: `local function Component()
\tReact.useEffect(function()
\t\tlocal thread = task.spawn(doWork)
\t\treturn function()
\t\t\tif coroutine.status(thread) ~= "dead" then
\t\t\t\ttask.cancel(thread)
\t\t\tend
\t\tend
\tend, { doWork })
\treturn React.createElement("Frame")
end`,
    note: "Schedule work from the effect or event that owns the side effect, not while rendering.",
  },
  "react-luau/no-side-effects-in-render": {
    before: `local connection = signal:Connect(onChanged)`,
    after: `React.useEffect(function()
\tlocal connection = signal:Connect(onChanged)
\treturn function()
\t\tconnection:Disconnect()
\tend
end, { signal, onChanged })`,
    note: "Move imperative work into an owned effect with cleanup. Disconnect subscriptions, destroy owned Instances, and cancel tweens. Prefer React.createElement for React-owned Instances.",
  },
  "react-luau/no-create-root-in-render": {
    before: `local function Component()
\tlocal root = ReactRoblox.createRoot(container)
\troot:render(element)
end`,
    after: `local root = ReactRoblox.createRoot(container)
root:render(element)`,
    note: "Create and own roots outside component render. A component should not imperatively create another React root while rendering.",
  },
  "react-luau/no-prop-mutation": {
    before: `props.value = normalize(props.value)`,
    after: `local value = normalize(props.value)`,
    note: "Treat props as immutable and derive a local value or update state in the owner.",
  },
  "react-luau/no-array-index-as-key": {
    before: `for index, item in items do
\tchildren[index] = React.createElement(Row, {
\t\tkey = index,
\t})
end`,
    after: `for _, item in items do
\tchildren[item.id] = React.createElement(Row, {
\t\tkey = item.id,
\t})
end`,
    note: "Use stable item identity when items can move. Keep positional identity only when replacing the occupant of a slot is intentional.",
  },
  "react-luau/unstable-context-value": {
    before: `return React.createElement(Context.Provider, {
\tvalue = { user = user, theme = theme },
})`,
    after: `local contextValue = React.useMemo(function()
\treturn { user = user, theme = theme }
end, { user, theme })

return React.createElement(Context.Provider, {
\tvalue = contextValue,
})`,
    note: "Memoize the provider value when consumer updates depend on table identity.",
  },
};

export function fixExampleForRule(ruleId: string): FixPreview | undefined {
  const example = examples[ruleId];
  return example ? { ...example, kind: example.kind ?? "pattern" } : undefined;
}
