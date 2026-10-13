# Changelog

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
