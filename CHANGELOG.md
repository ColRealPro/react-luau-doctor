# Changelog

## 0.19.0

### Added

- Added release notes to `react-luau-doctor update --check`.

### Changed

- Improved `prefer-binding-over-state` to distinguish external presentation mirrors from normal React state.
- Expanded Binding detection across custom hooks, subscriptions, Roblox property updates, and high-frequency input.
- Improved cache invalidation to automatically clear entries when analyzer code changes.
- Automatic update notices now point to `react-luau-doctor update --check`.
