# Design-Interrogated TDD to PR workflow

`examples/catalog/design-interrogated-tdd-to-pr/workflow.edn` extends the lightweight focused-TDD workflow with two high-capability design controls: an independent pre-implementation design interrogation and a mandatory failure-design step before every correction attempt.

Use it when implementation can remain a coherent focused-TDD session, but architectural fit, reuse, and repeated-loop failures deserve more deliberate reasoning. Use [`focused-tdd-to-pr`](FOCUSED_TDD_WORKFLOW.md) when direct correction cycles are preferable, or [`canon-tdd-to-pr`](CANON_TDD_WORKFLOW.md) when independently orchestrated per-scenario red/green evidence matters more.

See [WORKFLOW_RUNS.md](../reference/WORKFLOW_RUNS.md) before running this side-effecting workflow.

## State sequence

```text
collect-prompt -> design -> design-interrogation -> ensure-worktree
  -> execute-tdd -> run-validation -> review -> pr-draft -> create-pr -> done

design-interrogation material critique -> design -> design-interrogation
execute-tdd incomplete -----------------> failure-design -> execute-tdd
run-validation failure -----------------> failure-design -> execute-tdd
review failure -------------------------> failure-design -> execute-tdd
```

`design-interrogation` is an independent gate. It never edits the proposed design. On a material critique, it writes an evidence-backed report and issues, then returns control to `design`; the designer consumes the newest critique, revises the design and validation plan, and submits them for interrogation again. Optional preferences do not block implementation.

`failure-design` runs after the failure transition has advanced the round. It inspects the newest authoritative failure, current diff, relevant architecture, tests, and prior attempts. It then writes correction guidance for that round before the lower-cost implementer can run again. If the designer lacks enough evidence for responsible guidance, it retries itself instead of handing an empty plan to implementation.

## Design focus

The interrogation and failure-design prompts explicitly investigate:

- existing implementations, helpers, schemas, flows, and test utilities that should be reused;
- duplicated code, policy, state, control flow, and competing sources of truth;
- responsibility placement, layering, coupling, and architectural boundaries;
- affected producers, consumers, APIs, persistence formats, migrations, and compatibility;
- whether validation exercises the actual seams and regression risks;
- whether a failing loop is attacking a symptom instead of its root contract.

The interrogation and failure-design states use `gpt-5.6-sol` with high thinking. The initial designer uses the same model with medium thinking, while `execute-tdd` retains the lower-cost `gpt-5.5` model and receives the newest failure-design guidance.

## Current feedback and rounds

The workflow keeps focused TDD's current-only feedback rule. Execution and failure design select the newest round-stamped issue file across `execution/`, `validation/`, and `review/`; older reports remain historical evidence rather than a merged backlog.

A round advances when execution, deterministic validation, or review fails. Each such transition goes to `failure-design`. Initial design/interrogation retries and failure-design's own evidence retry use attempts without consuming another implementation round. `max-rounds` is 10.

## Artifacts

The focused workflow artifacts remain, with these additions:

```text
design-interrogation/report-<attempt>.md
design-interrogation/status-<attempt>.json
design-interrogation/issues-<attempt>.json   # material critique only
failure-design/guidance-<round>.md
failure-design/status-<attempt>.json
```

`failure-design/guidance-<round>.md` records the diagnosed root cause, preserved validated work, recommended correction boundary, files or interfaces to inspect, tests to drive the correction, acceptance criteria, and approaches not to retry.

## Safe validation

Linting and the contract tests do not invoke Pi or GitHub:

```bash
./bin/tesseraft lint examples/catalog/design-interrogated-tdd-to-pr/workflow.edn
python3 test/design-interrogated-tdd-workflow.test.py
```

Start without running a node:

```bash
./bin/tesseraft run start examples/catalog/design-interrogated-tdd-to-pr/workflow.edn \
  --run-id <id> \
  --input prompt='<desired behavior>' \
  --input repo-root=. \
  --input base-branch=main \
  --format json
```

Advance with `step` or a bounded `resume`. `ensure-worktree` is the first Git side effect. `create-pr` is the first push/GitHub mutation. Worktrees are not removed automatically.
