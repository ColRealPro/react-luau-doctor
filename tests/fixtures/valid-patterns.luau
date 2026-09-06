local ReplicatedStorage = game:GetService("ReplicatedStorage")
local React = require(ReplicatedStorage.Client.Modules.React)

local createElement = React.createElement
local memo = React.memo
local useEffect = React.useEffect

local useThing = function(value)
    local state, setState = React.useState(value)

    React.useEffect(function()
        print(state)
    end, { state })

    return state, setState
end

local lowerCaseComponent = function(props: { value: number })
    local value = useThing(props.value)
    return createElement("TextLabel", {
        Text = tostring(value),
    })
end

local MemoComponent = memo(function(props: { name: string })
    useEffect(function()
        print(props.name)
    end, { props })

    return createElement(lowerCaseComponent, {
        value = 1,
    })
end)

return MemoComponent
