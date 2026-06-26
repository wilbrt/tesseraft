# PR Housekeeping Workflow

`examples/pr-housekeeping/workflow.edn` is the safe first slice of a maintainer workflow for open pull requests.

This is an opinionated housekeeping flow: it discovers open PRs, chooses the next actionable PR, and performs the appropriate repair/response path. With `dry-run=true`, it writes the plan and would-run artifacts without mutating GitHub. With `dry-run=false`, it performs the workflow's actions: repair conflicts or comments in isolated worktrees, test/review, push changes, and post reviewed responses. It does not merge pull requests yet.

The workflow's process helpers are small Python scripts because process nodes communicate through the language-neutral JSON stdin/stdout protocol and these helpers primarily orchestrate `gh`, Git, and artifact files. The platform/runtime implementation remains Babashka/Clojure; the workflow contract, not helper implementation language, is the portability boundary.

## What it does

```text
list-open-prs
  -> fetch-pr-states
  -> classify-prs
  -> plan-actions
  -> select-conflict-target
  -> conflict repair path when enabled and selected
  -> otherwise select-comment-target
  -> comment handling path when enabled and selected
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

To run the full housekeeping flow without mutating anything:

```bash
./bin/tesseraft run examples/pr-housekeeping/workflow.edn \
  --run-id pr-housekeeping-check \
  --input repo-root=. \
  --input dry-run=true \
  --format json
```

To run it for real:

```bash
./bin/tesseraft run examples/pr-housekeeping/workflow.edn \
  --run-id pr-housekeeping-live \
  --input repo-root=. \
  --input dry-run=false \
  --format json
```

The workflow automatically chooses the first conflicted PR. If there are no conflicted PRs, it chooses the first PR needing a response. `target-pr` can narrow a run to one PR, but the flow still decides what action is appropriate for that PR.

Comment handling writes feedback summaries, internal response drafts, and a separate post-ready response body. If Pi makes code changes, tests and review run before push. With `dry-run=false`, validated code changes are pushed and reviewed response bodies are posted as consolidated PR comments.

Push paths first commit or verify validated worktree changes, then use `git push --force-with-lease origin HEAD:refs/heads/<pr-head-branch>`. Cross-repository PRs are refused by this first implementation.

When invoking the workflow from outside the repository root, pass an absolute `repo-root`. The helper scripts also try to resolve relative `repo-root` values against the run directory and current working directory to avoid creating repair worktrees under the workflow example directory.

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
  verify the rebased HEAD differs from the original PR head, committing only if unexpected uncommitted changes remain
  push rebased history with --force-with-lease when dry-run=false

fix-comments / respond-only:
  prepare an isolated worktree from the actual PR head
  fetch issue comments, reviews, and review comments
  design comment response/fix plan
  execute fixes when appropriate
  detect whether code changed
  run configured tests when code changed
  review fixes or no-change rationale
  commit changes when code changed
  push branch with --force-with-lease when code changed and dry-run=false
  draft responses for every addressed comment
  write a concise post-ready response body without internal draft headings
  post the reviewed post-ready response as a consolidated PR comment when dry-run=false

ready-to-merge / merge:
  require merge-approved=true
  require dry-run=false
  verify approved, clean, and checks passing
  merge PR
```

Mutation paths should default to dry-run artifacts before they post comments, push branch updates, or merge PRs.
