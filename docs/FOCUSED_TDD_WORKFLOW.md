# Focused TDD to PR workflow

`examples/focused-tdd-to-pr/workflow.edn` is a lower-token alternative to the full Canon workflow. It keeps deterministic red, accumulated green, and final regression gates while reducing each unmet scenario to two agent sessions: prepare one test, then implement and optionally refactor it.

Use it when a change benefits from behavioral TDD evidence but does not require the full phase-by-phase Canon audit trail. See [WORKFLOW_RUNS.md](WORKFLOW_RUNS.md) before running this side-effecting workflow.

## State sequence

```text
collect-prompt -> design -> ensure-worktree
  -> prepare-test
       -> run-red-check -> implement-green -> run-green-check -> prepare-test
       -> run-regression-plan (when no pending scenarios remain)
  -> review
       -> repair -> prepare-test -> run-regression-plan
  -> pr-draft -> create-pr -> done
```

## Efficiency and convergence rules

- Design creates at most eight non-overlapping behavioral scenarios and a bounded broad validation plan.
- `prepare-test` may classify already-supported behavior as `regression-covered`; it must not manufacture red or retry unchanged input.
- One preparation agent owns coverage reconciliation, scenario selection, and test authoring. One green agent owns minimal implementation, optional post-green refactoring, discoveries, and inventory update.
- Red, accumulated green, and broad-plus-focused regression commands run through `scripts/run_validation.py`, not a model.
- Review and repair consume only the newest current findings. The workflow deliberately does not apply `merge-issues`, avoiding an ever-growing historical issue backlog.
- Review must accept trustworthy `regression-covered` evidence and may not demand reconstruction of immutable historical red states.
- Repair-added uncovered behavior is returned to `prepare-test` as a pending scenario.
- `max-rounds` is 20. Rounds advance after completed scenarios, retries, failed reviews, and successful repair handoffs, bounding both legitimate work and non-progress while keeping repair and preparation snapshots ordered.

## Evidence model

The design agent writes:

- `design/design.md` and `design/repository-constraints.md`;
- `design/validation-plan.json` containing deterministic broad checks;
- `test-list/scenarios-initial.{json,md}` with 1–8 scenarios;
- `design/branch-name.txt`.

For unmet scenarios, the workflow records a test-only worktree diff and deterministic red result before implementation. The green agent commits the coherent test and production increment, and the process runner executes the latest focused manifest for every scenario. Immutable scenario snapshots use:

- `scenarios-<round>.json` after coverage reconciliation/test preparation;
- `scenarios-<round>-final.json` after implementation;
- `scenarios-<round>-repair.json` when review exposes uncovered behavior.

Already-supported scenarios use `regression-covered` with concrete existing-test evidence rather than fabricated red history. Final regression rejects any remaining `pending` scenario.

## Safe validation

Linting and focused tests have no Pi or GitHub side effects:

```bash
./bin/tesseraft lint examples/focused-tdd-to-pr/workflow.edn
python3 test/focused-tdd-workflow.test.py
```

Start without running a node:

```bash
./bin/tesseraft run start examples/focused-tdd-to-pr/workflow.edn \
  --run-id <id> \
  --input prompt='<desired behavior>' \
  --input repo-root=. \
  --input base-branch=main \
  --format json
```

Advance with `step` or a bounded `resume`. `ensure-worktree` creates the first Git worktree side effect. `create-pr` pushes and creates or reuses the pull request. Worktrees are not automatically removed.

## Deliberate limitations

Tesseraft currently has a global round bound rather than per-state retry budgets or a native no-progress detector. This workflow compensates by limiting scenario count, avoiding accumulated issue merging, routing already-satisfied behavior forward, and incrementing rounds on every retry. It provides less independently separated semantic assessment than `canon-tdd-to-pr`; choose Canon when that stronger audit boundary justifies its additional model usage.
