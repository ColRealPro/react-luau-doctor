local React = require(script.Parent.React)
local ReactRoblox = require(script.Parent.ReactRoblox)
local HttpService = game:GetService("HttpService")

local function buildCache()
    return { created = true }
end

local function AdvancedIssues(props: { value: number, target: Instance, id: string })
    local count, setCount = React.useState(0)
    local items, setItems = React.useState({})
    local handlerOnly, setHandlerOnly = React.useState(0)
    local expensive, setExpensive = React.useState(buildCache())
    local cacheRef = React.useRef(buildCache())

    local LocalContext = React.createContext(nil)
    local options = {}

    setCount(1)
    items.latest = props.value
    table.insert(items, props.value)
    cacheRef.current = buildCache()
    ReactRoblox.createRoot(props.target)

    React.useMemo(function()
        return props.value + count
    end, { count })

    React.useEffect(function()
        setCount(count + 1)
    end, { count, cacheRef.current, options })

    React.useEffect(function()
        setExpensive(props.value * 2)
    end, { props })

    local function NestedCard()
        return React.createElement("TextLabel", {
            Text = tostring(expensive),
        })
    end

    local function onActivated()
        setCount(count + 1)
        setHandlerOnly(handlerOnly + 1)
        print(handlerOnly)
        setItems(items)
    end

    return React.createElement("TextButton", {
        [React.Event.Activated] = onActivated,
    }, {
        Card = React.createElement(NestedCard, {
            key = HttpService:GenerateGUID(false),
        }),
        Context = React.createElement(LocalContext.Provider, {
            value = { count = count },
        }),
    })
end

return AdvancedIssues
