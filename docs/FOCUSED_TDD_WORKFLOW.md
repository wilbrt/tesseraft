# Focused TDD to PR workflow

`examples/focused-tdd-to-pr/workflow.edn` is a lightweight route from a prompt to a reviewed pull request. Focused TDD is an implementation discipline inside one coherent execution state, not a scenario-by-scenario workflow state machine.

Use it when a change benefits from local red/green iteration, mandatory repository validation, and an independent whole-diff review without Canon's immutable per-scenario evidence. Use [`canon-tdd-to-pr`](CANON_TDD_WORKFLOW.md) when independently orchestrated red/green/refactor evidence is worth the additional agent sessions. `code-review-loop` is similar in shape but uses an agentic regression-testing state rather than a workflow-owned deterministic validation plan.

See [WORKFLOW_RUNS.md](WORKFLOW_RUNS.md) before running this side-effecting workflow.

## State sequence

```text
collect-prompt -> design -> ensure-worktree -> execute-tdd
  -> run-validation -> review -> pr-draft -> create-pr -> done

execute-tdd incomplete -> execute-tdd
run-validation failure -> execute-tdd
review failure -> execute-tdd
```

The happy path has three substantive engineering agents before PR drafting: one concise design session, one implementation session, and one independent review session.

## Responsibilities

- `design` records intended behavior, non-goals, relevant repository surfaces, important constraints and risks, repository-supported validation commands, and a branch name. It does not create scenarios or audit ledgers.
- `execute-tdd` implements the complete coherent request. It uses focused red/green tests where practical, inspects named consumers and boundaries, runs narrow checks while editing, preserves validated work, and commits coherent progress locally.
- `run-validation` executes every command in `design/validation-plan.json`. Command exit status and timeout are authoritative; a model cannot reinterpret failure as success.
- `review` independently reviews the complete base-branch diff for correctness, security, regressions, maintainability, scope, compatibility, and test adequacy.
- `pr-draft` prepares metadata only. `create-pr` is the first push/GitHub mutation.

## Current feedback and rounds

Feedback is current-only. Execution inspects the newest round-stamped issue file across `execution/`, `validation/`, and `review/`; older reports remain historical artifacts and are not merged into a growing backlog.

A round advances only when feedback returns control to `execute-tdd`:

- execution reports incomplete;
- deterministic validation fails;
- review fails.

Successful handoffs do not consume rounds. `max-rounds` is 10. Design and PR-draft retries use attempts rather than implementation rounds.

## Artifacts

The durable progress record is intentionally small:

```text
prompt/prompt.{json,md}
design/design.md
design/status-<attempt>.json
design/validation-plan.json
design/branch-name.txt
execution/summary-<round>.md
execution/status-<round>.json
execution/issues-<round>.json       # failure only
validation/report-<round>.md
validation/issues-<round>.json      # failure only
review/report-<round>.md
review/status-<round>.json
review/issues-<round>.json          # failure only
pr/draft-status-<attempt>.json
pr/pr-title.txt
pr/pr-body.md
pr/pr.json
```

There are no scenario lists, current-scenario files, mandatory red manifests, or immutable per-scenario snapshots.

## Safe validation

Linting and focused tests have no Pi or GitHub side effects. The contract test includes a mock feedback cycle whose worktree and PR handlers are side-effect-free:

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

This workflow does not prove every test was observed red first and does not reconstruct TDD history. A long coherent execution session may cost more than one narrowly scoped scenario session, and implementation quality depends on the execute prompt plus final validation/review. Those trade-offs are intentional; choose Canon for stronger audit semantics.
