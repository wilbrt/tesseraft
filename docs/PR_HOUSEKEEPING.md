# PR Housekeeping Workflow

`examples/pr-housekeeping/workflow.edn` is the safe first slice of a maintainer workflow for open pull requests.

By default it performs discovery and planning only. Conflict repair is opt-in for one target PR at a time; it uses an isolated worktree and only pushes after rebase/fix, tests, review, and explicit push gates. It does not post comments or merge pull requests.

## What it does

```text
list-open-prs
  -> fetch-pr-states
  -> classify-prs
  -> plan-actions
  -> select-conflict-target
  -> prepare-conflict-worktree
  -> rebase-conflict-worktree
  -> fix-conflicts when needed
  -> test-conflict-worktree
  -> review-conflict-fix
  -> push-conflict-fix when explicitly gated
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

To attempt conflict repair for one PR without pushing:

```bash
./bin/tesseraft run examples/pr-housekeeping/workflow.edn \
  --run-id pr-housekeeping-repair-PR_NUMBER \
  --input repo-root=. \
  --input repair-conflicts=true \
  --input target-pr=PR_NUMBER \
  --input dry-run=true \
  --format json
```

To allow the final push after the rebase/fix, tests, and review pass, set both gates:

```bash
--input dry-run=false --input push-conflict-fixes=true
```

The push uses `git push --force-with-lease origin HEAD:refs/heads/<pr-head-branch>`. Cross-repository PRs are refused by this first implementation.

Inspect the report:

```bash
cat .agent-runs/pr-housekeeping/pr-housekeeping-check/housekeeping/report.md
cat .agent-runs/pr-housekeeping/pr-housekeeping-check/housekeeping/action-plan.md
```

## Classification actions

The planner currently emits conservative actions:

- `fix-conflicts` — PR appears to have merge conflicts.
- `fix-comments` — reviews request changes; these also require a response.
- `respond-only` — primary action for top-level PR comments or COMMENTED reviews when no code/conflict work is currently required.

Separately, `housekeeping/planned/response-prs.json` includes every PR with detected comments or requested changes, even when the primary action is `fix-conflicts` or `fix-comments`.
- `ready-to-merge` — PR appears approved and mergeable, but merge is disabled.
- `merge` — future gated action when `merge-approved=true` is implemented.
- `skip` — no safe action should be taken now.
- `blocked` — state is unknown or unsafe.

GitHub sometimes reports mergeability as `UNKNOWN`; the workflow treats that as blocked rather than guessing.

## Intended future mutation paths

The full housekeeping workflow should remain gated and explicit.

```text
fix-conflicts:
  prepare an isolated worktree from the actual PR head
  rebase onto the PR base branch
  resolve conflicts with Pi when rebase cannot complete automatically
  run configured tests
  review conflict resolution
  push branch with --force-with-lease only when dry-run=false and push-conflict-fixes=true

fix-comments / respond-only:
  ensure worktree for PR branch when code changes may be needed
  design comment response/fix plan
  execute fixes when appropriate
  review fixes or no-change rationale
  push branch when code changed
  draft or post responses for every addressed comment

ready-to-merge / merge:
  require merge-approved=true
  require dry-run=false
  verify approved, clean, and checks passing
  merge PR
```

Mutation paths should default to dry-run artifacts before they post comments, push branch updates, or merge PRs.
