# React-Luau Doctor

Find React-Luau mistakes before they reach your Roblox UI.

React-Luau Doctor checks `.lua` and `.luau` source files for hook mistakes, missing cleanup, render side effects, and avoidable rerenders. Findings include a category, severity, source location, and repair guidance. The `why` command explains individual findings and shows suggested changes where available.

This beta CLI runs with Bun and analyzes React-Luau source on your computer or CI runner. It does not run inside Roblox Studio, analyze JavaScript/TypeScript React, or edit your code automatically.

## Get started

React-Luau Doctor requires [Bun](https://bun.com/) 1.4.0 or newer. Run it directly from npm with either Bun or npm:

```bash
bunx @colrealpro/react-luau-doctor .
```

```bash
npx @colrealpro/react-luau-doctor .
```

`npx` still requires Bun to be installed because the React-Luau Doctor CLI itself runs with Bun.

For a reusable `react-luau-doctor` command, install it globally with Bun:

```bash
bun add --global @colrealpro/react-luau-doctor
react-luau-doctor .
react-luau-doctor . --verbose
```

To work on React-Luau Doctor itself, clone the repository and use Bun for development:

```bash
git clone https://github.com/colrealpro/react-luau-doctor.git
cd react-luau-doctor
bun install --frozen-lockfile
bun run build
bun run ci
```

## Read a finding

For example, this component changes a prop during render:

```luau
local React = require(script.Parent.React)

local function Label(props)
    props.text = "Changed"
    return React.createElement("TextLabel", { Text = props.text })
end

return Label
```

Doctor reports `react-luau/no-prop-mutation`. Compute a local value instead of writing to `props`.

```bash
react-luau-doctor why src/Label.luau:4
react-luau-doctor rules explain react-luau/no-prop-mutation
```

Suggested changes are review guidance. Some are exact previews, others are example patterns that need adapting to your component.

## What it checks

The rule catalog covers correctness, hooks, effects, performance, Roblox behavior, and architecture. Checks include conditional hooks, incomplete dependency tables, connections without cleanup, state updates during render, fresh props crossing memo boundaries, and externally updated state that may be better represented by a Binding.

```bash
react-luau-doctor rules list
react-luau-doctor . --category Hooks
react-luau-doctor . --blocking error
```

Errors are the highest severity. Warnings identify likely problems, while suggestions include lower-confidence findings that deserve review. You can override each rule's severity or disable it. A clean report is not proof of runtime correctness, and the score is a heuristic, not a performance measurement.

See the [rule catalog](docs/rules.md) and [analysis limits](docs/analysis.md).

## Check a change

```bash
react-luau-doctor . --scope changed --base main
react-luau-doctor . --scope lines --base main
react-luau-doctor . --staged
react-luau-doctor . --json-out doctor-report.json
```

`changed` compares findings against a Git base. `lines` keeps findings that overlap changed lines. `--staged` reads index content, so later unstaged edits do not affect the checked file contents.

## Add CI

From your Roblox repository:

```bash
react-luau-doctor ci install --yes
```

Commit the generated `.github/workflows/react-luau-doctor.yml`. The workflow pins the exact npm version of React-Luau Doctor that generated it and runs that package with Bun, so your repository does not need to vendor the analyzer or its parser assets.

By default, pull requests receive advisory findings without failing the check. Enable a gate with:

```bash
react-luau-doctor ci config --blocking error --yes
```

[CI setup](docs/ci.md) explains permissions, fork PRs, updates, outputs, and GitLab support. Local tests exercise reporting against a simulated GitHub API. A real GitHub Actions run is still required to validate your repository's permissions and runner behavior.

## Configure a project

Create `react-luau-doctor.config.json` in the directory where you run scans:

```json
{
  "include": ["src/**/*.luau"],
  "ignore": ["src/generated/**"],
  "rules": {
    "react-luau/no-array-index-as-key": "off",
    "react-luau/exhaustive-deps": "error"
  }
}
```

Use narrow inline suppressions when an individual finding is intentional:

```luau
-- react-luau-doctor-disable-next-line no-array-index-as-key
```

See the [CLI and configuration reference](docs/cli.md) for scanning, reporting, cache controls, and suppression syntax.

## Contribute

Read [development and release checks](docs/development.md). For a false positive or missed issue, open an [issue](https://github.com/colrealpro/react-luau-doctor/issues) with the smallest Luau example you can share, the tool version, and the relevant configuration.

MIT licensed. Inspired by [React Doctor](https://github.com/millionco/react-doctor); not affiliated with its authors, Roblox, or the React-Luau maintainers. See [third-party notices](THIRD_PARTY_NOTICES.md) for parser attribution.
