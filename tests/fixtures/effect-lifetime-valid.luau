local React = require(script.Parent.React)
local RunService = game:GetService("RunService")
local ContextActionService = game:GetService("ContextActionService")

local function EffectLifetimeValid(props)
	React.useEffect(function()
		task.spawn(function()
			print("finishes immediately")
		end)
	end, {})

	React.useEffect(function()
		local thread
		thread = task.spawn(function()
			task.wait(1)
			print("later")
		end)

		return function()
			pcall(task.cancel, thread)
		end
	end, {})

	React.useEffect(function()
		local cancelled = false
		task.spawn(function()
			while not cancelled do
				task.wait()
			end
		end)

		return function()
			cancelled = true
		end
	end, {})

	React.useEffect(function()
		local animationMaid = props.maid
		animationMaid:Add(task.spawn(function()
			task.wait(1)
		end))
	end, { props })

	React.useEffect(function()
		local cancelled = false
		task.spawn(function()
			task.wait(1)
			if not cancelled then
				print("still mounted")
			end
		end)
		return function()
			cancelled = true
		end
	end, {})

	React.useEffect(function()
		ContextActionService:BindActivate(Enum.UserInputType.Gamepad1, Enum.KeyCode.ButtonA)
		return function()
			ContextActionService:UnbindActivate(Enum.UserInputType.Gamepad1, Enum.KeyCode.ButtonA)
		end
	end, {})

	React.useEffect(function()
		local connection = RunService:BindToSimulation(function()
			print("simulation")
		end)
		return function()
			connection:Disconnect()
		end
	end, {})

	return React.createElement("Frame")
end

return EffectLifetimeValid
