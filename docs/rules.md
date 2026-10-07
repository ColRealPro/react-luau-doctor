# Rules

To list rules or see an explanation with a code example:

```bash
react-luau-doctor rules list
react-luau-doctor rules explain exhaustive-deps
```

The tables show default severities. Some findings use a lower severity when Doctor has less evidence

Add `react-luau/` before the names below when using them in your [config](cli.md#configuration). Set a rule to `off` to disable it

## Hooks

| Rule                              | Default    | What it catches                                            |
| --------------------------------- | ---------- | ---------------------------------------------------------- |
| `rules-of-hooks`                  | error      | Hooks run in a different order between renders             |
| `exhaustive-deps`                 | warning    | A hook callback reads values missing from its dependencies |
| `no-effect-with-fresh-deps`       | error      | A dependency is a new table or function on each render     |
| `no-mutable-in-deps`              | error      | A dependency reads a mutable `ref.current` value           |
| `prefer-use-ref-for-mutable-cell` | suggestion | `useMemo` creates a table used like a ref                  |

## Effects

| Rule                      | Default | What it catches                                                        |
| ------------------------- | ------- | ---------------------------------------------------------------------- |
| `effect-needs-cleanup`    | warning | An effect creates a resource or task without cleanup                   |
| `no-derived-state-effect` | warning | An effect copies a value into state that can be computed during render |
| `no-self-updating-effect` | warning | An effect updates state in a way that makes the effect run again       |

## Correctness

| Rule                            | Default    | What it catches                                                                          |
| ------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| `parse-error`                   | error      | Doctor cannot parse the file                                                             |
| `no-set-state-in-render`        | warning    | A component calls its state setter during render without a condition                     |
| `no-mutating-state-updater`     | error      | A state updater changes the previous state table in place                                |
| `no-call-component-as-function` | warning    | Code calls a component directly instead of creating an element                           |
| `no-create-binding-in-render`   | warning    | `createBinding` creates a new binding on each render                                     |
| `no-binding-getvalue-in-render` | warning    | Render reads a binding snapshot instead of subscribing, except when initializing a ref   |
| `usememo-must-return`           | warning    | A `useMemo` callback has no value to return                                              |
| `no-direct-state-mutation`      | warning    | Code changes a state table in place                                                      |
| `no-ref-current-in-render`      | warning    | Render changes `ref.current`, beyond initialization and latest-value mirrors             |
| `no-create-context-in-render`   | error      | A component creates a new context during render                                          |
| `no-random-key`                 | error      | A child's key changes randomly between renders                                           |
| `no-yield-in-render`            | error      | Render yields execution                                                                  |
| `no-task-spawn-in-render`       | error      | Render schedules asynchronous work                                                       |
| `no-side-effects-in-render`     | error      | Render creates instances, starts tweens, subscribes to events, or changes external state |
| `no-prop-mutation`              | error      | A component changes its props                                                            |
| `no-static-name-prop`           | warning    | A child uses a static `Name` prop instead of a child table key                           |
| `no-array-index-as-key`         | suggestion | A child uses its position in a changing list as its identity                             |

## Performance

| Rule                                  | Default    | What it catches                                                                |
| ------------------------------------- | ---------- | ------------------------------------------------------------------------------ |
| `prefer-binding-over-state`           | warning    | Frequent external state updates only change properties that could use bindings |
| `prefer-binding-over-state-candidate` | suggestion | A state value might suit a binding, but its consumers need a closer look       |
| `rerender-unstable-memo-props`        | warning    | Fresh tables or functions prevent a memoized child from skipping renders       |
| `rerender-high-frequency-state`       | warning    | Frame callbacks update state that rerenders an expensive component tree        |
| `rerender-unnecessary-usememo`        | warning    | `useMemo` caches a simple calculation                                          |
| `rerender-unnecessary-usecallback`    | warning    | Nothing uses the stable identity of a `useCallback` result                     |
| `rerender-static-discovery-in-render` | warning    | Render repeatedly looks up the same instance or module                         |
| `rerender-repeated-collection-scan`   | warning    | Render repeatedly scans the same collection                                    |
| `rerender-static-state`               | warning    | A state setter is never used                                                   |
| `rerender-functional-setstate`        | warning    | A deferred callback updates state from a captured old value                    |
| `rerender-lazy-state-init`            | warning    | Render repeats expensive work passed to `useState`                             |
| `rerender-lazy-ref-init`              | warning    | Render repeats expensive work passed to `useRef`                               |
| `rerender-state-only-in-handlers`     | warning    | Only callbacks read a state value                                              |
| `unstable-context-value`              | warning    | A provider creates a new context value table each render                       |

## Architecture

| Rule                             | Default | What it catches                                                  |
| -------------------------------- | ------- | ---------------------------------------------------------------- |
| `no-nested-component-definition` | warning | A component defines another component inside its render function |

## Roblox

| Rule                       | Default | What it catches                                      |
| -------------------------- | ------- | ---------------------------------------------------- |
| `no-create-root-in-render` | error   | A component creates a ReactRoblox root during render |
