local ReplicatedStorage = game:GetService("ReplicatedStorage")
local React = require(ReplicatedStorage.Packages.React)

local function MemoChildCustom(props)
	return React.createElement("Frame", { Name = tostring(props.value) })
end

return React.memo(MemoChildCustom, function(previous, next)
	return previous.value == next.value
end)
