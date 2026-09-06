local ReplicatedStorage = game:GetService("ReplicatedStorage")
local React = require(ReplicatedStorage.Packages.React)

local function InlineDisables(props)
	local value, setValue = React.useState(0)

	-- react-luau-doctor-disable-next-line no-prop-mutation
	props.value = 1

	-- react-luau-doctor-disable react-luau/no-prop-mutation
	props.other = 2
	-- react-luau-doctor-enable react-luau/no-prop-mutation
	props.third = 3

	return React.createElement("TextLabel", {
		Text = tostring(value),
		[React.Event.Activated] = function()
			setValue(value + 1)
		end,
	})
end

return InlineDisables
