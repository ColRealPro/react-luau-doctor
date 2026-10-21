# Changelog

## 0.22.0

### Highlights

- Files are now parsed with the official Luau parser, so modern Luau syntax is supported and parsing is faster
- `--scope changed` and `--scope lines` scans, like the ones CI runs, are about 2-6x faster on large projects, since they now only analyze the code that changed files depend on
- Full scans are about 25% faster on a single thread and 35% faster in parallel
- Scans with a warm cache take about half as long

### New rules

- `react-luau/no-function-host-prop` catches functions set as plain props on host elements, such as `Activated = function() end` instead of `[React.Event.Activated]`
- `react-luau/no-instance-as-event-value` catches `React.Change` and `React.Event` handlers that use their first argument, the Instance, as the changed value or event argument
- `react-luau/no-ref-on-function-component` catches refs passed to function components that do not use `React.forwardRef`, which leaves the ref unset
- `react-luau/no-binding-in-deps` catches hooks that list a binding they read, which never makes the hook run again

### Added

- `--timings` shows how long each analysis stage, parse step, and rule took

### Changed

- `no-prop-mutation` suggests `React.forwardRef` or a callback prop when a component writes to a ref passed through props
- `effect-needs-cleanup` reports effects that return a connection or other resource instead of a cleanup function as errors

### Fixed

- `no-array-index-as-key` no longer flags counted loops that build fixed slots, and tells arrays and dictionaries apart from how a table is filled
- `rerender-state-only-in-handlers` no longer suggests a ref for state read inside a `Binding:map`, which would leave the mapped value stale

## 0.21.2

### Changed

- `no-side-effects-in-render` shows which code in a called function causes the side effect

### Fixed

- `no-side-effects-in-render` no longer flags lookup caches, lazy defaults, or edits to fresh values such as `GetChildren()` results in called code
- Event handlers and other callbacks no longer count as components just because they call a hook or a helper named like one
- `no-prop-mutation` no longer flags helpers that parent a new Instance into a passed Instance

## 0.21.1

### Fixed

- PR review findings no longer get stuck awaiting verification after upgrades or config changes

## 0.21.0

### Added

- `--max-annotations` CI setting to limit or disable annotations
- `--max-review-comments` CI setting to change the inline review comment limit from the default of 20, up to 50

### Changed

- GitHub CI annotations are no longer limited to 10 per step. Run `ci upgrade` to grant the new `checks: write` permission
- GitHub CI follows GitHub's request guidance to avoid rate limits
- `react-luau/prefer-binding-over-state-candidate` is now off by default because its findings were mostly low-value
- Files that use React through `Roact` or `RoactCompat` are now analyzed as React
- `no-side-effects-in-render`, `no-task-spawn-in-render`, and `no-yield-in-render` now check `useMemo` callbacks, which also run during render

### Fixed

- CI annotations and file links on push runs now point to the right files when `--directory` scans a subfolder
- `react-luau/prefer-binding-over-state-candidate` no longer suggests splitting measurement state when an analyzed child component still needs the value through React state, such as in effect dependencies or hook arguments
- `rules-of-hooks` accepts hooks behind conditions on module fields that are set at load time and never written or re-exported elsewhere in the project
- `exhaustive-deps` no longer requires `useCallback` and `useMemo` values whose dependencies are all stable, such as callbacks that only capture state setters
- `rerender-unnecessary-usecallback` only skips callbacks captured by another hook when the callback has reactive dependencies
- `effect-needs-cleanup` follows connections stored in ref fields and collections to their cleanup
- `no-side-effects-in-render` follows side effects through returned parameters, reassigned values, and type casts
- Type annotations in multi-name `local` declarations are no longer treated as declared variables
- `typeof` types and type casts before comparisons no longer cause parse errors
- `typeof` inside generic and indexer types, multi-line generic type aliases, comments between union members, and function type parameters named after builtin types no longer cause parse errors
- `effect-needs-cleanup` accepts any task that checks a flag the cleanup changes, such as `if isMounted then` or `if cancelled then return end`
- `effect-needs-cleanup` accepts destroying an ancestor that a connected Instance was parented to in the effect
- `rules-of-hooks` explains hooks inside `pcall` and `xpcall` callbacks instead of reporting them as outside a component
- `no-side-effects-in-render` no longer treats lazy caches and one-time initialization in called code as side effects, such as filling `cache[key]` only when it is empty
- `no-ref-current-in-render` accepts nil-guarded lazy ref initialization that picks the initial value through nested branches

