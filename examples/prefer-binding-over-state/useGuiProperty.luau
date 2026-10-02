local ReplicatedStorage = game:GetService("ReplicatedStorage")
local React = require(ReplicatedStorage.Packages.React)

-- The final argument selects state (omitted/false) or Binding (true).
-- Keep this mode constant for the lifetime of each hook call.
local function useGuiProperty(targetRef, property, initialValue, binding: boolean?)
    local value, updateValue

    if binding then
        value, updateValue = React.useBinding(initialValue)
    else
        value, updateValue = React.useState(initialValue)
    end

    React.useEffect(function()
        local instance = targetRef.current

        if not instance then
            return
        end

        local function update()
            updateValue(instance[property])
        end

        local connection = instance:GetPropertyChangedSignal(property):Connect(update)
        update()

        return function()
            connection:Disconnect()
        end
    end, { targetRef, property })

    return value
end

return useGuiProperty
