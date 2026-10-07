# CI setup

## GitHub Actions

From your project folder:

```bash
react-luau-doctor ci install
```

The setup asks which findings should fail the check and whether to post PR comments. Add `--yes` to use the defaults

Commit the generated `.github/workflows/react-luau-doctor.yml`

By default, PRs report newly introduced findings without failing the check. Pushes to `main` run a full scan. The workflow pins the Doctor version used to create it

## Change the settings

To fail the check when a PR introduces errors:

```bash
react-luau-doctor ci config --blocking error --scope changed --yes
```

| Blocking level | When findings fail the check       |
| -------------- | ---------------------------------- |
| `none`         | Findings do not fail the check     |
| `error`        | Errors fail the check              |
| `warning`      | Errors and warnings fail the check |

Use `--no-comment`, `--no-review-comments`, or `--no-commit-status` to disable the corresponding GitHub reports

GitHub reporting uses `GITHUB_TOKEN`. Fork PRs may have a read-only token, so Doctor can still scan them even when it cannot post comments or a status

## Upgrade Doctor in CI

```bash
bunx @colrealpro/react-luau-doctor@latest ci upgrade --yes
```

This updates the pinned version and keeps your CI settings. Commit the workflow change

## GitLab

```bash
react-luau-doctor ci install --provider gitlab --yes
```

Commit the generated `.gitlab-ci.yml`. GitLab runs the scan and uses the same blocking settings, but does not post merge request comments
