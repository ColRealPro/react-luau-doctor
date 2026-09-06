# Development and releases

Use Bun 1.4.0 for reproducible release builds. Newer Bun versions can run the CLI, but bundle output can vary with the builder version. Git is required by the scoped-scan tests. Package verification needs `tar` and registry access. It uses npm when available, otherwise runs npm through Bun.

## Work locally

```bash
bun install --frozen-lockfile
bun run check
bun test
bun run build
```

`bun test` runs fixture-based rules, Git scope cases, configuration tests, CLI subprocesses, generated CI tests, and simulated GitHub API reporting. The API tests bind only to loopback and use a test token.

`dist/` is generated output and should not be committed. Keep `vendor/` and `bun.lock` tracked. npm's `prepack` hook rebuilds `dist/` before packing or publishing.

## Source layout

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | Commands, options, explanation output, exit gates. |
| `src/scanner.ts` | File scans, rule execution, diagnostic construction. |
| `src/ast/` | Syntax traversal and file-level React evidence. |
| `src/project-model.ts` | Cross-file React relationships. |
| `src/project-effects.ts` | Source-visible effects and propagation. |
| `src/rules/` | Rule definitions and repair guidance. |
| `src/git.ts`, `src/scope.ts` | Git content selection and comparisons. |
| `src/ci.ts` | Generated workflows, npm version pinning, GitHub reporting. |
| `vendor/` | Luau parser grammar and its license. |

The build bundles `src/cli.ts` into `dist/cli.js`, leaving runtime dependencies external. `dist/` exists for the npm distribution, where the package `bin` points at `dist/cli.js`; it is not a source-controlled CI runtime. The parser locates its grammar relative to the published package layout.

## Change a rule

Add a minimal failing fixture and a valid counterpart. Test the intended diagnostic, location, default severity, and help. Cover explicit severity overrides when a rule supplies confidence-based severities. Register new rules in `src/rules/index.ts`, add a before/after repair example in `src/fix-examples.ts`, and update the catalog in `docs/rules.md`. Tests require an example for every rule and parse each suggested snippet.

Check a proposed repair in Roblox where runtime behavior matters. Tests of syntax alone cannot validate UI behavior or performance.

## Change CI

Generated GitHub and GitLab workflows pin `${package name}@${package version}` from `package.json` and resolve the package from npm at run time. Keep the package version pin exact rather than using `latest` in generated CI, so a repository only changes analyzer versions when its workflow is regenerated.

Pass variable workflow values through environment variables rather than interpolating them directly into shell source. Tests cover generated settings, package pinning, and shell metacharacters.

Repository CI typechecks, tests, builds, and verifies the packed npm distribution. `dist/` is ignored, so CI does not compare generated bundle bytes against committed artifacts.

## Release checklist

1. Update the version in `package.json`. A version change also invalidates persistent analysis caches.
2. Build with Bun 1.4.0 and run the full local checks with `bun run ci`.
3. Run `npm pack --dry-run` to inspect the package list. It must include `dist/cli.js`, the grammar, license notices, and docs, while excluding tests, dependencies, development-only source files, and CI-only runtime copies.
4. Run `bun run verify:package` to pack, install, scan, and generate CI from an isolated tarball.
5. Commit source, documentation, and lockfile changes, then push to `colrealpro/react-luau-doctor` and wait for repository CI. Do not commit `dist/`.
6. Publish the verified npm version and confirm `bunx @colrealpro/react-luau-doctor@<version> --version` resolves from the registry.
7. Generate CI from the published version and test real PR reporting plus a fork PR in a disposable repository before recommending required checks.
8. Create the matching release tag after the published package and hosted CI behavior are verified.

npm distributes the developer CLI; it does not install a runtime library into Roblox. Release commands are still manual: this checkout does not publish packages, create releases, or push changes automatically.

## Report a problem

Include the tool version, Bun version, operating system, minimal Luau source, configuration, and the command you ran. For Git-related issues, describe the base revision and whether edits were staged. Remove private source and tokens from shared reports.
