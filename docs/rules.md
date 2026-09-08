# Rule catalog

Doctor currently includes 35 rules. This table lists their default severities; individual findings can be downgraded when evidence is uncertain. Explicit configuration overrides the severity for every finding from that rule.

| Rule | Default | Category | Checks |
| --- | --- | --- | --- |
| `react-luau/parse-error` | error | Correctness | Report executable Luau syntax that the bundled parser cannot form into a complete syntax tree. |
| `react-luau/rules-of-hooks` | error | Hooks | Hooks must run in the same order on every render of a React component or custom hook. |
| `react-luau/exhaustive-deps` | warning | Hooks | React hook dependency tables should include captured reactive render values. |
| `react-luau/effect-needs-cleanup` | warning | Effects | Effects that create owned resources or outliving tasks should return matching cleanup. |
| `react-luau/no-derived-state-effect` | warning | Effects | Avoid copying render-known derived values into state from an effect. |
| `react-luau/no-self-updating-effect` | warning | Effects | Effects should not unconditionally update state that is also one of their dependencies. |
| `react-luau/no-effect-with-fresh-deps` | error | Hooks | Dependency tables should not contain tables or functions recreated on every render. |
| `react-luau/no-mutable-in-deps` | error | Hooks | Mutable ref.current values do not belong in hook dependency tables. |
| `react-luau/prefer-binding-over-state` | warning | Performance | Prefer React.useBinding for proven external presentation streams whose updates do not need React reconciliation. |
| `react-luau/prefer-binding-over-state-candidate` | suggestion | Performance | Surface lower-confidence external-mirror and mixed state-to-Binding opportunities that need developer review. |
| `react-luau/rerender-unstable-memo-props` | warning | Performance | Warn when fresh table or function props defeat shallow React.memo comparisons. |
| `react-luau/rerender-high-frequency-state` | warning | Performance | Find state updates from frame callbacks that can rerender expensive component trees continuously. |
| `react-luau/rerender-unnecessary-usememo` | warning | Performance | Find trivial derived values that cost more to memoize than to compute directly. |
| `react-luau/rerender-unnecessary-usecallback` | warning | Performance | Find useCallback values whose stable function identity is never observed. |
| `react-luau/rerender-static-discovery-in-render` | warning | Performance | Find static Instance/module discovery repeated during component render. |
| `react-luau/rerender-repeated-collection-scan` | warning | Performance | Find repeated direct render passes over the same collection expression. |
| `react-luau/rerender-static-state` | warning | Performance | Find React state whose setter is never used and therefore cannot change. |
| `react-luau/prefer-use-ref-for-mutable-cell` | suggestion | Hooks | Prefer useRef over useMemo-created tables that only emulate a mutable current cell. |
| `react-luau/rerender-functional-setstate` | warning | Performance | Use the functional state setter form when deferred callbacks update from the previous state value. |
| `react-luau/rerender-lazy-state-init` | warning | Performance | Expensive useState initializers should use React's lazy initializer form. |
| `react-luau/rerender-lazy-ref-init` | warning | Performance | Avoid eagerly rebuilding expensive values passed to useRef on every render. |
| `react-luau/rerender-state-only-in-handlers` | warning | Performance | State that is only read from callbacks may be mutable data rather than rendered state. |
| `react-luau/no-set-state-in-render` | warning | Correctness | Do not call a component's state setter unconditionally during render. |
| `react-luau/no-direct-state-mutation` | warning | Correctness | Do not mutate table state in place. |
| `react-luau/no-ref-current-in-render` | warning | Correctness | Avoid mutating ref.current during render except for predictable initialization or deliberate latest-value mirrors. |
| `react-luau/no-create-context-in-render` | error | Correctness | React contexts must have stable identity and should not be created during render. |
| `react-luau/no-nested-component-definition` | warning | Architecture | Do not define rendered component types inside another component. |
| `react-luau/no-random-key` | error | Correctness | React child keys must not be regenerated on each render. |
| `react-luau/no-yield-in-render` | error | Correctness | React render functions must not yield. |
| `react-luau/no-task-spawn-in-render` | error | Correctness | Do not schedule asynchronous work during render. |
| `react-luau/no-side-effects-in-render` | error | Correctness | Do not create Instances, start tweens, subscribe, or perform other externally observable side effects during component render. |
| `react-luau/no-create-root-in-render` | error | Roblox | Do not create ReactRoblox roots during component render. |
| `react-luau/no-prop-mutation` | error | Correctness | Component props should be treated as immutable inputs. |
| `react-luau/no-array-index-as-key` | suggestion | Correctness | Review dynamic React children that use their current array position as identity. |
| `react-luau/unstable-context-value` | warning | Performance | Avoid recreating context value tables on every provider render when identity matters. |

## Investigate and configure

```bash
react-luau-doctor rules list
react-luau-doctor rules explain react-luau/exhaustive-deps
react-luau-doctor why src/Label.luau:12
react-luau-doctor rules set react-luau/exhaustive-deps error
```

Errors, warnings, and suggestions express reporting policy, not proof of a runtime bug. Review the explanation and code context before changing behavior. Suppress intentional exceptions narrowly.

The Binding candidate rule is suggestion-tier because the consumer may require ordinary state or a larger refactor. Array-index keys can also be intentional for collections with stable ordering. See [analysis limits](analysis.md) and [configuration](cli.md).

Instance creation and tween operations during render are reported by `react-luau/no-side-effects-in-render` and use that rule's severity and configuration.
