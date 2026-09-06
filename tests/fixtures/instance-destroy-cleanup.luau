local React = require(script.Parent.React)

local function InstanceDestroyCleanup()
    local numberValue = React.useMemo(function()
        return Instance.new("NumberValue")
    end, {})

    local transparencyValue = React.useMemo(function()
        local value = Instance.new("NumberValue")
        return value
    end, {})

    React.useEffect(function()
        local createdInsideEffect = Instance.new("BindableEvent")

        createdInsideEffect.Event:Connect(function()
            print("inside")
        end)

        numberValue.Changed:Connect(function(value)
            print(value)
        end)

        transparencyValue:GetPropertyChangedSignal("Value"):Connect(function()
            print(transparencyValue.Value)
        end)

        return function()
            createdInsideEffect:Destroy()
            numberValue:Destroy()
            transparencyValue:Destroy()
        end
    end, { numberValue, transparencyValue })

    return React.createElement("Frame")
end

return InstanceDestroyCleanup
