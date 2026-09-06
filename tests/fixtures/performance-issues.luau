local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local React = require(ReplicatedStorage.Packages.React)
local MemoChild = require(script.Parent.MemoChild)

local function PerformanceIssues(props)
	local currentTime, setCurrentTime = React.useState(0)
	local textColor, setTextColor = React.useState(Color3.fromRGB(255, 255, 255))
	local userName = React.useMemo(function()
		return props.name
	end, { props.name })
	local safeClamp = React.useCallback(function(value)
		return math.clamp(value, 0, 1)
	end, {})
	local parentFrameRef = React.useMemo(function()
		return { current = nil }
	end, {})

	RunService.RenderStepped:Connect(function(dt)
		setCurrentTime(currentTime + dt)
	end)

	local modules = {}
	for _, module in ReplicatedStorage.Shared.Modules:GetChildren() do
		modules[module.Name] = require(module)
	end

	for _, item in props.items or {} do
		print(item)
	end
	for _, item in props.items or {} do
		print(item.Name)
	end

	return React.createElement("Frame", nil, {
		Child = React.createElement(MemoChild, {
			native = { Size = UDim2.fromScale(1, 1) },
			onClick = function()
				print(userName, safeClamp(currentTime), textColor, parentFrameRef.current, modules)
			end,
		}),
	})
end

return PerformanceIssues
