local React = require(script.Parent.React)

local function YieldingEngineApis(props)
	local value = props.store:GetAsync("key")
	props.contentProvider:PreloadAsync({})
	local promise = props.client:DoAsync()

	return React.createElement("TextLabel", {
		Text = tostring(value) .. tostring(promise),
	})
end

return YieldingEngineApis
