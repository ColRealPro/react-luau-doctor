local React = require(script.Parent.React)
local RunService = game:GetService("RunService")

local function Child(props)
	return React.createElement("TextLabel", {
		Text = tostring(props.Value),
	})
end

local function useTrackedSize()
	local size, setSize = React.useState(Vector2.zero)

	React.useEffect(function()
		local connection = RunService.RenderStepped:Connect(function(dt)
			setSize(Vector2.new(dt, dt))
		end)
		return function()
			connection:Disconnect()
		end
	end, {})

	return size
end

local function BindingCandidate()
	local position, setPosition = React.useState(UDim2.fromScale(0, 0))

	React.useEffect(function()
		local connection = RunService.RenderStepped:Connect(function(dt)
			setPosition(UDim2.fromScale(dt, dt))
		end)
		return function()
			connection:Disconnect()
		end
	end, {})

	return React.createElement("Frame", {
		Position = position,
	})
end

local function HookBindingCandidate()
	local size = useTrackedSize()

	return React.createElement("Frame", {
		Size = UDim2.fromOffset(size.X, size.Y),
	})
end

local function TreeState()
	local visible, setVisible = React.useState(false)

	React.useEffect(function()
		local connection = RunService.RenderStepped:Connect(function(dt)
			setVisible(dt > 0)
		end)
		return function()
			connection:Disconnect()
		end
	end, {})

	return React.createElement("Frame", {}, {
		child = visible and React.createElement("TextLabel") or nil,
	})
end

local function CustomPropState()
	local currentTime, setCurrentTime = React.useState(0)

	React.useEffect(function()
		local connection = RunService.RenderStepped:Connect(function(dt)
			setCurrentTime(dt)
		end)
		return function()
			connection:Disconnect()
		end
	end, {})

	return React.createElement(Child, {
		Value = currentTime,
	})
end

return function()
	return React.createElement(React.Fragment, nil, {
		BindingCandidate = React.createElement(BindingCandidate),
		HookBindingCandidate = React.createElement(HookBindingCandidate),
		TreeState = React.createElement(TreeState),
		CustomPropState = React.createElement(CustomPropState),
	})
end
