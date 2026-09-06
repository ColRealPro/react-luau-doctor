local React = require(script.Parent.React)

local function useDynamicEffect(callback, bindings, deps)
	React.useEffect(function()
		callback(bindings)
	end, { unpack(bindings), unpack(deps or {}) })
end

local function DependencyConfidence(props)
	local memoizedValue = React.useMemo(function()
		return props.value * 2
	end, { props.value })

	local memoizedCallback = React.useCallback(function()
		print(props.enabled)
	end, { props.enabled })

	React.useEffect(function()
		print(memoizedValue)
		memoizedCallback()
	end, { props.value, props.enabled })

	React.useEffect(function()
		print(memoizedValue)
	end, {})

	local derivedValue = props.value or 0
	local isComplete = props.count >= props.total
	local h, s = props.color:ToHSV()

	React.useEffect(function()
		print(derivedValue, h, s)
	end, { props.value, props.color })

	React.useEffect(function()
		print(isComplete)
	end, { props.count })

	return React.createElement("Frame")
end

return {
	useDynamicEffect = useDynamicEffect,
	DependencyConfidence = DependencyConfidence,
}
