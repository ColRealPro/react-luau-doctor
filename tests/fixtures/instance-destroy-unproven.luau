local React = require(script.Parent.React)

local function UnprovenDestroy(props)
    React.useEffect(function()
        props.customSignal.Changed:Connect(function()
            print("custom")
        end)

        return function()
            props.customSignal:Destroy()
        end
    end, { props })

    return React.createElement("Frame")
end

return UnprovenDestroy
