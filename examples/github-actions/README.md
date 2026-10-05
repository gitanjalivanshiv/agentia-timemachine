# GitHub Actions examples

Review data template changes like code: open a pull request that edits
`.timemachine/templates/<slug>/template.json`, get the Time Machine plan as a PR comment, merge, and let CI apply.

| Workflow                                         | Trigger                                 | Copado access               |
| ------------------------------------------------ | --------------------------------------- | --------------------------- |
| [`timemachine-plan.yml`](timemachine-plan.yml)   | pull request touching `.timemachine/**` | read-only                   |
| [`timemachine-apply.yml`](timemachine-apply.yml) | push to `main` touching templates       | **writes** (sandbox first!) |

**These need your CI credentials.** Add the repository secrets `AGENTIA_CICD_API_KEY` and `AGENTIA_CICD_BASE_URL`.
Copy the workflows into the **private** repository that holds your workspace, never into a public one:
snapshots contain your org's template configuration.

Safety built in:

- `plan` marks a template ⚠️ when Copado changed after its last snapshot; `apply` then refuses to overwrite it.
- `apply` saves through the same path as `timemachine restore`: lock, re-check, pre-change snapshot, save,
  read-back verification, post-change snapshot. The snapshot commits are pushed back.
- `concurrency` prevents two applies from running at once. Use a GitHub environment with required reviewers
  for a manual approval gate.
