# How analysis works

Doctor parses source with `web-tree-sitter` and a bundled Luau grammar. It builds a model of React aliases, functions, hooks, state, refs, and component calls before running rules. It never executes the Luau program.

## File and project evidence

Requires and local aliases identify React and ReactRoblox usage. A namespace does not need to be named `React`. Directory scans filter out modules without React evidence, but supporting modules can still contribute to project analysis.

Cross-file resolution compares normalized path segments. Short names are used only when they identify a unique module; longer unique matches take precedence. This avoids confusing `Controller` with `SessionController`, or guessing between two unrelated `Button` modules. Dynamic requires and runtime module selection can remain unresolved.

The project model summarizes memoized components, externally updated state hooks, callback wrappers, state/Binding API pairs, and source-visible effects. Effect propagation follows imports and calls to find operations that mutate external state during render. Unknown opaque methods are not automatically assumed to have side effects.

## Binding recommendations

The Binding rules trace state updated by external callbacks, including signals and frame events. They inspect how consumers read that state before recommending a Binding.

A warning can be justified when reads flow into bindable host properties or through a custom component proven to forward them. Mixed structural use and unknown component props can produce a lower-confidence candidate instead. A Binding cannot replace every state value: values controlling child structure or other ordinary Lua decisions may still need React state.

Measurement hooks have additional producer-side evidence: a property-change subscription, a read of that property, and a state update. Their recommendations may require a Binding-aware effect or a larger consumer refactor. Dual state/Binding hooks and sibling APIs are inferred from available source, not a configurable list of project hook names.

## Syntax compatibility

A preprocessing pass adapts certain modern Luau constructs that the grammar does not directly support. It aims to preserve byte offsets and line positions. Remaining parse failures are reported as `react-luau/parse-error`, and other rules stop for that file to avoid cascaded findings.

## Confidence and scope limits

Static evidence cannot establish all runtime behavior. Dynamic dispatch, metatables, unavailable dependencies, and indirect ownership can lead to missed findings or findings that need human judgment. Test a proposed repair in Roblox and profile performance changes when relevant.

Git changed scope compares diagnostic multisets using file, rule, severity, and message. Moving a finding within the same file usually does not make it new. Replacing one finding with another identical finding can cancel out in that comparison.

Scoped scans overlay selected file contents on current project context. They do not reconstruct every file from the historical revision. Deleted files are included in baseline accounting, but cross-file changes can still make historical inference imperfect. Use a full scan and review both revisions when investigating a cross-file regression.

The health score weights findings by severity and scanned-file count. It is a triage aid, not an estimate of FPS, reliability, or production readiness. Zero findings can also mean that no eligible React files were found; check `scannedFiles` and partial-report fields.

## Supported input

Doctor targets source-controlled `.lua` and `.luau` files using React-Luau. It does not read Roblox place files, inspect a live Studio session, analyze `.tsx`, or provide DOM, CSS, React Native, or Next.js checks. The npm package is a CLI distribution; a public programmatic API is not supported.
