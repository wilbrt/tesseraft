# Design in Practice to PR workflow

`examples/design-in-practice-to-pr/workflow.edn` turns a prompt into a problem-grounded design, isolated implementation, tiered deterministic validation, independent review, and pull request. It incorporates Rich Hickey's “Design in Practice” techniques without assigning each design phase to a separate model session.

This is a side-effecting workflow. A real run invokes the subscription-authenticated Claude Code executor, creates a Git worktree, edits and commits files, executes repository commands, pushes a branch, and creates a GitHub pull request. Design, independent review, and supervision use `claude-opus-5`; implementation and corrections use `claude-sonnet-5`. The executor strips `ANTHROPIC_API_KEY` so Claude Code uses its CLI login rather than API-key billing. Use `start`, `step`, and bounded `resume` as described in [WORKFLOW_RUNS.md](WORKFLOW_RUNS.md).

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
- exact failure fingerprints include a bounded diagnostic signature, while normalized failure classes expose common causes;
- validation-plan command paths are immutable implementation handoffs, preventing avoidable missing-entrypoint rounds;
- a soft correction budget of eight routes to human intervention, while a hard runtime safety cap of twelve prevents unbounded execution without bypassing intervention/telemetry.

Full reports remain durable evidence but are not default correction context.

## Learning contract

`knowledge/prior-run-lessons.md` contains reviewed lessons from prior Canon, focused, deterministic, and supervised runs. Runtime never edits it.

Every completed or operator-stopped run writes `learning/run-summary.json` with rounds, event counts, feedback fingerprints, supervision count, PR presence, and executor-reported session/token/cost data when available. Token totals explicitly include cache reads where the executor reports them. Promoting observations into workflow guidance is a separate reviewed authoring change.

The first reviewed run, FI2-DIP1, opened PR #87 at round 5 using nine agent sessions and $8.59 recorded executor cost. It validated current-only feedback and semantic review, and motivated immutable validation entrypoints, normalized failure classes, and concise full-change PR synthesis.

FI3-DIP1 reached the original hard limit with one minor review finding left after 15 sessions and $15.53 recorded cost. It proved that changed assertions under one check need diagnostic-sensitive fingerprints and that a hard limit must not preempt intervention/telemetry. FI3-DIP2 preserved that branch and opened PR #89 in round 1 with three sessions and $2.28 recorded cost. Replacement-run PR synthesis uses the whole-diff review for its summary while keeping the focused design problem as the final correction.

FI4-DIP1 opened PR #90 in round 3 with six sessions and $6.27 recorded cost. Two distinct failures routed directly to correction with no unnecessary supervision, validating diagnostic-sensitive fingerprints. It also established that replacement detection must treat only a nonblank string branch as explicit—JSON null is an ordinary run.

FI5-DIP1 preserved three implementation commits but became terminal when an interrupted process-validation attempt was correctly classified as orphaned. An operator-authorized executor handoff moved subsequent Design-in-Practice agent nodes to Claude Code. FI5-DIP2 continued the branch and opened PR #91 in round 4 with ten Claude sessions, three feedback cycles, and one supervision handoff. Claude review artifact shape exposed a correction-handoff gap; prompts now require canonical issue arrays and feedback defensively normalizes observed wrappers/aliases.

FI6-DIP1 was interrupted during implementation and preserved as an orphaned run plus WIP branch commit. FI6-DIP2 reused the branch with the exact original ticket prompt and no mid-run operator prompt injection, opening PR #92 in round 5 with ten Claude sessions, four workflow-owned feedback cycles, and no supervision. FI7-DIP1 opened PR #93 in round 5 with nine Claude sessions, four workflow-owned feedback cycles, and no supervision or operator prompt injection. FI8-DIP1 opened PR #94 in round 5 with ten Claude sessions, four workflow-owned feedback cycles, and no supervision or operator prompt injection. These observations are versioned in the package's prior-run lessons.

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
