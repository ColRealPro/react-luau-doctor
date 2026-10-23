import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-snapshot-overwriting-edits", {
  valid: [
    {
      name: "unedited mirror stays valid",
      files: {
        "Editor.luau": dedent`
          local useStore = require(script.Parent.useStore)
          local function Editor(props)
            local store = useStore(props.source)
            local draft, setDraft = React.useState(nil)
            local mirror, setMirror = React.useState(nil)
            React.useEffect(function() setMirror(store.Draft) end, { store })
            local add = React.useCallback(function(value) setDraft(value) end, {})
            return React.createElement("TextBox", {
              Count = mirror,
              Add = add,
            })
          end
        `,
        "useStore.luau": dedent`
          local function useStore(source)
            local state, setState = React.useState({})
            React.useEffect(function()
              source.Changed:Connect(function() setState(table.clone(source.State)) end)
            end, { source })
            return state
          end
          return useStore
        `,
      },
    },
    {
      name: "functional initialization preserves edits",
      files: {
        "Editor.luau": dedent`
          local useStore = require(script.Parent.useStore)
          local function Editor(props)
            local store = useStore(props.source)
            local draft, setDraft = React.useState(nil)
            React.useEffect(function() setDraft(function(previous) return previous or store.Draft end) end, { store })
            local add = React.useCallback(function(value) setDraft(value) end, {})
            return React.createElement("TextBox", { Add = add })
          end
        `,
        "useStore.luau": dedent`
          local function useStore(source)
            local state, setState = React.useState({})
            React.useEffect(function()
              source.Changed:Connect(function() setState(table.clone(source.State)) end)
            end, { source })
            return state
          end
          return useStore
        `,
      },
    },
    {
      name: "leaf dependency preserves edits",
      files: {
        "Editor.luau": dedent`
          local useStore = require(script.Parent.useStore)
          local function Editor(props)
            local store = useStore(props.source)
            local draft, setDraft = React.useState(nil)
            React.useEffect(function() setDraft(store.Draft) end, { store.Draft })
            local add = React.useCallback(function(value) setDraft(value) end, {})
            return React.createElement("TextBox", { Add = add })
          end
        `,
        "useStore.luau": dedent`
          local function useStore(source)
            local state, setState = React.useState({})
            React.useEffect(function()
              source.Changed:Connect(function() setState(table.clone(source.State)) end)
            end, { source })
            return state
          end
          return useStore
        `,
      },
    },
    {
      name: "nil guard preserves initial edits",
      files: {
        "Editor.luau": dedent`
          local useStore = require(script.Parent.useStore)
          local function Editor(props)
            local store = useStore(props.source)
            local draft, setDraft = React.useState(nil)
            React.useEffect(function() if draft == nil and store.Draft then setDraft(store.Draft) end end, { store, draft })
            local add = React.useCallback(function(value) setDraft(value) end, {})
            return React.createElement("TextBox", { Add = add })
          end
        `,
        "useStore.luau": dedent`
          local function useStore(source)
            local state, setState = React.useState({})
            React.useEffect(function()
              source.Changed:Connect(function() setState(table.clone(source.State)) end)
            end, { source })
            return state
          end
          return useStore
        `,
      },
    },
    {
      name: "ref guard seeds state once",
      files: {
        "Editor.luau": dedent`
          local useStore = require(script.Parent.useStore)
          local function Editor(props)
            local store = useStore(props.source)
            local seededRef = React.useRef(false)
            local draft, setDraft = React.useState(nil)
            React.useEffect(function()
              if seededRef.current then return end
              seededRef.current = true
              setDraft(store.Draft)
            end, { store })
            local add = React.useCallback(function(value) setDraft(value) end, {})
            return React.createElement("TextBox", { Add = add })
          end
        `,
        "useStore.luau": dedent`
          local function useStore(source)
            local state, setState = React.useState({})
            React.useEffect(function()
              source.Changed:Connect(function() setState(table.clone(source.State)) end)
            end, { source })
            return state
          end
          return useStore
        `,
      },
    },
    {
      name: "identity changes reseed state",
      files: {
        "Editor.luau": dedent`
          local useStore = require(script.Parent.useStore)
          local function Editor(props)
            local store = useStore(props.source)
            local draft, setDraft = React.useState(nil)
            local lastId, setLastId = React.useState(nil)
            React.useEffect(function()
              if lastId ~= store.Id then
                setLastId(store.Id)
                setDraft(store.Draft)
              end
            end, { store, lastId })
            local add = React.useCallback(function(value) setDraft(value) end, {})
            return React.createElement("TextBox", { Add = add })
          end
        `,
        "useStore.luau": dedent`
          local function useStore(source)
            local state, setState = React.useState({})
            React.useEffect(function()
              source.Changed:Connect(function() setState(table.clone(source.State)) end)
            end, { source })
            return state
          end
          return useStore
        `,
      },
    },
    {
      name: "explicit edit guard preserves edits",
      files: {
        "Editor.luau": dedent`
          local useStore = require(script.Parent.useStore)
          local function Editor(props)
            local store = useStore(props.source)
            local draft, setDraft = React.useState(nil)
            local isEditing, setIsEditing = React.useState(false)
            React.useEffect(function()
              if isEditing then return end
              setDraft(store.Draft)
            end, { store, isEditing })
            local add = React.useCallback(function(value) setDraft(value) end, {})
            return React.createElement("TextBox", {
              Add = add,
              [React.Event.Focused] = function() setIsEditing(true) end,
            })
          end
        `,
        "useStore.luau": dedent`
          local function useStore(source)
            local state, setState = React.useState({})
            React.useEffect(function()
              source.Changed:Connect(function() setState(table.clone(source.State)) end)
            end, { source })
            return state
          end
          return useStore
        `,
      },
    },
    {
      name: "selector result is not a store snapshot",
      files: {
        "Editor.luau": dedent`
          local useSelector = require(script.Parent.useSelector)
          local function Editor(props)
            local selected = useSelector(props.source)
            local draft, setDraft = React.useState({})
            React.useEffect(function() setDraft(selected.Saved) end, { selected })
            return React.createElement("TextBox", { Text = draft.text, onChanged = setDraft })
          end
        `,
        "useSelector.luau": dedent`
          local function useSelector(source)
            local state, setState = React.useState(nil)
            React.useEffect(function()
              source.Changed:Connect(function() setState(source.State.Saved) end)
            end, { source })
            return state
          end
          return useSelector
        `,
      },
    },
    {
      name: "cloned Instance is not a store snapshot",
      files: {
        "Editor.luau": dedent`
          local useModel = require(script.Parent.useModel)
          local function Editor(props)
            local model = useModel(props.source)
            local draft, setDraft = React.useState({})
            React.useEffect(function() setDraft(model.Saved) end, { model })
            return React.createElement("TextBox", { Text = draft.text, onChanged = setDraft })
          end
        `,
        "useModel.luau": dedent`
          local function useModel(source)
            local state, setState = React.useState(nil)
            React.useEffect(function()
              source.Changed:Connect(function() setState(source:Clone()) end)
            end, { source })
            return state
          end
          return useModel
        `,
      },
    },
  ],
  invalid: [
    {
      name: "snapshot replaces aliased item fields",
      files: {
        "Editor.luau": dedent`
          local React = require(script.Parent.React)
          local useStore = require(script.Parent.useStore)
          local function Editor(props)
            local store = useStore(props.source)
            local draft, setDraft = React.useState(nil)
            local title, setTitle = React.useState("")
            React.useEffect(function()
              local item = store.Items[props.id]
              if not item then return end
              if title == "" then print("untitled") end
              setDraft(item.values)
              setTitle(item.title)
            end, { store, props.id })
            local add = React.useCallback(function(value) setDraft(value) end, {})
            return React.createElement("TextBox", {
              Text = title,
              onChanged = setTitle,
              Add = add,
            })
          end
        `,
        "useStore.luau": dedent`
          local React = require(script.Parent.React)
          local function useStore(source)
            local state, setState = React.useState({})
            React.useEffect(function()
              source.Changed:Connect(function() setState(table.clone(source.State)) end)
            end, { source })
            return state
          end
          return useStore
        `,
      },
      errors: [
        { line: 13, column: 10, message: "store is a new table after every useStore() store change, so this effect keeps overwriting draft and title and discards edits from add and onChanged", file: "Editor.luau", fixPreview: {"kind":"exact","before":"{ store, props.id }","after":"{ store.Items, props.id }","note":"The effect then only re-runs when the fields it reads change"} },
      ],
    },
    {
      name: "guarded snapshot mirror overwrites edits",
      files: {
        "Editor.luau": dedent`
          local useStore = require(script.Parent.useStore)
          local function Editor(props)
            local store = useStore(props.source)
            local draft, setDraft = React.useState(nil)
            React.useEffect(function() if draft ~= store.Draft then setDraft(store.Draft) end end, { store, draft })
            local add = React.useCallback(function(value) setDraft(value) end, {})
            return React.createElement("TextBox", { Add = add })
          end
        `,
        "useStore.luau": dedent`
          local function useStore(source)
            local state, setState = React.useState({})
            React.useEffect(function()
              source.Changed:Connect(function() setState(table.clone(source.State)) end)
            end, { source })
            return state
          end
          return useStore
        `,
      },
      errors: [
        { line: 5, column: 92, message: "store is a new table after every useStore() store change, so this effect keeps overwriting draft and discards edits from add", file: "Editor.luau", fixPreview: {"kind":"exact","before":"{ store, draft }","after":"{ store.Draft, draft }","note":"The effect then only re-runs when the fields it reads change"} },
      ],
    },
    {
      name: "deferred snapshot mirror",
      files: {
        "Editor.luau": dedent`
          local useStore = require(script.Parent.useStore)
          local function Editor(props)
            local store = useStore(props.source)
            local draft, setDraft = React.useState(nil)
            React.useEffect(function() task.defer(function() setDraft(store["Draft"]) end) end, { store, store.Draft })
            local add = React.useCallback(function(value) setDraft(value) end, {})
            return React.createElement("TextBox", { Add = add })
          end
        `,
        "useStore.luau": dedent`
          local function useStore(source)
            local state, setState = React.useState({})
            React.useEffect(function()
              source.Changed:Connect(function() setState(table.clone(source.State)) end)
            end, { source })
            return state
          end
          return useStore
        `,
      },
      errors: [
        { line: 5, column: 89, file: "Editor.luau", fixPreview: {"kind":"exact","before":"{ store, store.Draft }","after":"{ store.Draft }","note":"The effect then only re-runs when the fields it reads change"} },
      ],
    },
    {
      name: "unrelated guard still overwrites edits",
      files: {
        "Editor.luau": dedent`
          local useStore = require(script.Parent.useStore)
          local function Editor(props)
            local store = useStore(props.source)
            local draft, setDraft = React.useState(nil)
            local mirror, setMirror = React.useState(nil)
            React.useEffect(function()
              if mirror then return end
              setDraft(store.Draft)
            end, { store, mirror })
            local add = React.useCallback(function(value) setDraft(value) end, {})
            return React.createElement("TextBox", { Add = add })
          end
        `,
        "useStore.luau": dedent`
          local function useStore(source)
            local state, setState = React.useState({})
            React.useEffect(function()
              source.Changed:Connect(function() setState(table.clone(source.State)) end)
            end, { source })
            return state
          end
          return useStore
        `,
      },
      errors: [
        { line: 9, column: 10, file: "Editor.luau", fixPreview: {"kind":"exact","before":"{ store, mirror }","after":"{ store.Draft, mirror }","note":"The effect then only re-runs when the fields it reads change"} },
      ],
    },
    {
      name: "aliased index still overwrites edits",
      files: {
        "Editor.luau": dedent`
          local React = require(script.Parent.React)
          local useStore = require(script.Parent.useStore)
          local function Editor(props)
            local store = useStore(props.source)
            local draft, setDraft = React.useState(nil)
            local editId, setEditId = React.useState(nil)
            React.useEffect(function()
              if not editId then return end
              setDraft(store.Items[editId])
            end, { store, editId })
            local add = React.useCallback(function(value) setDraft(value) end, {})
            return React.createElement("TextBox", { Add = add })
          end
        `,
        "useStore.luau": dedent`
          local React = require(script.Parent.React)
          local function useStore(source)
            local state, setState = React.useState({})
            React.useEffect(function()
              source.Changed:Connect(function() setState(table.clone(source.State)) end)
            end, { source })
            return state
          end
          return useStore
        `,
      },
      errors: [
        { line: 10, column: 10, file: "Editor.luau", fixPreview: {"kind":"exact","before":"{ store, editId }","after":"{ store.Items, editId }","note":"The effect then only re-runs when the fields it reads change"} },
      ],
    },
    {
      name: "custom hook exposes snapshot-backed editable state",
      files: {
        "Editor.luau": dedent`
          local useStore = require(script.Parent.useStore)
          local function useDraft(source)
            local store = useStore(source)
            local draft, setDraft = React.useState(nil)
            React.useEffect(function() setDraft(store.Draft) end, { store })
            return draft, setDraft
          end
          return { Editor = Editor, useDraft = useDraft }
        `,
        "useStore.luau": dedent`
          local function useStore(source)
            local state, setState = React.useState({})
            React.useEffect(function()
              source.Changed:Connect(function() setState(table.clone(source.State)) end)
            end, { source })
            return state
          end
          return useStore
        `,
      },
      errors: [
        { line: 5, column: 59, message: "store is a new table after every useStore() store change, so this effect keeps overwriting draft and discards edits from callers of useDraft", file: "Editor.luau", fixPreview: {"kind":"exact","before":"{ store }","after":"{ store.Draft }","note":"The effect then only re-runs when the fields it reads change"} },
      ],
    },
    {
      name: "copied store snapshot overwrites editable state",
      files: {
        "Editor.luau": dedent`
          local useStore = require(script.Parent.useStore)
          local function Editor(props)
            local store = useStore(props.source) or {}
            local draft, setDraft = React.useState({})
            React.useEffect(function() setDraft(store.Saved) end, { store })
            return React.createElement("TextBox", { Text = draft.text, onChanged = setDraft })
          end
        `,
        "useStore.luau": dedent`
          local function useStore(source)
            local state, setState = React.useState(nil)
            React.useEffect(function()
              source.Changed:Connect(function() setState(table.clone(source.State)) end)
            end, { source })
            return state
          end
          return useStore
        `,
      },
      errors: [
        { line: 5, column: 59, message: "store is a new table after every useStore() store change, so this effect keeps overwriting draft and discards edits from onChanged", file: "Editor.luau" },
      ],
    },
    {
      name: "forwarded snapshot overwrites editable state",
      files: {
        "Editor.luau": dedent`
          local useForwarded = require(script.Parent.useForwarded)
          local function Editor(props)
            local forwarded = useForwarded(props.source)
            local draft, setDraft = React.useState({})
            React.useEffect(function() setDraft(forwarded.Saved) end, { forwarded })
            return React.createElement("TextBox", { Text = draft.text, onChanged = setDraft })
          end
        `,
        "useForwarded.luau": dedent`
          local useStore = require(script.Parent.useStore)
          local function useForwarded(source)
            return useStore(source)
          end
          return useForwarded
        `,
        "useStore.luau": dedent`
          local function useStore(source)
            local state, setState = React.useState(nil)
            React.useEffect(function()
              source.Changed:Connect(function() setState(table.clone(source.State)) end)
            end, { source })
            return state
          end
          return useStore
        `,
      },
      errors: [
        { line: 5, column: 63, message: "forwarded is a new table after every useForwarded() store change, so this effect keeps overwriting draft and discards edits from onChanged", file: "Editor.luau" },
      ],
    },
    {
      name: "local copied-store hook overwrites editable state",
      code: dedent`
        local function useLocalStore(source)
          local state, setState = React.useState({})
          React.useEffect(function()
            source.Changed:Connect(function() setState(table.clone(source.State)) end)
          end, { source })
          return state
        end
        local function Editor(props)
          local localStore = useLocalStore(props.source)
          local draft, setDraft = React.useState({})
          React.useEffect(function() setDraft(localStore.Saved) end, { localStore })
          return React.createElement("TextBox", { Text = draft.text, onChanged = setDraft })
        end
        return Editor
      `,
      errors: [
        { line: 11, column: 64, message: "localStore is a new table after every useLocalStore() store change, so this effect keeps overwriting draft and discards edits from onChanged", file: "Component.luau" },
      ],
    },
  ],
});
