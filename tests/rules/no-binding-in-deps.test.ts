import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-binding-in-deps", {
  invalid: [
    {
      name: "bindings read inside a hook are reported when listed as dependencies",
      code: dedent`
        local function Component(props)
          local size, setSize = React.useBinding(0)
          local count, setCount = React.useState(0)
          React.useEffect(function() print(size:getValue()) end, { size })
          React.useEffect(function() props.onBinding(size) end, { size })
          React.useMemo(function() return count + 1 end, { count })
          return nil
        end
      `,
      errors: [
        { line: 4, column: 60, message: "size is a binding, so this useEffect does not run again when size changes" },
      ],
    },
  ],
});
