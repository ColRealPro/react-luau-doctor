# VS Code extension

Doctor provides a VS Code extension that analyzes your code as you write, allowing you to catch problems much quicker, and giving you quick fixes and easier to find guidance for fixing findings. 

## Install

Install [React-Luau Doctor from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=colrealpro.react-luau-doctor)

Open your project folder and a Luau file for doctor to start analyzing

## Quick fixes

You can hover a finding for a quick explanation and code example. Quick Fix lets you open the explanation with the `why` command in the cli (no cli needed though), suppress the rule for that line, or disable it for the entire project

Disabling a rule opens your project config with the change. It does not save the file automatically, so if you want to keep it, save it yourself

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
