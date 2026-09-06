local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local React = require(ReplicatedStorage.Packages.React)

export type Props = {
	number: number,
	binding: typeof(React.useBinding(0)),
}

type Container<T = string> = {
	value: T,
}

type = "Normal"

local function BuildObject()
	local folder = Instance.new("Folder")
	task.spawn(function()
		folder.Name = "Built"
	end)
	return folder
end

local function DeepCopy(input)
	local copy = {}
	for key, value in input do
		copy[key] = value
	end
	return copy
end

return function(props: Props)
	local position, setPosition = React.useState(UDim2.fromScale(0, 0))
	local valueRef = React.useRef(props.binding:getValue())
	local count, setCount = React.useState(0)

	React.useEffect(function()
		local connection
		connection = RunService.Heartbeat:Connect(function()
			setPosition(UDim2.fromOffset(1, 1))
			setPosition(UDim2.fromOffset(2, 2))

			local count = 10
			count += 1
		end)

		return function()
			connection:Disconnect()
		end
	end, {})

	return React.createElement("Frame", {
		Position = position,
		LayoutOrder = count,
		[React.Tag] = tostring(valueRef.current),
	})
end
