# VS Code setup

React-Luau Doctor is **not on the VS Code Marketplace yet**. VS Code is currently the only editor with a bundled Doctor integration. Install the local `.vsix` file to try it. The installed extension does not require Bun.

## Install

In VS Code, open **Extensions**, choose **… -> Install from VSIX…**, select the Doctor `.vsix`, and reload the window. Open your React-Luau project folder and then a `.luau` or `.lua` file. Diagnostics appear in the editor and **Problems** panel.

If you need to build the VSIX from this checkout, Bun is required for building:

```bash
bun install --frozen-lockfile
npm --prefix editors/vscode ci
bun run build:lsp
cd editors/vscode
bunx --bun vsce package
```

Install the resulting `react-luau-doctor-vscode-*.vsix` through **Install from VSIX…**.

## Configure

Search for **React-Luau Doctor** in VS Code Settings. The same settings can be added to `settings.json`:

| Setting                          | Default | What it controls                                                         |
| -------------------------------- | ------- | ------------------------------------------------------------------------ |
| `reactLuauDoctor.enable`         | `true`  | Turn diagnostics on or off.                                              |
| `reactLuauDoctor.liveDebounceMs` | `250`   | Delay in milliseconds after typing stops.                                |
| `reactLuauDoctor.deepOnSave`     | `true`  | Refresh all Doctor findings for open files when you save.                |
| `reactLuauDoctor.workspaceScan`  | `false` | Scan unopened project files in the background. Open files take priority. |

Findings that need a fresh project analysis pause while you type, then return after about 1.5 seconds of inactivity without saving. Saving refreshes them immediately. Other findings stay visible until live analysis updates them. Closing a saved file keeps its findings visible in **Problems**.

Turn on `reactLuauDoctor.workspaceScan` to show findings for files you have not opened. Doctor scans those files one at a time, behind open-file analysis.

Hover a Doctor finding for its explanation, suggested fix, and an example from the rule. Finding-specific examples take precedence when the rule can provide one.

To change rules, put `react-luau-doctor.config.json` in the folder you opened in VS Code:

```json
{
  "include": ["src/**/*.luau"],
  "rules": {
    "react-luau/exhaustive-deps": "error",
    "react-luau/no-array-index-as-key": "off"
  }
}
```

Save the config file to refresh diagnostics. Rule values are `error`, `warning`, `suggestion`, or `off`. See the [configuration reference](cli.md#configuration) for include/ignore patterns and inline suppressions.

## If diagnostics do not appear

Check that the file's VS Code language mode is **Luau** or **Lua**, the intended project folder is open, and Doctor is enabled. Save the file, then check **View -> Output -> React-Luau Doctor** for errors.
