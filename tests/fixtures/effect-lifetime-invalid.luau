local React = require(script.Parent.React)
local RunService = game:GetService("RunService")
local ContextActionService = game:GetService("ContextActionService")

local function EffectLifetimeInvalid()
	React.useEffect(function()
		task.spawn(function()
			task.wait(1)
			print("outlives effect")
		end)
	end, {})

	React.useEffect(function()
		task.defer(function()
			print("deferred")
		end)
	end, {})

	React.useEffect(function()
		task.delay(1, function()
			print("delayed")
		end)
	end, {})

	React.useEffect(function()
		ContextActionService:BindActivate(Enum.UserInputType.Gamepad1, Enum.KeyCode.ButtonA)
	end, {})

	React.useEffect(function()
		RunService:BindToSimulation(function()
			print("simulation")
		end)
	end, {})

	return React.createElement("Frame")
end

return EffectLifetimeInvalid
