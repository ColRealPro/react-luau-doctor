# CLI and configuration

Run commands from your project folder so Doctor picks up its config

## Scan your code

```bash
react-luau-doctor
react-luau-doctor src/interface --verbose
react-luau-doctor src/interface/Label.luau
```

The default output summarizes findings. `--verbose` shows each finding with its location and guidance

Directory scans look for React-Luau code and skip dependency folders such as `Packages` and `node_modules`. Passing a file checks it even if your include/ignore filters would exclude it

## Configuration

Doctor reads `react-luau-doctor.config.json` from the folder where you run the command

```json
{
  "include": ["src/**/*.luau", "shared/**/*.lua"],
  "ignore": ["src/generated/**"],
  "rules": {
    "react-luau/exhaustive-deps": "error",
    "react-luau/no-array-index-as-key": "off"
  }
}
```

Rule values are `error`, `warning`, `suggestion`, or `off`. Use the full rule ID in config, including `react-luau/`

File patterns are relative to the project root. `*` matches within a folder, `**` matches across folders, and `?` matches one character

You can change a rule from the terminal too:

```bash
react-luau-doctor rules disable no-array-index-as-key
react-luau-doctor rules set exhaustive-deps error
react-luau-doctor rules list
```

## Suppressions

To ignore a finding on the next line:

```luau
-- react-luau-doctor-disable-next-line no-prop-mutation
props.value = "legacy"
```

To disable a rule for a section of code:

```luau
-- react-luau-doctor-disable no-array-index-as-key
-- Your code here
-- react-luau-doctor-enable no-array-index-as-key
```

Comments accept short rule names or full IDs. Use `--no-respect-inline-disables` to include suppressed findings in a scan

## Explain a finding

```bash
react-luau-doctor why src/Label.luau:12
react-luau-doctor rules explain exhaustive-deps
```

`why` explains findings at that location using your project code. `rules explain` shows the rule's explanation and a repair example

## Check changed code

```bash
react-luau-doctor --scope changed --base main
react-luau-doctor --staged
```

| Scope     | What it reports                                 |
| --------- | ----------------------------------------------- |
| `full`    | Findings across the selected files, the default |
| `files`   | Findings in changed files                       |
| `changed` | Findings that were not in the Git baseline      |
| `lines`   | Findings on changed lines                       |

Use `--base` to choose the Git baseline. Add `--include-untracked` to include new files that Git hasn't tracked yet

`--staged` checks the staged file contents. Other files in the working tree still provide project context

## Output and exit codes

```bash
react-luau-doctor --json --json-compact
react-luau-doctor --json-out doctor-report.json
react-luau-doctor --blocking warning
```

`--json` prints a report for scripts. `--json-out` writes it to a file. `--output-dir .doctor` writes `report.json`, `diagnostics.json`, and `summary.json`

By default, errors make the CLI exit with a nonzero code. `--blocking warning` also fails for warnings. `--blocking none` lets findings pass without failing the command

To narrow the output, use `--category Hooks`, `--min-severity warning`, or `--no-warnings` for errors only

Run `react-luau-doctor --help` for the full option list
