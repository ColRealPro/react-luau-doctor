local React = require(script.Parent.React)

local function FirstComponent()
    local ref = React.useRef(nil)

    return React.createElement("Frame", {
        ref = ref,
    })
end

local function SecondComponent(props)
    local value = props.value
    local ref = props.externalRef

    React.useEffect(function()
        local function consume(value)
            print(value)
        end

        consume(1)
        print(props.title)
        print(ref.current)
    end, { props.title, ref.current })

    return React.createElement("TextLabel", {
        Text = tostring(value),
    })
end

return React.createElement(React.Fragment, nil, {
    First = React.createElement(FirstComponent),
    Second = React.createElement(SecondComponent),
})
