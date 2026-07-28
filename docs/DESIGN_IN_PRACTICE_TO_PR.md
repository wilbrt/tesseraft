# Design in Practice to PR workflow

`examples/design-in-practice-to-pr/workflow.edn` turns a prompt into a problem-grounded design, isolated implementation, tiered deterministic validation, independent review, and pull request. It incorporates Rich Hickey's “Design in Practice” techniques without assigning each design phase to a separate model session.

This is a side-effecting workflow. A real run can invoke Pi, create a Git worktree, edit and commit files, execute repository commands, push a branch, and create a GitHub pull request. Use `start`, `step`, and bounded `resume` as described in [WORKFLOW_RUNS.md](WORKFLOW_RUNS.md).

## State sequence

```text
collect-prompt -> collect-context -> design -> check-design
  -> ensure-worktree -> implement -> validate -> review
  -> assemble-pr -> create-pr -> record-learning -> done

implementation/validation/review failure
  -> prepare-feedback
       -> implement          (new evidence/progress)
       -> supervisor         (repeated or unchanged evidence)
       -> intervention       (still stalled after supervision)
```

## Design contract

One design session performs:

1. Describe the observed situation without asserting a cause.
2. Diagnose the unmet objective, obstacle, hypotheses, and evidence.
3. Delimit one solution-free problem statement and scope.
4. Compare status quo and alternatives against salient criteria.
5. Select a direction with explicit tradeoffs.
6. Mark out the implementation and deterministic validation plan.
7. Decide to proceed or report missing critical evidence.

The design is bounded to `design/brief.md` plus a schema-checked tiered `design/validation-plan.json`, branch name, and PR title. `check-design` rejects missing sections, unsafe branches, invalid commands, duplicate checks, or out-of-order tiers before any worktree side effect.

## Deterministic-first testing

Agents may author tests but may not execute tests, lint, builds, type checks, `bb`, or `npm`. `run_validation.py` is authoritative:

- commands are argv arrays with bounded timeouts;
- tiers are ordered `focused`, `repository`, then optional `browser`;
- execution stops at the first failed check;
- expected command failures produce `status: fail` and structured current issues;
- malformed plans and runner faults exit nonzero as external failures;
- `bb test` status/README derived drift is self-healed using the established deterministic-gate behavior.

For Tesseraft changes, designs should include a focused test command when available and `bb test`; include Playwright only for browser-visible/Web UI changes.

## Token and convergence policy

The normal path has three substantive model sessions: design, implementation, and review. PR assembly and run telemetry are deterministic.

Correction agents receive `feedback/current.json`, not a merged historical backlog. The process node records failure and work fingerprints:

- new evidence routes directly to implementation;
- repeated evidence or unchanged work routes to a read-only supervisor;
- continued stalling after two supervisor handoffs blocks for human retry/stop;
- current feedback and supervision handoffs are each limited to 4 KB;
- exact failure fingerprints drive retries while normalized failure classes expose common causes;
- validation-plan command paths are immutable implementation handoffs, preventing avoidable missing-entrypoint rounds;
- global rounds are bounded at eight.

Full reports remain durable evidence but are not default correction context.

## Learning contract

`knowledge/prior-run-lessons.md` contains reviewed lessons from prior Canon, focused, deterministic, and supervised runs. Runtime never edits it.

Every completed or operator-stopped run writes `learning/run-summary.json` with rounds, event counts, feedback fingerprints, supervision count, PR presence, and executor-reported session/token/cost data when available. Token totals explicitly include cache reads where the executor reports them. Promoting observations into workflow guidance is a separate reviewed authoring change.

The first reviewed run, FI2-DIP1, opened PR #87 at round 5 using nine agent sessions and $8.59 recorded executor cost. It validated current-only feedback and semantic review, and motivated immutable validation entrypoints, normalized failure classes, and concise full-change PR synthesis. These observations are versioned in the package's prior-run lessons.

## Safe checks

```bash
./bin/tesseraft lint examples/design-in-practice-to-pr/workflow.edn --strict
python3 test/design-in-practice-workflow.test.py
bb test
```

Start without executing a node:

```bash
./bin/tesseraft run start examples/design-in-practice-to-pr/workflow.edn \
  --run-id <id> \
  --input prompt='<request>' \
  --input repo-root=. \
  --input base-branch=main \
  --format json
```

The first two steps are deterministic prompt/context collection. The third invokes the design agent. `ensure-worktree` is the first Git side effect; `create-pr` is the first push/GitHub mutation.
