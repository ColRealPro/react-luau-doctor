local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local React = require(ReplicatedStorage.Packages.React)
local MemoChildCustom = require(script.Parent.MemoChildCustom)

local function PerformanceValid(props)
	local edge, setEdge = React.useState("None")
	local value, setValue = React.useState(0)
	local seed = React.useMemo(function()
		return math.random()
	end, {})
	local cachedCallback = React.useMemo(function()
		return props.callback
	end, { props.callback })
	local onClick = React.useCallback(function()
		setValue(function(previous)
			return previous + 1
		end)
	end, {})
	local ref = React.useRef(nil)
	local modules = React.useMemo(function()
		return ReplicatedStorage.Shared.Modules:GetChildren()
	end, {})

	React.useEffect(function()
		cachedCallback()
	end, { cachedCallback })

	RunService.RenderStepped:Connect(function()
		local nextEdge = props.edge
		if edge ~= nextEdge then
			setEdge(nextEdge)
		end
	end)

	for _, item in props.items do
		print(item)
	end
	for _, other in props.otherItems do
		print(other)
	end

	return React.createElement(MemoChildCustom, {
		value = { seed = seed, modules = modules, ref = ref, value = value },
		onClick = onClick,
	})
end

return PerformanceValid
