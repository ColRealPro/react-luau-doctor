import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/rerender-unstable-memo-props", {
  valid: [
    {
      name: "project-aware memo analysis does not confuse overlapping module names (Consumer)",
      files: {
        "Consumer.luau": dedent`
          local PreviewPanel = require(script.Parent.PreviewPanel)
          local function Consumer()
            return React.createElement(PreviewPanel, { config = {} })
          end
        `,
        "PreviewPanel.luau": dedent`
          local function PreviewPanel(props)
            return React.createElement("Frame")
          end
          return PreviewPanel
        `,
        "Panel.luau": dedent`
          local Panel = React.memo(function() return React.createElement("Frame") end)
          return Panel
        `,
      },
    },
    {
      name: "custom memo comparator allows fresh prop values",
      files: {
        "Component.luau": dedent`
          local MemoChildCustom = require(script.Parent.MemoChildCustom)
          local function Component()
            return React.createElement(MemoChildCustom, { value = {} })
          end
        `,
        "MemoChildCustom.luau": dedent`
          local function MemoChildCustom(props)
            return React.createElement("Frame", { Name = tostring(props.value) })
          end
          return React.memo(MemoChildCustom, function(previous, next) return previous.value == next.value end)
        `,
      },
    },
    {
      name: "identity rules respect Shadowed",
      code: dedent`
        local Child = React.memo(function() return React.createElement("Frame") end)
        local function Component(RaycastParams, table, workspace)
          return React.createElement(Child, {
            params = RaycastParams.new(),
            config = table.clone({}),
            children = workspace:GetChildren(),
          })
        end
      `,
    },
    {
      name: "identity rules respect ShadowedChild",
      code: dedent`
        local Child = React.memo(function() return React.createElement("Frame") end)
        local function Component(Child)
          return React.createElement(Child, { config = {} })
        end
      `,
    },
    {
      name: "stable memo prop: gradient",
      code: dedent`
        local Child = React.memo(function() return React.createElement("Frame") end)
        local function Component(props)
          local gradient = props.enabled and ColorSequence.new({
            ColorSequenceKeypoint.new(0, Color3.fromHex("ffffff")),
            ColorSequenceKeypoint.new(1, Color3.fromRGB(0, 0, 0)),
          }) or ColorSequence.new(Color3.new(0, 0, 0))
          return React.createElement(Child, { value = gradient })
        end
      `,
    },
    {
      name: "stable memo prop: dimension",
      code: dedent`
        local Child = React.memo(function() return React.createElement("Frame") end)
        local function Component(props)
          return React.createElement(Child, { value = UDim2.fromScale(1, 1) })
        end
      `,
    },
    {
      name: "stable memo prop: vector",
      code: dedent`
        local Child = React.memo(function() return React.createElement("Frame") end)
        local function Component(props)
          return React.createElement(Child, { value = Vector3.new(1, 2, 3) })
        end
      `,
    },
    {
      name: "stable memo prop: sequence",
      code: dedent`
        local Child = React.memo(function() return React.createElement("Frame") end)
        local function Component(props)
          return React.createElement(Child, { value = NumberSequence.new(1) })
        end
      `,
    },
    {
      name: "stable memo prop: stable",
      code: dedent`
        local Child = React.memo(function() return React.createElement("Frame") end)
        local constant = {}
        local function Component(props)
          return React.createElement(Child, { value = constant })
        end
      `,
    },
    {
      name: "stable memo prop: singleton",
      code: dedent`
        local Child = React.memo(function() return React.createElement("Frame") end)
        local constant = {}
        local function singleton() return constant end
        local function Component(props)
          return React.createElement(Child, { value = singleton() })
        end
      `,
    },
    {
      name: "stable memo prop: state",
      code: dedent`
        local Child = React.memo(function() return React.createElement("Frame") end)
        local function Component(props)
          local state = React.useState({})
          return React.createElement(Child, { value = state })
        end
      `,
    },
    {
      name: "stable memo prop: memo",
      code: dedent`
        local Child = React.memo(function() return React.createElement("Frame") end)
        local function Component(props)
          local memo = React.useMemo(function() return {} end, {})
          return React.createElement(Child, { value = memo })
        end
      `,
    },
    {
      name: "stable memo prop: callback",
      code: dedent`
        local Child = React.memo(function() return React.createElement("Frame") end)
        local function Component(props)
          local callback = React.useCallback(function() end, {})
          return React.createElement(Child, { value = callback })
        end
      `,
    },
    {
      name: "stable memo prop: ref",
      code: dedent`
        local Child = React.memo(function() return React.createElement("Frame") end)
        local function Component(props)
          local ref = React.useRef({})
          return React.createElement(Child, { value = ref })
        end
      `,
    },
    {
      name: "stable memo prop: frozen",
      code: dedent`
        local Child = React.memo(function() return React.createElement("Frame") end)
        local constant = {}
        local function Component(props)
          return React.createElement(Child, { value = table.freeze(constant) })
        end
      `,
    },
    {
      name: "stable memo prop: unknown",
      code: dedent`
        local Child = React.memo(function() return React.createElement("Frame") end)
        local function Component(props)
          local factory = props.factory
          return React.createElement(Child, { value = factory({}) })
        end
      `,
    },
    {
      name: "stable memo prop: result",
      code: dedent`
        local Child = React.memo(function() return React.createElement("Frame") end)
        local constant = {}
        local function Component(props)
          local localApi = { GetChildren = function() return constant end }
          return React.createElement(Child, { value = localApi:GetChildren() })
        end
      `,
    },
    {
      name: "stable memo prop: recursive",
      code: dedent`
        local Child = React.memo(function() return React.createElement("Frame") end)
        local function recursive() return recursive() end
        local function Component(props)
          return React.createElement(Child, { value = recursive() })
        end
      `,
    },
    {
      name: "stable memo prop: conditionOnly",
      code: dedent`
        local Child = React.memo(function() return React.createElement("Frame") end)
        local function Component(props)
          return React.createElement(Child, { value = {} ~= props.value })
        end
      `,
    },
    {
      name: "stable memo prop: forwarded",
      code: dedent`
        local Child = React.memo(function() return React.createElement("Frame") end)
        local function Component(props)
          return React.createElement(Child, { value = setmetatable({}, props.metatable) })
        end
      `,
    },
    {
      name: "module lifetime props",
      code: dedent`
        local Child = React.memo(function() return React.createElement("Frame") end)
        local constantProps = { value = {} }
        local function Component()
          return React.createElement(Child, constantProps)
        end
      `,
    },
  ],
  invalid: [
    {
      name: "fresh props passed to a shallow memo child",
      files: {
        "Component.luau": dedent`
          local MemoChild = require(script.Parent.MemoChild)
          local function Component(props)
            return React.createElement(MemoChild, {
              native = { Size = UDim2.fromScale(1, 1) },
              onClick = function() print(props.value) end,
            })
          end
        `,
        "MemoChild.luau": dedent`
          return React.memo(function(props) return React.createElement("Frame", { Size = props.native.Size }) end)
        `,
      },
      errors: [
        { line: 4, column: 5, endLine: 4, endColumn: 11, message: "Memoized MemoChild can receive fresh native, onClick props when its parent renders", file: "Component.luau", highlights: [{"line":4,"column":5,"endLine":4,"endColumn":11},{"line":5,"column":5,"endLine":5,"endColumn":12}], category: "Performance" },
      ],
    },
    {
      name: "fresh memo prop: tableAlias",
      files: {
        "Component.luau": dedent`
          local React = require(script.Parent.React)
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local function Component(props)
            local value = {}
            local alias = value
            return React.createElement(ChildAlias, { tableAlias = alias })
          end
        `,
        "Child.luau": dedent`
          local React = require(script.Parent.React)
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 7, column: 44, endLine: 7, endColumn: 54, message: "Memoized ChildAlias can receive fresh tableAlias prop when its parent renders", file: "Component.luau", highlights: [{"line":7,"column":44,"endLine":7,"endColumn":54}] },
      ],
    },
    {
      name: "fresh memo prop: callback",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local function Component(props)
            local function callback() end
            return React.createElement(ChildAlias, { callback = callback })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 5, column: 44, endLine: 5, endColumn: 52, message: "Memoized ChildAlias can receive fresh callback prop when its parent renders", file: "Component.luau", highlights: [{"line":5,"column":44,"endLine":5,"endColumn":52}] },
      ],
    },
    {
      name: "fresh memo prop: conditional",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local function Component(props)
            return React.createElement(ChildAlias, { conditional = props.enabled and {} or {} })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 4, column: 44, endLine: 4, endColumn: 55, message: "Memoized ChildAlias can receive fresh conditional prop when its parent renders", file: "Component.luau", highlights: [{"line":4,"column":44,"endLine":4,"endColumn":55}] },
      ],
    },
    {
      name: "fresh memo prop: optional",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local function Component(props)
            return React.createElement(ChildAlias, { optional = props.enabled and {} })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 4, column: 44, endLine: 4, endColumn: 52, message: "Memoized ChildAlias can receive fresh optional prop when its parent renders", file: "Component.luau", highlights: [{"line":4,"column":44,"endLine":4,"endColumn":52}] },
      ],
    },
    {
      name: "fresh memo prop: choice",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local function Component(props)
            return React.createElement(ChildAlias, {
              choice = if props.enabled then props.value elseif props.other then {} else nil,
            })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 5, column: 5, endLine: 5, endColumn: 11, message: "Memoized ChildAlias can receive fresh choice prop when its parent renders", file: "Component.luau", highlights: [{"line":5,"column":5,"endLine":5,"endColumn":11}] },
      ],
    },
    {
      name: "fresh memo prop: wrapped",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local function Component(props)
            return React.createElement(ChildAlias, { wrapped = (({} :: any)) })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 4, column: 44, endLine: 4, endColumn: 51, message: "Memoized ChildAlias can receive fresh wrapped prop when its parent renders", file: "Component.luau", highlights: [{"line":4,"column":44,"endLine":4,"endColumn":51}] },
      ],
    },
    {
      name: "fresh memo prop: cloned",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local clone = table.clone
          local function Component(props)
            return React.createElement(ChildAlias, { cloned = clone(props.value) })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 5, column: 44, endLine: 5, endColumn: 50, message: "Memoized ChildAlias can receive fresh cloned prop when its parent renders", file: "Component.luau", highlights: [{"line":5,"column":44,"endLine":5,"endColumn":50}] },
      ],
    },
    {
      name: "fresh memo prop: created",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local tables = table
          local function Component(props)
            return React.createElement(ChildAlias, { created = tables.create(2) })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 5, column: 44, endLine: 5, endColumn: 51, message: "Memoized ChildAlias can receive fresh created prop when its parent renders", file: "Component.luau", highlights: [{"line":5,"column":44,"endLine":5,"endColumn":51}] },
      ],
    },
    {
      name: "fresh memo prop: packed",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local function Component(props)
            return React.createElement(ChildAlias, { packed = table.pack(props.value) })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 4, column: 44, endLine: 4, endColumn: 50, message: "Memoized ChildAlias can receive fresh packed prop when its parent renders", file: "Component.luau", highlights: [{"line":4,"column":44,"endLine":4,"endColumn":50}] },
      ],
    },
    {
      name: "fresh memo prop: frozen",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local function Component(props)
            return React.createElement(ChildAlias, { frozen = table.freeze({}) })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 4, column: 44, endLine: 4, endColumn: 50, message: "Memoized ChildAlias can receive fresh frozen prop when its parent renders", file: "Component.luau", highlights: [{"line":4,"column":44,"endLine":4,"endColumn":50}] },
      ],
    },
    {
      name: "fresh memo prop: factory",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local function build() local result = {} return result end
          local factory = build
          local function Component(props)
            return React.createElement(ChildAlias, { factory = build() })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 6, column: 44, endLine: 6, endColumn: 51, message: "Memoized ChildAlias can receive fresh factory prop when its parent renders", file: "Component.luau", highlights: [{"line":6,"column":44,"endLine":6,"endColumn":51}] },
      ],
    },
    {
      name: "fresh memo prop: factoryAlias",
      files: {
        "Component.luau": dedent`
          local React = require(script.Parent.React)
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local function build() local result = {} return result end
          local factory = build
          local function Component(props)
            return React.createElement(ChildAlias, { factoryAlias = factory() })
          end
        `,
        "Child.luau": dedent`
          local React = require(script.Parent.React)
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 7, column: 44, endLine: 7, endColumn: 56, message: "Memoized ChildAlias can receive fresh factoryAlias prop when its parent renders", file: "Component.luau", highlights: [{"line":7,"column":44,"endLine":7,"endColumn":56}] },
      ],
    },
    {
      name: "fresh memo prop: captured",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local function Component(props)
            local value = {}
            local alias = value
            local function captured() return alias end
            return React.createElement(ChildAlias, { captured = captured() })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 7, column: 44, endLine: 7, endColumn: 52, message: "Memoized ChildAlias can receive fresh captured prop when its parent renders", file: "Component.luau", highlights: [{"line":7,"column":44,"endLine":7,"endColumn":52}] },
      ],
    },
    {
      name: "fresh memo prop: multiple",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local function pair() return nil, {} end
          local function Component(props)
            local first, second = pair()
            return React.createElement(ChildAlias, { multiple = second })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 6, column: 44, endLine: 6, endColumn: 52, message: "Memoized ChildAlias can receive fresh multiple prop when its parent renders", file: "Component.luau", highlights: [{"line":6,"column":44,"endLine":6,"endColumn":52}] },
      ],
    },
    {
      name: "fresh memo prop: returnedFunction",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local function makeCallback() return function() end end
          local function Component(props)
            return React.createElement(ChildAlias, { returnedFunction = makeCallback() })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 5, column: 44, endLine: 5, endColumn: 60, message: "Memoized ChildAlias can receive fresh returnedFunction prop when its parent renders", file: "Component.luau", highlights: [{"line":5,"column":44,"endLine":5,"endColumn":60}] },
      ],
    },
    {
      name: "fresh memo prop: params",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local newParams = RaycastParams.new
          local function Component(props)
            return React.createElement(ChildAlias, { params = newParams() })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 5, column: 44, endLine: 5, endColumn: 50, message: "Memoized ChildAlias can receive fresh params prop when its parent renders", file: "Component.luau", highlights: [{"line":5,"column":44,"endLine":5,"endColumn":50}] },
      ],
    },
    {
      name: "fresh memo prop: overlap",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local function Component(props)
            return React.createElement(ChildAlias, { overlap = OverlapParams.new() })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 4, column: 44, endLine: 4, endColumn: 51, message: "Memoized ChildAlias can receive fresh overlap prop when its parent renders", file: "Component.luau", highlights: [{"line":4,"column":44,"endLine":4,"endColumn":51}] },
      ],
    },
    {
      name: "fresh memo prop: random",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local function Component(props)
            return React.createElement(ChildAlias, { random = Random.new() })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 4, column: 44, endLine: 4, endColumn: 50, message: "Memoized ChildAlias can receive fresh random prop when its parent renders", file: "Component.luau", highlights: [{"line":4,"column":44,"endLine":4,"endColumn":50}] },
      ],
    },
    {
      name: "fresh memo prop: buffer",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local function Component(props)
            return React.createElement(ChildAlias, { buffer = buffer.create(4) })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 4, column: 44, endLine: 4, endColumn: 50, message: "Memoized ChildAlias can receive fresh buffer prop when its parent renders", file: "Component.luau", highlights: [{"line":4,"column":44,"endLine":4,"endColumn":50}] },
      ],
    },
    {
      name: "fresh memo prop: split",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local function Component(props)
            return React.createElement(ChildAlias, { split = string.split(props.text, ",") })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 4, column: 44, endLine: 4, endColumn: 49, message: "Memoized ChildAlias can receive fresh split prop when its parent renders", file: "Component.luau", highlights: [{"line":4,"column":44,"endLine":4,"endColumn":49}] },
      ],
    },
    {
      name: "fresh memo prop: children",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local target = workspace
          local function Component(props)
            return React.createElement(ChildAlias, { children = target:GetChildren() })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 5, column: 44, endLine: 5, endColumn: 52, message: "Memoized ChildAlias can receive fresh children prop when its parent renders", file: "Component.luau", highlights: [{"line":5,"column":44,"endLine":5,"endColumn":52}] },
      ],
    },
    {
      name: "fresh memo prop: descendants",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local function Component(props)
            return React.createElement(ChildAlias, { descendants = workspace:GetDescendants() })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 4, column: 44, endLine: 4, endColumn: 55, message: "Memoized ChildAlias can receive fresh descendants prop when its parent renders", file: "Component.luau", highlights: [{"line":4,"column":44,"endLine":4,"endColumn":55}] },
      ],
    },
    {
      name: "fresh memo prop: attributes",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local function Component(props)
            return React.createElement(ChildAlias, { attributes = script:GetAttributes() })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 4, column: 44, endLine: 4, endColumn: 54, message: "Memoized ChildAlias can receive fresh attributes prop when its parent renders", file: "Component.luau", highlights: [{"line":4,"column":44,"endLine":4,"endColumn":54}] },
      ],
    },
    {
      name: "fresh memo prop: instance",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local function Component(props)
            return React.createElement(ChildAlias, { instance = Instance.new("Folder") })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 4, column: 44, endLine: 4, endColumn: 52, message: "Memoized ChildAlias can receive fresh instance prop when its parent renders", file: "Component.luau", highlights: [{"line":4,"column":44,"endLine":4,"endColumn":52}] },
      ],
    },
    {
      name: "fresh memo prop: cloneInstance",
      files: {
        "Component.luau": dedent`
          local Child = require(script.Parent.Child)
          local ChildAlias = Child
          local function Component(props)
            return React.createElement(ChildAlias, { cloneInstance = workspace:Clone() })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 4, column: 44, endLine: 4, endColumn: 57, message: "Memoized ChildAlias can receive fresh cloneInstance prop when its parent renders", file: "Component.luau", highlights: [{"line":4,"column":44,"endLine":4,"endColumn":57}] },
      ],
    },
    {
      name: "fresh prop on a local memo component",
      files: {
        "Component.luau": dedent`
          local LocalChild = React.memo(function() return React.createElement("Frame") end)
          local function build() local result = {} return result end
          local function Component(props)
            return React.createElement("Frame", nil, { localChild = React.createElement(LocalChild, { config = build() }) })
          end
        `,
        "Child.luau": dedent`
          return React.memo(function() return React.createElement("Frame") end)
        `,
      },
      errors: [
        { line: 4, column: 93, endLine: 4, endColumn: 99, message: "Memoized LocalChild can receive fresh config prop when its parent renders", file: "Component.luau", highlights: [{"line":4,"column":93,"endLine":4,"endColumn":99}] },
      ],
    },
  ],
});
