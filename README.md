# React-Luau Doctor

Static analysis tool for React-Luau codebases. It helps identify potential issues, enforce best practices, and improve React code quality.

React-Luau Doctor scans your codebase and finds mistakes in hooks, effects, state management, and performance. Rules are built specifically around React-Luau patterns, including problems that can't be caught by traditional typechecking or linting. It works as a CLI or CI tool. Editor diagnostics can also be provided through the [LSP](docs/lsp.md) extension

## Getting started

React-Luau Doctor requires [Bun](https://bun.com/) 1.4.0 or newer. You can run it directly from npm with:

```bash
npx @colrealpro/react-luau-doctor
```

or install it globally and run it normally:

```bash
bun add --global @colrealpro/react-luau-doctor
react-luau-doctor
```

This will create a short overview of your project, and report the highest severity issues, you can add `--verbose` to see all the findings

## Examples

```lua
local React = require("..path/to/React")
local RunService = game:GetService("RunService")

local function PlayerList(props)
	local playerCount, setPlayerCount = React.useState(0)
	local absolutePosition, setAbsolutePosition = React.useState(
		props.container.AbsolutePosition
	)

	local labelText = React.useMemo(function()
		return `Players: {playerCount}`
	end, { playerCount })

	React.useEffect(function()
		setPlayerCount(#props.players)
	end, { props.players })

	React.useEffect(function()
		props.container:GetPropertyChangedSignal("AbsolutePosition"):Connect(function()
			setAbsolutePosition(props.container.AbsolutePosition)
		end)
	end, { props.container })

	if props.hidden then
		return nil
	end

	React.useEffect(function()
		print(props.title)
	end, { props.title })

	return React.createElement("TextLabel", {
		Text = labelText,
		Position = UDim2.fromOffset(absolutePosition.X, absolutePosition.Y),
	})
end
```

React-Luau Doctor would report the following for this component:

```
src/PlayerList.lua

  X error    Hook React.useEffect may run after an earlier reachable return,
             so some renders can execute fewer hooks.
             react-luau/rules-of-hooks

  ! warning  setPlayerCount() stores a value derived from props inside an effect.
             react-luau/no-derived-state-effect

  ! warning  State absolutePosition mirrors AbsolutePosition and only feeds
             presentation updates, so React reconciliation is acting as an
             unnecessary host-property feedback step.
             react-luau/prefer-binding-over-state

  ! warning  Effect creates a connection or subscription without matching cleanup.
             react-luau/effect-needs-cleanup

  ! warning  useMemo caches a trivial derived value.
             react-luau/rerender-unnecessary-usememo
```

## Editor support

React-Luau Doctor provides a LSP extension for VS Code

The LSP uses the same analysis as the CLI, and updates findings in real time as you edit your code

See [LSP](docs/lsp.md) for installation and configuration

## CI

React-Luau Doctor also provides a CI that can be used to run analysis on your codebase and report findings in PRs, or be used to block merging if doctor finds issues (can't promise satisfaction on blocking merging though yet)

Install it with:

```bash
react-luau-doctor ci install
```

It will bring you through a couple options, you can skip it and use the defaults by adding `--yes` to the command

## Configuring rules

Create a `react-luau-doctor.config.json` file in your project:

```json
{
  "ignore": [
    "**/*.story.lua",
    "**/*.story.luau"
  ],
  "rules": {
    "react-luau/no-array-index-as-key": "off",
    "react-luau/exhaustive-deps": "error"
  }
}
```

This will let you enable and disable some rules or change their severity to your liking if you dislike some of the rules.

Inline disables can also be used when a finding is intentional:
```lua
-- react-luau-doctor-disable-next-line no-array-index-as-key
```

## Contributing

All contributions are welcome! Bug fixes, new rules, improvements to existing rules, and documentation changes are all appreciated!

Feel free to open an issue for bugs or feature requests, or submit a pull request


MIT licensed. Inspired by [React Doctor](https://github.com/millionco/react-doctor); not affiliated with its authors, Roblox, or the React-Luau maintainers. See [third-party notices](THIRD_PARTY_NOTICES.md) for parser attribution.
