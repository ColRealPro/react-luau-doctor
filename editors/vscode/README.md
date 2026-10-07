# React-Luau Doctor

Catch React-Luau mistakes as you code, including hooks after early returns, stale state in callbacks, and unnecessary rerenders

## Using Doctor

Open your project folder and a `.luau` or `.lua` file to start Doctor

Hover a finding for an explanation and example. Quick Fix offers inline disables and project-wide rule disables when a finding doesn't suit your code

## Choosing rules

Set rule severities in `react-luau-doctor.config.json` in your project root:

```json
{
  "rules": {
    "react-luau/no-array-index-as-key": "off",
    "react-luau/no-set-state-in-render": "error"
  }
}
```

Rules accept `off`, `error`, `warning`, or `suggestion` for severities, the extension autocompletes rule IDs and config options for you.

See the [rule list](https://github.com/colrealpro/react-luau-doctor/blob/main/docs/rules.md) for a list of all rules

## Extension settings

Doctor only looks at open files by default, enable `reactLuauDoctor.workspaceScan` to scan unopened files too

Open files are scanned even if your config excludes them by default, enable `reactLuauDoctor.respectFileFilters` to apply include/ignore filters to those files too

More options are available in the extension settings
