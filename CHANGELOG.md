# Changelog

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
