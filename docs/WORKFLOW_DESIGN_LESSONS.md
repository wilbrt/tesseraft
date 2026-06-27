# Workflow Design Lessons

Lessons from building and live-running `examples/pr-housekeeping/workflow.edn`.

## Principles

1. **One workflow should encode one opinionated behavior.**
   If users want different behavior, create a different workflow. Avoid turning a workflow into a mode-heavy tool.

2. **`dry-run` is a safety boundary, not a mode.**
   A dry run should traverse the same graph and write would-run artifacts. A non-dry run should perform the workflow's intended actions.

3. **Queue workflows should drain the queue.**
   If the point is housekeeping, one run should process all currently actionable items:

   ```text
   discover -> classify -> select unprocessed item -> act -> mark processed -> loop
   ```

4. **Loop artifacts need per-item paths.**
   Shared paths like `push-summary.md` are overwritten in loops. Prefer paths such as `conflict-repair/pr-10/push-summary.md`.

5. **Every external mutation needs an idempotency key.**
   Posted comments use hidden source markers, for example:

   ```html
   <!-- pr-housekeeping-response: review-comment:<id> -->
   ```

   Branch updates should similarly track observed head SHAs and use `--force-with-lease`.

6. **Rebase success means changed history, not necessarily uncommitted files.**
   Record the original PR head, rebase, then verify current `HEAD` differs before pushing. Do not require a new commit after a successful rebase.

7. **Public output should be separate from internal trace artifacts.**
   Keep internal drafts for auditability, but post only reviewed, polished bodies.

8. **Review before mutation.**
   Use the pattern:

   ```text
   agent handles task -> deterministic checks -> agent review -> deterministic mutation
   ```

9. **Worktrees are the right isolation boundary for branch mutation.**
   Each PR repair should happen in its own worktree. Generated worktrees must stay ignored and uncommitted.

10. **Live dogfooding is required for mutating workflows.**
    Dry-runs are necessary but do not catch everything: uncommitted pushes, duplicate comments, branch divergence, and artifact overwrites appeared only during live runs.

## Composition patterns to reuse

- Discovery/classification artifacts:
  - `open-prs.json`
  - `pr-states.json`
  - `actions.json`
  - `action-plan.md`
- Queue progress artifact:
  - `processed-prs.json`
- Isolated mutation path:
  - prepare worktree
  - execute fix/response
  - run tests
  - review
  - commit or verify rebased head
  - push or post
  - mark processed
- Comment response path:
  - fetch feedback
  - compute unreplied source IDs
  - draft internal response
  - produce post-ready body
  - add hidden idempotency markers
  - post consolidated PR comment

## Platform gaps suggested by the exercise

Future workflow composition would benefit from first-class support for:

- foreach / queue loops,
- per-item artifact namespaces,
- reusable worktree repair subflows,
- idempotent GitHub mutation helpers,
- durable external-mutation receipts,
- local branch reconciliation after self-mutating workflows.
