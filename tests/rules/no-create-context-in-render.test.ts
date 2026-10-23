import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-create-context-in-render", {
  valid: [
    {
      name: "context is created at module scope",
      code: dedent`
        local StableContext = React.createContext(nil)
        local function AdvancedValid(props)
          local count, setCount = React.useState(0)
          local contextValue = React.useMemo(function() return { count = count } end, { count })
          return React.createElement(StableContext.Provider, { value = contextValue })
        end
      `,
    },
  ],
  invalid: [
    {
      name: "context created inside a component",
      code: dedent`
        local function Component(props)
          local LocalContext = React.createContext(nil)
          return React.createElement(LocalContext.Provider, { value = nil })
        end
      `,
      errors: [
        { line: 2, column: 24, message: "React.createContext() is called during component render in Component." },
      ],
    },
  ],
});
