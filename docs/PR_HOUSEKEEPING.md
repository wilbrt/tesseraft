# PR Housekeeping Workflow

`examples/pr-housekeeping/workflow.edn` is the safe first slice of a maintainer workflow for open pull requests.

This is an opinionated housekeeping flow: it discovers open PRs, loops through all currently actionable PRs, and performs the appropriate repair/response path for each one. By default, it performs the workflow's actions: repair conflicts or comments in isolated worktrees, test/review, push changes, and post reviewed responses. With `dry-run=true`, it writes plans and would-run artifacts without mutating GitHub. It does not merge pull requests unless `merge-approved=true` is also set.

The workflow's process helpers are small Python scripts because process nodes communicate through the language-neutral JSON stdin/stdout protocol and these helpers primarily orchestrate `gh`, Git, and artifact files. The platform/runtime implementation remains Babashka/Clojure; the workflow contract, not helper implementation language, is the portability boundary.

## What it does

```text
sync-base-branch
  -> list-open-prs
  -> fetch-pr-states
  -> classify-prs
  -> plan-actions
  -> select-conflict-target
  -> conflict repair path for each conflicted PR
  -> mark conflict PR processed and loop
  -> select-comment-target after conflicts are exhausted
  -> comment handling path for each response-needed PR
  -> mark comment PR processed and loop
  -> done
```

The workflow first requires `repo-root` to have `base-branch` checked out and runs `git pull --ff-only origin <base-branch>`. This updates the local base without creating a merge commit and fails safely if the checkout is on another branch or cannot fast-forward. The default base branch is `main`.

The workflow writes:

```text
housekeeping/base-sync.json
housekeeping/open-prs.json
housekeeping/pr-states.json
housekeeping/actions.json
housekeeping/report.md
housekeeping/action-plan.md
housekeeping/planned/*.json
housekeeping/processed-prs.json
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

The command above runs the workflow for real using the workflow defaults. To preview the GitHub repair/response actions without mutating GitHub, opt into dry-run explicitly. Base synchronization still runs first and may fast-forward the local checkout:

```bash
./bin/tesseraft run examples/pr-housekeeping/workflow.edn \
  --run-id pr-housekeeping-check \
  --input repo-root=. \
  --input dry-run=true \
  --format json
```

The workflow automatically processes conflicted PRs first. After conflicts are exhausted, it processes every PR needing a response. `target-pr` can narrow a run to one PR, but the flow still decides what action is appropriate for that PR.

Comment handling writes feedback summaries, internal response drafts, and a separate post-ready response body. It tracks source comment IDs and embeds hidden response markers in posted comments so later runs do not reply to the same review comment again. If Pi makes code changes, tests and review run before push. Unless `dry-run=true` is set, validated code changes are pushed and reviewed response bodies are posted as consolidated PR comments.

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
  push rebased history with --force-with-lease unless dry-run=true

fix-comments / respond-only:
  prepare an isolated worktree from the actual PR head
  fetch issue comments, reviews, review comments, and existing housekeeping response markers
  design comment response/fix plan
  execute fixes when appropriate
  detect whether code changed
  run configured tests when code changed
  review fixes or no-change rationale
  commit changes when code changed
  push branch with --force-with-lease when code changed unless dry-run=true
  draft responses for every addressed comment
  write a concise post-ready response body without internal draft headings
  post the reviewed post-ready response as a consolidated PR comment with hidden source markers unless dry-run=true

ready-to-merge / merge:
  require merge-approved=true
  refuse to merge when dry-run=true
  verify approved, clean, and checks passing
  merge PR
```

Mutation paths should be useful by default: repair/comment actions run unless `dry-run=true` is explicitly set. Destructive or irreversible operations, such as merging approved PRs, remain separately gated by explicit inputs like `merge-approved=true`.
