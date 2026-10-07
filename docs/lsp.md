# VS Code extension

Doctor shows findings in your code and the Problems panel as you edit `.luau` and `.lua` files. You don't need Bun or the CLI to use the installed extension

## Install

In the Extensions panel, open the menu and choose "Install from VSIX...". Select the Doctor `.vsix`, then reload VS Code

Open your project folder and a Luau file to start Doctor

To build the VSIX yourself, see [development](development.md#run-locally)

## Quick fixes

Hover a finding for its explanation and code example. Quick Fix lets you open the explanation in the Doctor terminal, suppress the rule for that line, or disable it for the project

Disabling a rule opens your project config with the change. Save the config to apply it

## Settings

| Setting                              | Default | What it does                                      |
| ------------------------------------ | ------- | ------------------------------------------------- |
| `reactLuauDoctor.enable`             | `true`  | Turns Doctor on or off                            |
| `reactLuauDoctor.liveDebounceMs`     | `250`   | Sets the delay after typing, in milliseconds      |
| `reactLuauDoctor.deepOnSave`         | `true`  | Starts a project refresh when you save            |
| `reactLuauDoctor.workspaceScan`      | `false` | Checks files you haven't opened in the background |
| `reactLuauDoctor.respectFileFilters` | `false` | Applies your include/ignore filters to open files |

Include/ignore filters apply to background scans. Enable `respectFileFilters` to apply them to open files too

## Configure rules

Put [react-luau-doctor.config.json](cli.md#configuration) in your project root to change rules

Save the config to refresh findings. In a workspace with multiple folders, each project uses the config in its own root folder
