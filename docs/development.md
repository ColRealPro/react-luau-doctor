# Development

Use Bun 1.4.0 or newer

## Run locally

```bash
bun install --frozen-lockfile
npm --prefix editors/vscode ci
bun run build
bun run src/cli.ts examples --verbose
```

Run `bun run ci` for the project checks

To test the extension in VS Code:

```bash
bun run install:lsp
```

Reload VS Code after installing. `bun run build:lsp` builds the VSIX without installing it

## Work on a rule

Rules are registered in `src/rules/index.ts`. Each rule has guidance and a repair example in `src/rules/examples.ts`

Scanner regression tests go in `tests/scanner.test.ts`. Use a small example that reproduces the issue

The CLI and editor share rule explanations through `src/presentation.ts`. A finding can provide its own guidance when the generic example doesn't fit

The editor runs rules from `src/lsp/live-rules.ts` against the current buffer. Rules that need fresh project information run in the worker. Both use `liveDebounceMs`, and the worker handles one project refresh at a time

Run `bun run benchmark:lsp` to measure parsing and analysis
