import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-static-name-prop", {
  valid: [
    {
      name: "child Name: Dynamic = React.createElement(\"Frame\", { Name = props.name }),",
      code: dedent`
        local function Names(props)
          return React.createElement("Frame", {}, { Dynamic = React.createElement("Frame", { Name = props.name }) })
        end
      `,
    },
    {
      name: "child Name: Computed = React.createElement(\"Frame\", { Name = getName() }),",
      code: dedent`
        local function Names(props)
          return React.createElement("Frame", {}, { Computed = React.createElement("Frame", { Name = getName() }) })
        end
      `,
    },
    {
      name: "child Name: Interpolated = React.createElement(\"Frame\", { Name = `Item{props.id}` }),",
      code: dedent`
        local function Names(props)
          return React.createElement("Frame", {}, { Interpolated = React.createElement("Frame", { Name = \`Item{props.id}\` }) })
        end
      `,
    },
    {
      name: "child Name: Concatenated = React.createElement(\"Frame\", { Name = \"Item\" .. props.id }),",
      code: dedent`
        local function Names(props)
          return React.createElement("Frame", {}, { Concatenated = React.createElement("Frame", { Name = "Item" .. props.id }) })
        end
      `,
    },
    {
      name: "child Name: Custom = React.createElement(Widget, { Name = \"Widget\" }),",
      code: dedent`
        local function Names(props)
          return React.createElement("Frame", {}, { Custom = React.createElement(Widget, { Name = "Widget" }) })
        end
      `,
    },
    {
      name: "Name on a root element",
      code: dedent`
        local function Names(props)
          return React.createElement("Frame", {}, {
          })
        end
        local Root = React.createElement("Frame", { Name = "Root" })
      `,
    },
  ],
  invalid: [
    {
      name: "child Name: First = React.createElement(\"TextLabel\", { Name = \"First\" }),",
      code: dedent`
        local function Names(props)
          return React.createElement("Frame", {}, { First = React.createElement("TextLabel", { Name = "First" }) })
        end
      `,
      errors: [
        { line: 2, column: 88, message: "Static Name prop on a Roblox instance can be expressed as the child table key." },
      ],
    },
    {
      name: "child Name: Second = createElement(\"Frame\", { [\"Name\"] = 'Second' }),",
      code: dedent`
        local createElement = React.createElement
        local function Names(props)
          return React.createElement("Frame", {}, { Second = createElement("Frame", { ["Name"] = 'Second' }) })
        end
      `,
      errors: [
        { line: 3, column: 80 },
      ],
    },
    {
      name: "child Name: Third = React.createElement(\"Frame\", { Name = (\"Third\") }),",
      code: dedent`
        local function Names(props)
          return React.createElement("Frame", {}, { Third = React.createElement("Frame", { Name = ("Third") }) })
        end
      `,
      errors: [
        { line: 2, column: 84 },
      ],
    },
    {
      name: "child Name: Fourth = React.createElement(\"Frame\", { Name = \"Four\" .. \"th\" }),",
      code: dedent`
        local function Names(props)
          return React.createElement("Frame", {}, { Fourth = React.createElement("Frame", { Name = "Four" .. "th" }) })
        end
      `,
      errors: [
        { line: 2, column: 85 },
      ],
    },
    {
      name: "child Name: [\"Fifth\"] = React.createElement(\"Frame\", { Name = \"Fifth\" }),",
      code: dedent`
        local function Names(props)
          return React.createElement("Frame", {}, { ["Fifth"] = React.createElement("Frame", { Name = "Fifth" }) })
        end
      `,
      errors: [
        { line: 2, column: 88 },
      ],
    },
  ],
});
