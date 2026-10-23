import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/rerender-lazy-ref-init", {
  valid: [
    {
      name: "binding snapshot is a cheap typed ref initializer",
      code: dedent`
        export type Props = { binding: typeof(React.useBinding(0)) }
        local function Component(props: Props)
          local valueRef = React.useRef(props.binding:getValue())
          return React.createElement("Frame", { [React.Tag] = tostring(valueRef.current) })
        end
      `,
    },
    {
      name: "nil-initialized ref is populated under a nil guard",
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
  ],
  invalid: [
    {
      name: "ref initializer eagerly calls a factory",
      code: dedent`
        local function buildCache() return { created = true } end
        local function Component(props)
          local cacheRef = React.useRef(buildCache())
          return React.createElement("Frame", { ref = cacheRef })
        end
      `,
      errors: [
        { line: 3, column: 33, message: "buildCache is rebuilt before useRef returns the existing ref on every render." },
      ],
    },
  ],
});
