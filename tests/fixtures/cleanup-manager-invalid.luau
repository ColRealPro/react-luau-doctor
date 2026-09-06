local React = require(script.Parent.React)
local RunService = game:GetService("RunService")

local function CleanupManagerInvalid(props)
    React.useEffect(function()
        props.list:Add(RunService.Heartbeat:Connect(function()
            print("not a cleanup manager")
        end))
    end, { props })

    return React.createElement("Frame")
end

return CleanupManagerInvalid
