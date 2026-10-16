# Changelog

## 0.21.2

### Changed

- `no-side-effects-in-render` shows which code in a called function causes the side effect

### Fixed

- `no-side-effects-in-render` no longer flags lookup caches, lazy defaults, or edits to fresh values such as `GetChildren()` results in called code
- Event handlers and other callbacks no longer count as components just because they call a hook or a helper named like one
- `no-prop-mutation` no longer flags helpers that parent a new Instance into a passed Instance

## 0.21.0

### Changed

- `react-luau/prefer-binding-over-state-candidate` is now off by default because its findings were mostly low-value
- Files that use React through `Roact` or `RoactCompat` are now analyzed as React
- `no-side-effects-in-render`, `no-task-spawn-in-render`, and `no-yield-in-render` now check `useMemo` callbacks, which also run during render

### Fixed

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

## 0.20.2

### Fixed

- `no-binding-getvalue-in-render` now allows snapshots in initialization arguments to `useState`, `useBinding`, and `useReducer`, alongside `useRef`

## 0.20.1

### Fixed

- `rules-of-hooks` now correctly catches hooks in conditional expressions and callbacks
- Improved detection of tables, functions, and objects recreated during render in memoized props, hook dependencies, and context values

## 0.20.0

First release of the VS Code extension

- Live diagnostics for React-Luau projects
- Rule explanations, inline disables, and disabling rules for a project
- Autocomplete and validation for project configuration
