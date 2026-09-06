local React = require(script.Parent.React)
local RunService = game:GetService("RunService")
local TweenService = game:GetService("TweenService")

local function BadCounter(props: { enabled: boolean, title: string })
    local count, setCount = React.useState(0)

    if props.enabled then
        React.useEffect(function()
            print(count)
        end, {})
    end

    React.useEffect(function()
        local connection = RunService.Heartbeat:Connect(function()
            print(props.title)
        end)
    end, {})

    RunService.RenderStepped:Connect(function(dt)
        setCount(count + dt)
    end)

    props.title = "mutated"
    Instance.new("Frame")
    task.spawn(function()
        print("bad")
    end)
    task.wait()

    local tween = TweenService:Create(workspace, TweenInfo.new(1), {})
    tween:Play()

    local children = {}
    for index, item in ipairs(props.items) do
        children[index] = React.createElement("TextLabel", {
            Text = item.name,
        })
    end

    return React.createElement("Frame", nil, children)
end

return BadCounter
