local ReplicatedStorage = game:GetService("ReplicatedStorage")
local React = require(ReplicatedStorage.Packages.React)

local function MemoChild(props)
	return React.createElement("Frame", {
		Size = props.native and props.native.Size,
		[React.Event.Activated] = props.onClick,
	})
end

local MemoizedMemoChild = React.memo(MemoChild)
return MemoizedMemoChild
