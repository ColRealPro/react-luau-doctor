local React = require(script.Parent.React)

local function RefMirrorPatterns(props)
	local mirrored = React.useRef(nil)
	local imperative = React.useRef(nil)

	for _, item in props.items do
		if item.selected then
			mirrored.current = item.id
		end
	end

	if imperative.current then
		imperative.current = props.value
	end

	React.useEffect(function()
		print(mirrored.current)
	end, {})

	return React.createElement("Frame")
end

return RefMirrorPatterns
