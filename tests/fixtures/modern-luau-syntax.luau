local ReplicatedStorage = game:GetService("ReplicatedStorage")
local React = require(ReplicatedStorage.Packages.React)

type function IdentityType(value)
	return value
end

declare extern type NativeHandle with
	read Id: number
end

@[deprecated("legacy helper")]
local function legacyHelper(value)
	return value
end

@native
export const Component = function(props)
	const doubled: number = props.value * 2
	const memoized = React.useMemo(function()
		return legacyHelper(doubled)
	end, { doubled })
	const identity = function<T>(value: T): T
		return value
	end
	const typed = identity<<number>>(memoized)
	const integer = 123i
	const groupedInteger = 1_000i
	const hexadecimalInteger = 0xABABi
	const binaryInteger = 0b1000_1000i
	props.value = typed

	return React.createElement("TextLabel", {
		Text = tostring(typed),
	})
end

