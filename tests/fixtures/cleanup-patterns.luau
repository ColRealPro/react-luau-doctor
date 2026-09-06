local React = require(script.Parent.React)
local RunService = game:GetService("RunService")

local function CleanupPatterns(props)
    React.useEffect(function()
        local connection = RunService.Heartbeat:Connect(function()
            print(props.value)
        end)

        local function cleanup()
            connection:Disconnect()
        end

        return cleanup
    end, { props })

    React.useEffect(function()
        props.maid:GiveTask(RunService.Heartbeat:Connect(function()
            print("managed")
        end))
    end, { props })

    React.useEffect(function()
        props.trove:Add(RunService.Heartbeat:Connect(function()
            print("managed by trove")
        end))
    end, { props })

    return React.createElement("Frame")
end

return CleanupPatterns
