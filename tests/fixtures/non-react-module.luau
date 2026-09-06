local RunService = game:GetService("RunService")

local function GameplayController()
    Instance.new("Part")
    task.spawn(function()
        task.wait()
    end)
    RunService.RenderStepped:Connect(function()
    end)
end

return GameplayController
