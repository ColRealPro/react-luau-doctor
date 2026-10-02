local ReplicatedStorage = game:GetService("ReplicatedStorage")
local React = require(ReplicatedStorage.Packages.React)
local useGuiProperty = require(script.Parent.useGuiProperty)

-- Both components intentionally trigger prefer-binding-over-state.
-- Compare these with good-component.luau and inspect each hook call with `why`.

-- props.sourceRef points to another ScrollingFrame whose scroll position we mirror.
-- Exact preview: adding true is enough because CanvasPosition accepts a Binding.
local function MirroredScroll(props)
    local canvasPosition = useGuiProperty(props.sourceRef, "CanvasPosition", Vector2.zero)

    return React.createElement("ScrollingFrame", {
        Size = UDim2.fromScale(1, 1),
        CanvasSize = UDim2.fromOffset(0, 1000),
        CanvasPosition = canvasPosition,
    })
end

-- Derived preview: enable Binding mode and move the X/Y calculation into :map.
local function MeasuredDescription(props)
    local descriptionRef = React.useRef(nil)
    local textBounds = useGuiProperty(descriptionRef, "TextBounds", Vector2.zero)

    return React.createElement("Frame", {
        BackgroundTransparency = 1,
        Size = UDim2.fromOffset(textBounds.X, textBounds.Y),
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
