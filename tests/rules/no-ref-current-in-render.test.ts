import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-ref-current-in-render", {
  valid: [
    {
      name: "guarded lazy ref initialization is allowed",
      code: dedent`
        local function AdvancedValid(props)
          local frameRef = React.useRef(nil)
          if frameRef.current == nil then
            frameRef.current = {}
          end
          return React.createElement("Frame", { ref = frameRef })
        end
      `,
    },
    {
      name: "same-scope local redeclaration shadows ref",
      code: dedent`
        local function Component(props)
          local ref = React.useRef(nil)
          local ref = { current = nil }
          ref.current = 123
          return React.createElement("Frame")
        end
      `,
    },
  ],
  invalid: [
    {
      name: "matching factory initializer is a render-time ref mirror",
      code: dedent`
        local function buildCache() return { created = true } end
        local function Component(props)
          local cacheRef = React.useRef(buildCache())
          cacheRef.current = buildCache()
          React.useEffect(function() print(cacheRef.current) end, { cacheRef.current })
          return React.createElement("Frame")
        end
      `,
      errors: [
        { line: 4, column: 3, message: "cacheRef.current mirrors its latest render value during render.", severity: "suggestion" },
      ],
    },
    {
      name: "render-computed refs used only by later callbacks are suggestions, while render-read ref writes remain warnings",
      code: dedent`
        local function RefMirrorPatterns(props)
          local mirrored = React.useRef(nil)
          local imperative = React.useRef(nil)
          for _, item in props.items do
            if item.selected then
              mirrored.current = item.id
            end
          end
          if imperative.current then
            imperative.current = props.value
          end
          React.useEffect(function() print(mirrored.current) end, {})
          return React.createElement("Frame")
        end
      `,
      errors: [
        { line: 6, column: 7, message: "mirrored.current mirrors its latest render value during render.", severity: "suggestion" },
        { line: 10, column: 5, message: "imperative.current is mutated during component render.", severity: "warning" },
      ],
    },
    {
      name: "no-ref-current-in-render allows nested branches inside a nil-guarded lazy initialization",
      code: dedent`
        local function Component(props)
          local id = React.useRef(nil)
          if id.current == nil then
            if props.id then
              id.current = props.id
            else
              id.current = props.nextId()
            end
          else
            id.current = props.id
          end
          return React.createElement("TextLabel", { Text = id.current })
        end
      `,
      errors: [
        { line: 10, column: 5, message: "id.current is mutated during component render." },
      ],
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
      errors: [
        { file: "useLatest.luau", line: 3, column: 3, message: "ref.current mirrors its latest render value during render.", severity: "suggestion" },
      ],
    },
  ],
});
