import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-array-index-as-key", {
  valid: [
    {
      name: "ordinary table copy loop does not create React keys",
      code: dedent`
        local function DeepCopy(input)
          local copy = {}
          for key, value in input do
            copy[key] = value
          end
          return copy
        end
        local function Component(props)
          return React.createElement("Frame")
        end
      `,
    },
    {
      name: "recognizes positional and unknown keys without relying on variable names (FixedSlots)",
      code: dedent`
        local function Component(props)
          local children = {}
          for i = 1, props.count do
            children[i] = React.createElement(Row, {})
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
    },
    {
      name: "recognizes positional and unknown keys without relying on variable names (Stable)",
      code: dedent`
        local function Component(props)
          local children = {}
          for i, item in props.items do
            children[item.id] = React.createElement(Row, { LayoutOrder = i })
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
    },
    {
      name: "uses visible collection shapes and types to distinguish positional and dictionary keys (StringDictionary)",
      code: dedent`
        export type ComponentProps = {
          items: { [string]: Item },
        }
        local function Component(props: ComponentProps)
          local children = React.useMemo(function()
            local sortedItems = table.clone(props.items)
            table.sort(sortedItems, function(a, b) return a.rarity > b.rarity end)
            local elements = {}
            for k, item in sortedItems do
              elements[k] = React.createElement(Row, {})
            end
            return elements
          end, { props.items })
          return React.createElement(React.Fragment, nil, children)
        end
      `,
    },
    {
      name: "respects local type hints, aliases, dictionary literals and shadowed collections (DictionaryLiteral)",
      code: dedent`
        local React = require(script.Parent.React)
        local function Component(props)
          local items = { First = props.first, Second = props.second }
          local children = {}
          for index, item in items do
            children[index] = React.createElement(Row, {})
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
    },
    {
      name: "respects local type hints, aliases, dictionary literals and shadowed collections (MemoFactory)",
      code: dedent`
        local React = require(script.Parent.React)
        local function Component(props)
          local function build()
            local result = {}
            if not props.first then
              return result
            end
            result[props.prefix .. "First"] = props.first
            return result
          end
          local items = React.useMemo(build, {})
          local children = {}
          for index, item in items do
            children[index] = React.createElement(Row, {})
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
    },
    {
      name: "respects local type hints, aliases, dictionary literals and shadowed collections (NamedWrites)",
      code: dedent`
        local React = require(script.Parent.React)
        local function Component(props)
          local items = {}
          for _, child in props.folder:GetChildren() do
            items[child.Name] = child
          end
          local children = {}
          for index, item in items do
            children[index] = React.createElement(Row, {})
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
    },
    {
      name: "respects local type hints, aliases, dictionary literals and shadowed collections (Shadowed)",
      code: dedent`
        local React = require(script.Parent.React)
        local function Component(props)
          local items = { props.first, props.second }
          local items: { [string]: Item } = props.items
          local children = {}
          for index, item in items do
            children[index] = React.createElement(Row, {})
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
    },
    {
      name: "respects local type hints, aliases, dictionary literals and shadowed collections (StringAnnotation)",
      code: dedent`
        local React = require(script.Parent.React)
        local function Component(props)
          local items: { [string]: Item } = props.items
          local children = {}
          for index, item in items do
            children[index] = React.createElement(Row, {})
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
    },
  ],
  invalid: [
    {
      name: "positional loop index is a child key",
      code: dedent`
        local function Component(props)
          local children = {}
          for index, item in ipairs(props.items) do
            children[index] = React.createElement("TextLabel", { Text = item.name })
          end
          return React.createElement("Frame", nil, children)
        end
      `,
      errors: [
        { line: 4, column: 14, message: "Loop index index is used as React child identity." },
      ],
    },
    {
      name: "reports sorted collection positions returned from useMemo and passed to a fragment",
      code: dedent`
        local createElement = React.createElement
        local function Component(props)
          local itemElements = React.useMemo(function(): { [string]: React.ReactElement<any, any> }
            local elements = {}
            local sortedItems = table.clone(props.items)
            table.sort(sortedItems, function(a, b) return a.rarity > b.rarity end)
            for i, v in sortedItems do
              elements[i] = createElement(DailyShopItem, { itemName = v.name })
            end
            return elements
          end, { props.items })
          return createElement(React.Fragment, nil, itemElements)
        end
      `,
      errors: [
        { line: 8, column: 16, message: "Loop index i is used as React child identity." },
      ],
    },
    {
      name: "recognizes positional and unknown keys without relying on variable names (ExplicitKey)",
      code: dedent`
        local function Component(props)
          local children = {}
          for i, item in props.items do
            children[item.id] = React.createElement(Row, { key = i })
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
      errors: [
        { line: 4, column: 58, message: "Loop key i may be an array position used as React child identity." },
      ],
    },
    {
      name: "recognizes positional and unknown keys without relying on variable names (Generic)",
      code: dedent`
        local function Component(props)
          local children = {}
          for i, item in props.items do
            children[i] = React.createElement(Row, {})
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
      errors: [
        { line: 4, column: 14 },
      ],
    },
    {
      name: "recognizes positional and unknown keys without relying on variable names (Ipairs)",
      code: dedent`
        local function Component(props)
          local children = {}
          for offset, item in ipairs(props.items) do
            children[offset] = React.createElement(Row, {})
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
      errors: [
        { line: 4, column: 14, message: "Loop index offset is used as React child identity." },
      ],
    },
    {
      name: "recognizes positional and unknown keys without relying on variable names (Numeric)",
      code: dedent`
        local function Component(props)
          local children = {}
          for i = 1, #props.items do
            children[i] = React.createElement(Row, {})
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
      errors: [
        { line: 4, column: 14 },
      ],
    },
    {
      name: "recognizes positional and unknown keys without relying on variable names (ShadowedIpairs)",
      code: dedent`
        local function Component(props)
          local children = {}
          local ipairs = props.iterator
          for offset, item in ipairs(props.items) do
            children[offset] = React.createElement(Row, {})
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
      errors: [
        { line: 5, column: 14, message: "Loop key offset may be an array position used as React child identity." },
      ],
    },
    {
      name: "recognizes positional and unknown keys without relying on variable names (SlotData)",
      code: dedent`
        local function Component(props)
          local children = {}
          for i = 1, props.count do
            children[i] = React.createElement(Row, { item = props.items[i] })
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
      errors: [
        { line: 4, column: 14 },
      ],
    },
    {
      name: "recognizes positional and unknown keys without relying on variable names (UnknownK)",
      code: dedent`
        local function Component(props)
          local children = {}
          for k, item in props.itemsById do
            children[k] = React.createElement(Row, {})
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
      errors: [
        { line: 4, column: 14, message: "Loop key k may be an array position used as React child identity." },
      ],
    },
    {
      name: "resolves scoped type aliases without treating commented types as declarations",
      code: dedent`
        local React = require(script.Parent.React)
        -- Unicode before aliases: café
        type Items = { Item }
        --[[
        type Items = { [string]: Item }
        ]]
        local function Dictionary(props)
          type Items = { [string]: Item }
          local items: Items = props.items
          local children = {}
          for i, item in items do
            children[i] = React.createElement(Row, {})
          end
          return React.createElement(React.Fragment, nil, children)
        end
        local function Array(props)
          local items: Items = props.items
          local children = {}
          for k, item in pairs(items) do
            children[k] = React.createElement(Row, {})
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
      errors: [
        { line: 20, column: 14, message: "Loop index k is used as React child identity." },
      ],
    },
    {
      name: "uses visible collection shapes and types to distinguish positional and dictionary keys (Array)",
      code: dedent`
        export type ComponentProps = {
          items: { Item },
        }
        local function Component(props: ComponentProps)
          local children = React.useMemo(function()
            local sortedItems = table.clone(props.items)
            table.sort(sortedItems, function(a, b) return a.rarity > b.rarity end)
            local elements = {}
            for k, item in sortedItems do
              elements[k] = React.createElement(Row, {})
            end
            return elements
          end, { props.items })
          return React.createElement(React.Fragment, nil, children)
        end
      `,
      errors: [
        { line: 10, column: 16 },
      ],
    },
    {
      name: "uses visible collection shapes and types to distinguish positional and dictionary keys (ImportedType)",
      code: dedent`
        local React = require(script.Parent.React)
        export type ComponentProps = {
          items: Types.Items,
        }
        local function Component(props: ComponentProps)
          local children = React.useMemo(function()
            local sortedItems = table.clone(props.items)
            table.sort(sortedItems, function(a, b) return a.rarity > b.rarity end)
            local elements = {}
            for k, item in sortedItems do
              elements[k] = React.createElement(Row, {})
            end
            return elements
          end, { props.items })
          return React.createElement(React.Fragment, nil, children)
        end
      `,
      errors: [
        { line: 11, column: 16 },
      ],
    },
    {
      name: "uses visible collection shapes and types to distinguish positional and dictionary keys (NumericMap)",
      code: dedent`
        export type ComponentProps = {
          items: { [number]: Item },
        }
        local function Component(props: ComponentProps)
          local children = React.useMemo(function()
            local sortedItems = table.clone(props.items)
            table.sort(sortedItems, function(a, b) return a.rarity > b.rarity end)
            local elements = {}
            for k, item in sortedItems do
              elements[k] = React.createElement(Row, {})
            end
            return elements
          end, { props.items })
          return React.createElement(React.Fragment, nil, children)
        end
      `,
      errors: [
        { line: 10, column: 16 },
      ],
    },
    {
      name: "respects local type hints, aliases, dictionary literals and shadowed collections (Alias)",
      code: dedent`
        local React = require(script.Parent.React)
        local function Component(props)
          local source = { props.first, props.second }
          local items = source
          local children = {}
          for index, item in items do
            children[index] = React.createElement(Row, {})
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
      errors: [
        { line: 7, column: 14 },
      ],
    },
    {
      name: "respects local type hints, aliases, dictionary literals and shadowed collections (ArrayAnnotation)",
      code: dedent`
        local React = require(script.Parent.React)
        local function Component(props)
          local items: { Item } = props.items
          local children = {}
          for index, item in items do
            children[index] = React.createElement(Row, {})
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
      errors: [
        { line: 6, column: 14 },
      ],
    },
    {
      name: "respects local type hints, aliases, dictionary literals and shadowed collections (ArrayLiteral)",
      code: dedent`
        local React = require(script.Parent.React)
        local function Component(props)
          local items = { props.first, props.second }
          local children = {}
          for index, item in items do
            children[index] = React.createElement(Row, {})
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
      errors: [
        { line: 6, column: 14 },
      ],
    },
    {
      name: "respects local type hints, aliases, dictionary literals and shadowed collections (ConditionalReassignment)",
      code: dedent`
        local React = require(script.Parent.React)
        local function Component(props)
          local items = { props.first, props.second }
          if props.replace then items = props.items end
          local children = {}
          for index, item in items do
            children[index] = React.createElement(Row, {})
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
      errors: [
        { line: 7, column: 14, message: "Loop key index may be an array position used as React child identity." },
      ],
    },
    {
      name: "respects local type hints, aliases, dictionary literals and shadowed collections (InsertedItems)",
      code: dedent`
        local React = require(script.Parent.React)
        local function Component(props)
          local items = {}
          table.insert(items, props.first)
          local children = {}
          for index, item in items do
            children[index] = React.createElement(Row, {})
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
      errors: [
        { line: 7, column: 14 },
      ],
    },
    {
      name: "respects local type hints, aliases, dictionary literals and shadowed collections (MixedLiteral)",
      code: dedent`
        local React = require(script.Parent.React)
        local function Component(props)
          local items = { props.first, Named = props.second }
          local children = {}
          for index, item in items do
            children[index] = React.createElement(Row, {})
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
      errors: [
        { line: 6, column: 14 },
      ],
    },
    {
      name: "respects local type hints, aliases, dictionary literals and shadowed collections (NumericLiteralMap)",
      code: dedent`
        local React = require(script.Parent.React)
        local function Component(props)
          local items = { [100] = props.first, [200] = props.second }
          local children = {}
          for index, item in items do
            children[index] = React.createElement(Row, {})
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
      errors: [
        { line: 6, column: 14 },
      ],
    },
    {
      name: "respects local type hints, aliases, dictionary literals and shadowed collections (Reassigned)",
      code: dedent`
        local React = require(script.Parent.React)
        local function Component(props)
          local items = { props.first, props.second }
          items = props.items
          local children = {}
          for index, item in items do
            children[index] = React.createElement(Row, {})
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
      errors: [
        { line: 7, column: 14 },
      ],
    },
    {
      name: "respects local type hints, aliases, dictionary literals and shadowed collections (UnknownWrites)",
      code: dedent`
        local React = require(script.Parent.React)
        local function Component(props)
          local items = {}
          items[props.key] = props.first
          local children = {}
          for index, item in items do
            children[index] = React.createElement(Row, {})
          end
          return React.createElement(React.Fragment, nil, children)
        end
      `,
      errors: [
        { line: 7, column: 14 },
      ],
    },
  ],
});
