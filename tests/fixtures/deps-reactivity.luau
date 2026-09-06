local React = require(script.Parent.React)

local function DependencyReactivity(props)
	local ref = React.useRef(nil)
	local binding = React.useBinding(0)
	local numberValue = React.useMemo(function()
		return Instance.new("NumberValue")
	end, {})

	React.useEffect(function()
		print(ref.current)
		print(binding:getValue())
		print(numberValue.Value)
		numberValue.Changed:Connect(function()
			print(numberValue.Value)
		end)
		print(props.Instance.CFrame)
		print(props.value)

		return function()
			numberValue:Destroy()
		end
	end, {})

	return React.createElement("Frame")
end

return DependencyReactivity
