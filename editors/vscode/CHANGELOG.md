# Changelog

## Unreleased

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
