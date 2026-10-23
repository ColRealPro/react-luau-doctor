import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/rerender-repeated-collection-scan", {
  valid: [
    {
      name: "loops scan different collections",
      code: dedent`
        local function PerformanceValid(props)
          for _, item in props.items do
            print(item)
          end
          for _, other in props.otherItems do
            print(other)
          end
          return React.createElement("Frame")
        end
      `,
    },
  ],
  invalid: [
    {
      name: "same collection scanned twice during render",
      code: dedent`
        local function Component(props)
          for _, item in props.items or {} do print(item) end
          for _, item in props.items or {} do print(item.Name) end
          return React.createElement("Frame")
        end
      `,
      errors: [
        { line: 3, column: 18, message: "props.items or {} is scanned 2 times during this render.", category: "Performance" },
      ],
    },
  ],
});
