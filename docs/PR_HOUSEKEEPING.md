# PR Housekeeping Workflow

`examples/pr-housekeeping/workflow.edn` is the safe first slice of a maintainer workflow for open pull requests.

It currently performs discovery and planning only. It does not rebase branches, post comments, push changes, or merge pull requests.

## What it does

```text
list-open-prs
  -> fetch-pr-states
  -> classify-prs
  -> plan-actions
  -> done
```

The workflow writes:

```text
housekeeping/open-prs.json
housekeeping/pr-states.json
housekeeping/actions.json
housekeeping/report.md
housekeeping/action-plan.md
housekeeping/planned/*.json
```

## Running it

```bash
./bin/tesseraft lint examples/pr-housekeeping/workflow.edn
./bin/tesseraft run examples/pr-housekeeping/workflow.edn \
  --run-id pr-housekeeping-check \
  --input repo-root=. \
  --input max-prs=20 \
  --format json
```

Inspect the report:

```bash
cat .agent-runs/pr-housekeeping/pr-housekeeping-check/housekeeping/report.md
cat .agent-runs/pr-housekeeping/pr-housekeeping-check/housekeeping/action-plan.md
```

## Classification actions

The planner currently emits conservative actions:

- `fix-conflicts` — PR appears to have merge conflicts.
- `fix-comments` — reviews request changes.
- `respond-only` — comments exist but no changes are detected as required.
- `ready-to-merge` — PR appears approved and mergeable, but merge is disabled.
- `merge` — future gated action when `merge-approved=true` is implemented.
- `skip` — no safe action should be taken now.
- `blocked` — state is unknown or unsafe.

GitHub sometimes reports mergeability as `UNKNOWN`; the workflow treats that as blocked rather than guessing.

## Intended future mutation paths

The full housekeeping workflow should remain gated and explicit.

```text
fix-conflicts:
  ensure worktree for PR branch
  rebase/fix conflicts with Pi
  review conflict resolution
  push branch

fix-comments:
  ensure worktree for PR branch
  design comment response/fix plan
  execute fixes
  review fixes
  push branch
  draft or post responses

ready-to-merge / merge:
  require merge-approved=true
  require dry-run=false
  verify approved, clean, and checks passing
  merge PR
```

Mutation paths should default to dry-run artifacts before they post comments, push branch updates, or merge PRs.
