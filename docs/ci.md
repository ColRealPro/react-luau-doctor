# CI setup

There are two workflows to distinguish: this repository's own build/test CI, and the analyzer workflow installed into your Roblox repository.

## Install into a Roblox repository

Run React-Luau Doctor as described in the [README](../README.md). From the Roblox repository, run:

```bash
react-luau-doctor ci install --yes
```

Commit `.github/workflows/react-luau-doctor.yml`. The generated workflow installs Bun, then runs the exact npm package version that generated the workflow, for example `@colrealpro/react-luau-doctor@<version>`. This keeps CI reproducible without committing Doctor's bundle, parser grammar, or dependencies into your repository.

The workflow checks out full Git history. Pull requests use `changed` scope by default. Pushes to `main` run a full advisory scan. Change the branch trigger if your default branch has another name.

## Gates and reporting

```bash
react-luau-doctor ci config --blocking error --scope changed --yes
react-luau-doctor ci config --no-comment --no-review-comments --no-commit-status --yes
```

The default gate is `none`. `error` fails a PR check for errors; `warning` fails for warnings or errors. Push scans remain advisory regardless of this setting.

The generated workflow requests `contents: read`, `pull-requests: write`, `issues: write`, and `statuses: write`. Reporting can create or update a summary, add up to 20 inline comments for findings introduced by a new commit, resolve threads after their findings are fixed, and publish a commit status. Unchanged findings keep their original threads and do not create new notifications. Only bot-authored comments carrying Doctor's markers are managed. Summary details are capped; the workflow log contains the report.

Inline comments use primary diagnostic lines present in the diff. A finding included through a secondary evidence highlight can appear in the report without an inline comment. Fixed-issue counts include findings removed by deleting files and respect project selection and configuration.

GitHub API requests retry rate-limit responses. Retries honor `Retry-After` and primary rate-limit reset headers. Doctor stops instead of waiting when GitHub asks it to pause for more than 60 seconds, leaving the scan result and gate intact.

Fork PR tokens commonly lack write permissions. Reporting failures are logged while scan results, outputs, and the configured gate remain available. Disabling reporting avoids those API calls. Keep the `pull_request` trigger; do not switch to `pull_request_target` to obtain write access while executing PR-controlled files.

## Upgrade

Run the latest Doctor version, then regenerate the managed workflow:

```bash
bunx @colrealpro/react-luau-doctor@latest ci upgrade --yes
```

This preserves supported workflow settings while updating the pinned npm version. Review and commit the generated change. `ci config` also regenerates the managed workflow using the version of Doctor that invokes it. Keep custom workflow logic in a separate workflow.

`ci install` and `ci upgrade` accept `--pr`, which uses authenticated GitHub CLI access to create a branch, commit generated files, push, and open a PR. Omit it when you want to review the file locally first.

## Outputs

The generated GitHub step has the id `doctor` and writes these outputs through `GITHUB_OUTPUT`, so later steps in the same job can read values such as `${{ steps.doctor.outputs.score }}`.

| Output | Meaning |
| --- | --- |
| `score` | Heuristic score for the reported findings. |
| `total-issues` | Number of reported diagnostics. |
| `fixed-issues` | Baseline findings removed by a PR. |
| `error-count` | Reported errors. |
| `warning-count` | Reported warnings. |
| `affected-files` | Files with reported findings. |

## GitLab

```bash
react-luau-doctor ci install --provider gitlab --blocking error --yes
```

Commit `.gitlab-ci.yml`. The generated job uses a pinned Bun image and runs the exact npm package version that generated the workflow. It does not publish merge-request comments or statuses. Full Git history is requested; explicitly adapt the comparison base to your merge-request workflow if needed. Existing unrelated `.gitlab-ci.yml` files are not overwritten.

## Verification

The test suite simulates GitHub API requests for summary creation and updates, new review findings, resolved review threads, rate-limit retries, commit statuses, forbidden responses, generated workflow behavior, and shell input handling. Package verification also checks that `ci install` from the packed distribution generates a version-pinned npm workflow without vendoring Doctor into the target repository.

Before enabling a required check, run real PRs in your repository that introduce an error, repair it, delete an affected component, and originate from a fork. Confirm the gate, outputs, comments, and status behavior. Local simulation does not validate GitHub account permissions or hosted-runner behavior.