## 0.20.4

### New rules

- `react-luau/no-memo-without-deps` catches `useMemo` and `useCallback` calls without a dependency table, which recompute or return a new function on every render
- `react-luau/no-setter-as-event-handler` catches state and binding setters passed directly as `React.Change` or `React.Event` handlers, which store the Instance instead of a value

## 0.20.3

### Fixed

- Improved PR summary footer wording
- Inline reviews are now scoped to only findings introduced by the latest PR push again

## 0.20.2

### Changed

- Cleaned up existing CI reporting, added individual fixed issues to PR summaries, and improved inline review progress and reliability

### Fixed

- `no-binding-getvalue-in-render` now allows snapshots in initialization arguments to `useState`, `useBinding`, and `useReducer`, alongside `useRef`
- Fixed GitLab changed-scope scans by installing Git in generated jobs and using the merge-request diff baseline

## 0.20.1

### Fixed

- `rules-of-hooks` now correctly catches hooks in conditional expressions and callbacks
- Improved detection of tables, functions, and objects recreated during render in memoized props, hook dependencies, and context values

## 0.20.0

### Added

- VS Code extension with live diagnostics and hover explanations, requiring no CLI or Bun installation
- Quick fixes to explain findings, add inline disables, or disable rules in project config
- Optional background scanning of unopened files
- Autocomplete and validation for `react-luau-doctor.config.json`, with a schema in both packages

### New rules

- `react-luau/no-mutating-state-updater` catches mutations of previous state in updater callbacks
- `react-luau/no-call-component-as-function` catches direct calls to component functions
- `react-luau/no-create-binding-in-render` catches bindings recreated during render
- `react-luau/no-binding-getvalue-in-render` catches binding snapshots read during render, except for ref initialization
- `react-luau/usememo-must-return` catches memo callbacks that return no value
- `react-luau/no-static-name-prop` suggests child table keys instead of static Roblox `Name` props

### Fixed

- Restored per-file CLI progress while parsing effects and sped up worker shutdown
- `no-set-state-in-render` catches setters in prop expressions and local initializers, including aliases
- `exhaustive-deps` follows dependency table aliases and handles shadowed module locals correctly
- `no-prop-mutation` catches prop mutations in nested functions and callbacks
- `no-array-index-as-key` uses collection shapes and types to distinguish array positions from dictionary keys
- `rules-of-hooks` accepts loops over provably static module tables
- `prefer-binding-over-state` skips custom component props proven incompatible with bindings

## 0.19.1

### Changed

- Made `rules-of-hooks` stability-aware for custom hook topology, including React-Luau Binding/state modes, while still catching variable-length custom hook loops.
- Improved React hook ownership detection so unrelated `use*` APIs are not treated as React hooks.

### Fixed

- Added parser compatibility for modern typed Luau patterns used by React libraries.
- Detected no-dependency effects that unconditionally update state and cause render loops.
- Improved `exhaustive-deps` accuracy for type-only identifiers, cast/fallback dependency expressions, and transparent local aliases.

## 0.19.0

### Added

- Added release notes to `react-luau-doctor update --check`.

### Changed

- Improved `prefer-binding-over-state` to distinguish external presentation mirrors from normal React state.
- Expanded Binding detection across custom hooks, subscriptions, Roblox property updates, and high-frequency input.
- Improved cache invalidation to automatically clear entries when analyzer code changes.
- Automatic update notices now point to `react-luau-doctor update --check`.
