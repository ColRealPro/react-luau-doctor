local ReplicatedStorage = game:GetService("ReplicatedStorage")
local React = require(ReplicatedStorage.Packages.React)
local useGuiProperty = require(script.Parent.useGuiProperty)

-- Direct fix: the hook returns a Binding and the host property consumes it directly.
local function MirroredScroll(props)
    local canvasPosition = useGuiProperty(props.sourceRef, "CanvasPosition", Vector2.zero, true)

    return React.createElement("ScrollingFrame", {
        Size = UDim2.fromScale(1, 1),
        CanvasSize = UDim2.fromOffset(0, 1000),
        CanvasPosition = canvasPosition,
    })
end

-- Derived fix: :map transforms each measurement into a Size without a React rerender.
local function MeasuredDescription(props)
    local descriptionRef = React.useRef(nil)
    local textBounds = useGuiProperty(descriptionRef, "TextBounds", Vector2.zero, true)

    local size = textBounds:map(function(bounds)
        return UDim2.fromOffset(bounds.X, bounds.Y)
    end)

    return React.createElement("Frame", {
        BackgroundTransparency = 1,
        Size = size,
    }, {
        Description = React.createElement("TextLabel", {
            ref = descriptionRef,
            AutomaticSize = Enum.AutomaticSize.XY,
            BackgroundTransparency = 1,
            Size = UDim2.fromOffset(0, 0),
            Text = props.text,
            TextSize = 18,
        }),
    })
end

return {
    MirroredScroll = MirroredScroll,
    MeasuredDescription = MeasuredDescription,
}
