local React = require(script.Parent.React)
local RunService = game:GetService("RunService")

local StableContext = React.createContext(nil)

local function buildInitialItems()
    return {}
end

local function Card(props: { id: string, text: string })
    return React.createElement("TextLabel", {
        Text = props.text,
    })
end

local function AdvancedValid(props: { id: string, value: number })
    local count, setCount = React.useState(0)
    local items, setItems = React.useState(function()
        return buildInitialItems()
    end)
    local frameRef = React.useRef(nil)
    local animated, setAnimated = React.useBinding(0)

    if frameRef.current == nil then
        frameRef.current = {}
    end

    local contextValue = React.useMemo(function()
        return {
            count = count,
        }
    end, { count })

    React.useEffect(function()
        local connection = RunService.RenderStepped:Connect(function(dt)
            setAnimated(animated:getValue() + dt)
        end)

        return function()
            connection:Disconnect()
        end
    end, { animated, setAnimated })

    local function onActivated()
        setCount(function(previous)
            return previous + 1
        end)
        setItems(function(previous)
            local nextItems = table.clone(previous)
            nextItems[props.id] = props.value
            return nextItems
        end)
    end

    return React.createElement(StableContext.Provider, {
        value = contextValue,
    }, {
        Card = React.createElement(Card, {
            key = props.id,
            id = props.id,
            text = tostring(count) .. ":" .. tostring(#items),
        }),
        Button = React.createElement("TextButton", {
            [React.Event.Activated] = onActivated,
        }),
    })
end

return AdvancedValid
