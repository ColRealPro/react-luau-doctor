# CI setup

React-Luau Doctor can install and manage CI for GitHub Actions and GitLab.

## GitHub Actions

From your Roblox repository, run:

```bash
react-luau-doctor ci install --yes
```

Then commit `.github/workflows/react-luau-doctor.yml`.

By default, pull requests scan changed files and report findings without blocking merges. Pushes to `main` run a full advisory scan. The generated workflow pins the Doctor version that created it so CI stays reproducible.

### Configure CI

Use `ci config` to change the generated workflow. For example:

```bash
react-luau-doctor ci config --blocking error --scope changed --yes
```

Blocking levels are:

- `none` - never fail the PR check
- `error` - fail when errors are reported
- `warning` - fail when warnings or errors are reported

To disable GitHub reporting:

```bash
react-luau-doctor ci config --no-comment --no-review-comments --no-commit-status --yes
```

### Permissions

The generated GitHub workflow requests:

```yaml
permissions:
  contents: read
  pull-requests: write
  statuses: write
```

Repository contents remain read-only. `pull-requests: write` is used for the PR summary and inline review comments, while `statuses: write` is used for the commit status.

Fork pull requests commonly receive read-only tokens. In that case, reporting may be unavailable, but the scan and configured gate still run. Keep the `pull_request` trigger rather than switching to `pull_request_target` just to obtain write permissions.

### Upgrade

Regenerate the workflow with the latest Doctor release:

```bash
bunx @colrealpro/react-luau-doctor@latest ci upgrade --yes
```

This preserves supported CI settings while updating the pinned package version. Review and commit the generated change.

Both `ci install` and `ci upgrade` also support `--pr` to create a branch and open a pull request using GitHub CLI.

## GitLab

Install a GitLab workflow with:

```bash
react-luau-doctor ci install --provider gitlab --blocking error --yes
```

Then commit `.gitlab-ci.yml`. The generated job runs the pinned Doctor version and does not publish merge-request comments or commit statuses.
