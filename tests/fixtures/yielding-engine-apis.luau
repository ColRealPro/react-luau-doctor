local React = require(script.Parent.React)
local DataStoreService = game:GetService("DataStoreService")
local ContentProvider = game:GetService("ContentProvider")
local store = DataStoreService:GetDataStore("doctor-yield-test")

local function YieldingEngineApis(props)
	local value = store:GetAsync("key")
	ContentProvider:PreloadAsync({})
	local promise = props.client:DoAsync()
	local custom = props.cache:GetAsync("key")

	return React.createElement("TextLabel", {
		Text = tostring(value) .. tostring(promise) .. tostring(custom),
	})
end

return YieldingEngineApis
