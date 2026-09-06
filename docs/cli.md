# CLI and configuration

Examples use the installed `react-luau-doctor` command. For one-off use, run the same arguments through `bunx @colrealpro/react-luau-doctor` or `npx @colrealpro/react-luau-doctor`; Bun must be installed either way.

## Scan targets

```bash
react-luau-doctor .
react-luau-doctor src/interface --verbose
react-luau-doctor src/interface/Label.luau
react-luau-doctor . --project client,shared
```

Directory discovery selects `.lua` and `.luau` files with React or ReactRoblox evidence. Explicit file targets are always analyzed and bypass directory include/ignore filters. Dependency and output directories such as `node_modules`, `Packages`, `DevPackages`, `ServerPackages`, `vendor`, `build`, `dist`, and `.git` are skipped during discovery.

Local subdirectory scans use the configuration in the command's working directory, with paths reported relative to that directory. Run from the project root for consistent paths.

## Git scopes

| Scope | Result |
| --- | --- |
| `full` | Findings across the selected target. No Git repository required. |
| `files` | All findings in changed files. |
| `changed` | Findings in changed files that were not present in the baseline. |
| `lines` | Findings whose primary span or evidence highlights overlap changed lines. |

Pass `--base main` or a commit to choose an explicit comparison. Use `--include-untracked` to include new untracked files, or `--changed-files-from paths.txt` for a newline-separated path list. Git scopes respect configured include/ignore patterns.

`--staged` checks Git index content. It uses file scope unless line scope is requested. Project context includes other source files on disk; this is not an isolated checkout of the complete index or baseline. See [analysis limits](analysis.md).

## Output and exit codes

```bash
react-luau-doctor . --verbose
react-luau-doctor . --json --json-compact
react-luau-doctor . --json-out doctor-report.json
react-luau-doctor . --output-dir .doctor
react-luau-doctor . --blocking warning
```

Local scans default to `--blocking error`. The default display summarizes findings. `--verbose` adds per-file details and help. `--output-dir` writes `report.json`, `diagnostics.json`, and `summary.json`.

JSON schema version 1 includes the root, scanned file count, duration, score, severity counts, and diagnostics. Each diagnostic has an ID, rule, category, severity, message, file, and location. Help, evidence highlights, and suggested-change previews may also be present. IDs include source offsets, so moving code can change an ID.

`--blocking none` is advisory, `error` fails for errors, and `warning` fails for warnings or errors. Findings that pass the gate return 0; a failed gate or command error returns nonzero. Suggestions do not independently fail a gate. Filters affect reported findings and therefore the gate.

Use `--category Hooks`, repeatable for multiple categories, or `--min-severity warning` to narrow results. `--no-warnings` selects errors only. `--no-score` hides the score and `--no-color` disables ANSI colors.

`--max-duration 10` requests a shared scan budget in seconds. Budget exhaustion returns a partial report with skipped files; individual analysis operations can exceed the deadline before the next checkpoint. Do not treat a partial report as a complete audit.

## Configuration

Doctor reads `react-luau-doctor.config.json` from the directory where the command is run. It does not search ancestor directories for local scan configuration.

```json
{
  "include": ["src/**/*.luau", "shared/**/*.lua"],
  "ignore": ["src/generated/**"],
  "respectInlineDisables": true,
  "rules": {
    "react-luau/exhaustive-deps": "error",
    "react-luau/no-array-index-as-key": "off"
  }
}
```

A rule setting is `error`, `warning`, `suggestion`, or `off`. An explicit severity applies to every finding from that rule, including findings normally downgraded for uncertainty. Without an override, individual findings may have lower severity than the rule default. Unknown rule IDs produce an error.

Patterns support `*`, `**`, and `?`; they are not full gitignore syntax. `**/` can match zero directories. Paths are relative to the scan project root.

You can edit rule policy through the CLI:

```bash
react-luau-doctor rules set react-luau/exhaustive-deps error
react-luau-doctor rules disable react-luau/no-array-index-as-key
react-luau-doctor rules list --configured --json
```

## Suppressions

```luau
-- react-luau-doctor-disable-next-line no-prop-mutation
props.value = "legacy"

-- react-luau-doctor-disable no-array-index-as-key
-- intentional code here
-- react-luau-doctor-enable no-array-index-as-key
```

Bare rule names and names prefixed with `react-luau/` are accepted. Prefer a next-line suppression and add a comment explaining the exception. `--no-respect-inline-disables` includes suppressed findings during an audit.

## Explain a finding

```bash
react-luau-doctor why src/Label.luau:12
react-luau-doctor rules explain react-luau/exhaustive-deps
```

`rules explain` accepts a full rule ID or a short name such as `exhaustive-deps`. It shows what the rule checks, current and suggested code, and repair notes. Add `--json` to receive the same example as `example.before`, `example.after`, `example.note`, and `example.kind`. Examples describe a pattern; they are not edits inferred from your project.

`why` rescans with project context and shows matching findings, code frames, rule intent, confidence, repair guidance, and available previews. Review example-pattern previews before applying them.

## Cache

Doctor stores an incremental cache outside the scanned repository:

| Platform | Default location |
| --- | --- |
| Linux | `$XDG_CACHE_HOME/react-luau-doctor`, otherwise `~/.cache/react-luau-doctor` |
| macOS | `~/Library/Caches/react-luau-doctor` |
| Windows | `%LOCALAPPDATA%/react-luau-doctor/Cache` |

Set `REACT_LUAU_DOCTOR_CACHE_DIR` to choose a location. Use `--no-cache` or `REACT_LUAU_DOCTOR_DISABLE_CACHE=1` to bypass it. Cache entries can include source-derived information, so treat the directory as local project data.

For the complete option list, run `react-luau-doctor --help`.
