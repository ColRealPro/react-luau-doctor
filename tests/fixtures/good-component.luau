local React = require(script.Parent.React)
local RunService = game:GetService("RunService")

local function GoodCounter(props: { title: string })
    local count, setCount = React.useState(0)
    local animatedCount, setAnimatedCount = React.useBinding(0)

    React.useEffect(function()
        local connection = RunService.RenderStepped:Connect(function(dt)
            setAnimatedCount(animatedCount:getValue() + dt)
        end)

        return function()
            connection:Disconnect()
        end
    end, { animatedCount, setAnimatedCount })

    return React.createElement("TextLabel", {
        Text = `{props.title}: {count}`,
        [React.Event.Activated] = function()
            setCount(function(value)
                return value + 1
            end)
        end,
    })
end

return GoodCounter
