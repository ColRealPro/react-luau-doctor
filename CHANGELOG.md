# Changelog

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
