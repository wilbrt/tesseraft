# Safe workflow runs

This guide covers the side-effecting implementation workflows:

- `examples/catalog/prompt-to-pr/workflow.edn`
- `examples/catalog/code-review-loop/workflow.edn`
- `examples/catalog/playwright-code-review-loop/workflow.edn`
- `examples/catalog/deterministic-code-review-loop/workflow.edn`
- `examples/catalog/supervised-deterministic-code-review-loop/workflow.edn`
- `examples/catalog/design-in-practice-to-pr/workflow.edn`
- `examples/catalog/canon-tdd-to-pr/workflow.edn`
- `examples/catalog/focused-tdd-to-pr/workflow.edn`
- `examples/catalog/design-interrogated-tdd-to-pr/workflow.edn`

Linting and prompt-collection checks are safe. Full or unbounded runs invoke Pi
with `--approve` and can create worktrees, change files in the target repository,
push to GitHub, and create pull requests.

## Prerequisites

Before running side-effecting nodes, make sure you have:

- `bb`, Python, Git, and `gh` installed and on `PATH`;
- the repository's npm dependencies installed with `npm ci`; this provides the
  pinned Pi and OpenCode CLIs under `node_modules/.bin`, which
  `./bin/tesseraft` adds to workflow `PATH`;
- for `playwright-code-review-loop`, `deterministic-code-review-loop`, and `supervised-deterministic-code-review-loop`, Node.js dependencies and the pinned Playwright Chromium browser installed in the target repository;
- a clean Git tree in the target repository;
- GitHub CLI authentication working (`gh auth status`);
- GitHub SSH write access for branch publication;
- Pi authentication for the provider used by the workflow. For OpenCode Go,
  run `npm exec -- pi`, use `/login`, and paste an access token from
  [opencode.ai/auth](https://opencode.ai/auth). Headless runs can set
  `OPENCODE_API_KEY` instead;
- the base branch available, usually `main`;
- an optional deterministic `--run-id` so the run directory is easy to inspect.

Check the executable layer with `./bin/tesseraft doctor --profile workflow`.
Windows users can install and verify the complete layer with the
[WSL 2 quickstart](../guides/WINDOWS_QUICKSTART.md).

## Safe checks before running

These checks do not run Pi or GitHub commands:

```bash
bb test
./bin/tesseraft lint examples/catalog/prompt-to-pr/workflow.edn
./bin/tesseraft lint examples/catalog/code-review-loop/workflow.edn
./bin/tesseraft lint examples/catalog/playwright-code-review-loop/workflow.edn
./bin/tesseraft lint examples/catalog/design-in-practice-to-pr/workflow.edn --strict
./bin/tesseraft lint examples/catalog/canon-tdd-to-pr/workflow.edn
./bin/tesseraft lint examples/catalog/focused-tdd-to-pr/workflow.edn
./bin/tesseraft lint examples/catalog/design-interrogated-tdd-to-pr/workflow.edn
```

For a prompt-collection-only check, start a run and execute just the first node:

```bash
./bin/tesseraft run start examples/catalog/code-review-loop/workflow.edn \
  --run-id <id> \
  --input prompt='<prompt>' \
  --input repo-root=. \
  --input base-branch=main \
  --format json

./bin/tesseraft run step \
  --run-dir .agent-runs/code-review-loop/<id> \
  --format json
```

That first `step` runs `collect-prompt`, which writes prompt artifacts and logs
under `.agent-runs/...`; the next state is `design`, which invokes Pi.

## Step-by-step execution

Prefer explicit `start`, `step`, and bounded `resume` commands when learning or
when you need to stop before PR creation.

Start a code-review-loop run without executing a node:

```bash
./bin/tesseraft run start examples/catalog/code-review-loop/workflow.edn \
  --run-id <id> \
  --input prompt='<prompt>' \
  --input repo-root=. \
  --input base-branch=main \
  --format json
```

Execute one node at a time:

```bash
./bin/tesseraft run step \
  --run-dir .agent-runs/code-review-loop/<id> \
  --format json
```

Resume with a bounded number of steps:

```bash
./bin/tesseraft run resume \
  --run-dir .agent-runs/code-review-loop/<id> \
  --max-steps <n> \
  --format json
```

Review every run currently waiting at an approval gate with the interactive
approval inbox:

```bash
./bin/tesseraft approvals
```

The inbox presents the authored question, previews run-relative context
artifacts, explains each allowed transition, accepts an optional decision
message, and asks whether to resume immediately. A workflow can require a
message for a particular option, which is useful for rejection or
changes-requested transitions. For automation, use `approvals list --format
json` and `approvals decide --run <run-id> --approval-id <id> --decision
<transition> [--message <text>] [--annotations-json <json>] [--resume]`.

Pending status is not inferred from node type alone. Tesseraft requires all of
the following: the run is blocked, the durable approval request names the
run's current state and attempt, and no decision record has been written.

Use the same command shape with `examples/catalog/prompt-to-pr/workflow.edn` and
`.agent-runs/prompt-to-pr/<id>` for the simpler prompt-to-PR flow. Substitute
`examples/catalog/playwright-code-review-loop/workflow.edn` and
`.agent-runs/playwright-code-review-loop/<id>` to use the variant whose
regression gate runs `npm run web:e2e` in the implementation worktree.

The supervised deterministic variant uses
`examples/catalog/supervised-deterministic-code-review-loop/workflow.edn` and
`.agent-runs/supervised-deterministic-code-review-loop/<id>`. Its bb and
Playwright gates behave like the deterministic workflow. After every third
failed correction cycle, a source-read-only supervisor inspects recent durable
reports, summaries, issues, and logs, then writes `supervision/current.md` for
the next implementation attempt.

The Design in Practice variant uses
`examples/catalog/design-in-practice-to-pr/workflow.edn` and
`.agent-runs/design-in-practice-to-pr/<id>`. It derives a tiered deterministic
validation plan during design, short-circuits cheap checks before expensive
ones, supplies correction agents only compact current evidence, and invokes
supervision when failure/work fingerprints repeat. Its first two steps are
safe deterministic intake/context collection; design invokes Pi, worktree
creation is the first Git side effect, and `create-pr` is the push/GitHub
boundary. See [DESIGN_IN_PRACTICE_TO_PR.md](../guides/DESIGN_IN_PRACTICE_TO_PR.md).

The design-interrogated focused-TDD variant uses
`examples/catalog/design-interrogated-tdd-to-pr/workflow.edn` and
`.agent-runs/design-interrogated-tdd-to-pr/<id>`. An independent design gate
can return material architecture or duplication critiques to the designer
before worktree creation. After implementation, validation, or review fails, a
high-capability failure designer must diagnose the cause and write correction
guidance before the lower-cost implementer runs again. See
[DESIGN_INTERROGATED_TDD_WORKFLOW.md](../guides/DESIGN_INTERROGATED_TDD_WORKFLOW.md).

## Inspecting run state and artifacts

Inspect current state with:

```bash
./bin/tesseraft run inspect \
  --run-dir .agent-runs/code-review-loop/<id> \
  --format json
```

Useful run files and directories include:

- `state.edn` — current run context, state, status, round, attempt, workflow
  file, and inputs. External/runtime failures mark the run `failed` without
  advancing to a declared transition.
- `events.jsonl` — run, node, transition, and effect events. A started node is
  closed by `node.finished` for declared workflow outcomes or `node.failed` for
  external/runtime failures.
- `issues.json` — merged execution/review issues used by retry loops.
- `logs/` — process and Pi stdout/stderr logs.
- `prompts/generated/` — rendered prompts sent to Pi.
- `pi-sessions/` — Pi session data.
- `prompt/`, `design/`, `execution/`, `manual-testing/` or `playwright/`, `review/`, and `pr/` —
  workflow artifacts declared by the nodes.

The code-review-loop state sequence is:

```text
collect-prompt -> design -> ensure-worktree -> execute
  -> manual-testing -> review -> pr-draft -> create-pr -> done
```

The Playwright variant replaces only the regression-testing state:

```text
collect-prompt -> design -> ensure-worktree -> execute
  -> playwright-testing -> review -> pr-draft -> create-pr -> done
```

A nonzero or timed-out `npm run web:e2e` result writes a Playwright report and
issues, increments the round, and returns to `execute`. Malformed process
requests remain external failures.

Declared `status: fail` outcomes from execution or review merge issues,
increment the round where appropriate, and return to execution. This expected
outcome is distinct from an external/runtime failure such as a missing
dependency, subprocess crash, malformed output, timeout, or missing required
artifact. External failures leave durable `node.failed` evidence and require
explicit recovery or a replacement run.

The Canon TDD workflow adds a behavior-driven loop:

```text
collect-prompt -> write-use-case -> build-test-list
  -> choose-branch -> ensure-worktree
  -> select-scenario -> write-one-test -> run-red-check -> assess-red
  -> make-green -> run-green-check -> optional-refactor
  -> run-refactor-check (when refactored) -> update-test-list
  -> select-scenario (while pending)
  -> run-regression-plan -> review -> pr-draft -> create-pr -> done
```

A successful use case proceeds directly to test-list creation; there is no
human approval pause. Use bounded `step` or `resume` when you want to inspect
the generated use case before continuing. See
[CANON_TDD_WORKFLOW.md](../guides/CANON_TDD_WORKFLOW.md) for the artifact model, Canon
loop semantics, deterministic validation, and safe bounded mock guidance.

The focused TDD workflow keeps local red/green iteration inside one coherent
`execute-tdd` agent session. A deterministic final validation process and an
independent whole-diff review follow; execution, validation, and review failures
return directly to `execute-tdd` with only the newest current findings. It does
not create a scenario ledger or machine-enforce per-test red history. See
[FOCUSED_TDD_WORKFLOW.md](../guides/FOCUSED_TDD_WORKFLOW.md) for its artifact and
convergence model.

## Where side effects happen

- `collect-prompt` runs a local process and writes `prompt/prompt.json`,
  `prompt/prompt.md`, and logs under the run directory.
- Agent nodes render prompts, then run `pi --approve` in their configured
  working directory. The Playwright code-review-loop additionally runs
  `npm run web:e2e` in the implementation worktree and captures its output in
  the run directory. The Canon TDD workflow uses agents for use cases,
  test lists, scenario/test authoring, semantic red assessment, implementation,
  refactoring, repair, and review.
- Canon TDD red/green/post-refactor/final-regression commands run through a
  workflow-owned process helper from explicit validation manifests. Focused TDD
  uses its process helper only for the final repository validation plan.
  Expected failed checks select normal retry transitions; runner faults remain
  external process failures.
- `ensure-worktree` fetches `origin` and creates or reuses an isolated Git
  worktree and implementation branch.
- `create-pr` pushes the branch directly to the repository's GitHub SSH URL,
  then creates or reuses a GitHub pull request via `gh`, writing `pr/pr.json`.
  The push does not depend on an HTTPS OAuth token's `workflow` scope and does
  not rewrite `origin`. When `GH_TOKEN` is nonblank, Tesseraft passes it to all
  `gh` subprocesses and GitHub attributes the PR to that token's account. When
  it is absent, `gh` falls back to its active keyring login.

## Stopping before PR creation

Do not use an unbounded full `run` if you want to avoid PR creation. Use `start`
plus repeated `step`, or a small `--max-steps`, and inspect state between steps.

Safe stop points:

- Stop at `pr-draft` if you do not want PR title/body generation to run.
- If `pr/pr-title.txt` and `pr/pr-body.md` exist and the current state is
  `create-pr`, stop there. The next `step` performs the push/PR side effect.

## Cleanup

Run data is under `.agent-runs/<workflow>/<run-id>`. Worktrees and branches
created by `ensure-worktree` require normal Git cleanup when no longer needed:

```bash
git worktree list
git worktree remove <path>
git branch -d <branch>
```

## Recovering failed runs

A workflow run reaches a terminal state when something external to the workflow
itself breaks: a process exits nonzero, a node times out, the runner process is
killed mid-node, the round budget is exhausted, or an operator explicitly
cancels the run. Once a run is `"failed"` or `"cancelled"`, `step` and `resume`
refuse to drive it again. Use `run retry` to continue the run's durable lineage:

```bash
./bin/tesseraft run retry --run-dir .agent-runs/<workflow>/<run-id> \
  [--max-steps <n>] [--reason "..."] [--repin]
```

`retry` will:

- Refuse unless the run is `"failed"` or `"cancelled"`.
- Refuse if a live process still owns the run (`runtime-process.json` with a
  live pid). Cancel or wait for that process first.
- Re-hash the workflow file and refuse if it has changed since the run was
  pinned, unless `--repin` is given. `--repin` records the old and new hashes
  in a `run.recovery` audit event and proceeds.
- Bump the run's `attempt` counter by one, so every new node execution is keyed
  by a fresh `(state, attempt)` pair. This keeps the event-log proof trace
  intact: no duplicate `node.started` for the same pair, and orphan detection
  keeps working unchanged.
- Append a durable `run.recovery` event carrying the prior status, prior state,
  prior and new attempt, the operator reason, and the last terminal evidence
  (`node.failed`, `node.orphaned`, `run.max-rounds-exceeded`, or `run.cancelled`).
- Then drive the run exactly like `resume` with the bounded `--max-steps` budget.

### Triage table

| Last durable evidence | Diagnosis | Action |
| --- | --- | --- |
| `node.failed` with `error_type` `process_exit` / `timeout` / `malformed_output` / `missing` artifact | Transient infrastructure or a missing dependency; inspect `logs/` and the recorded error. | Fix the cause, then `run retry`. |
| `node.orphaned` | The runner process was killed while a node was in flight. | First verify the external world: check `git worktree list`, GitHub/PR state, artifact presence, and any side effects the node may have already performed. If the side effects did not complete, run `run retry`. If they did complete for an agent node, you may place the expected status artifact and run `step`; otherwise document the manual caveat. |
| `run.max-rounds-exceeded` | The workflow is not converging within the configured round budget. | Retry only after changing the approach (workflow, inputs, or problem framing). Without a change, the run will re-fail immediately. |
| `run.cancelled` | Operator cancelled the run. | Safe to retry. Owned processes were reaped at cancel time. |
| Status `"running"` with liveness `stale` or `orphaned` | The runner process died but the run was never marked terminal. | Run `run cancel` first to mark the run and nested fragment runs cancelled, then `run retry`. |

### Guarantees and caveats

- **Attempt-bump uniqueness**: retry always increments `run.attempt`, so a
  retried node starts a fresh attempt. Fragment nodes therefore create a fresh
  nested run at the new attempt; within that new attempt, the existing
  `durable-internal-run?` / `resumable-fragment?` resume machinery still applies.
- **Pin check**: retry refuses to run a pinned workflow against changed workflow
  source unless you explicitly `--repin` and record the hash change.
- **Single-writer**: retry refuses when a live process owns the run dir, so two
  runners never mutate the same run simultaneously.
- **Declared `status: fail`**: a workflow node that intentionally returns
  `"status":"fail"` is a workflow outcome, not a runtime failure. It drives a
  normal transition and may loop back into the workflow. It does not by itself
  make the run `"failed"` or eligible for retry.

See `SPEC.md` §13 for the normative retry semantics and
`docs/reference/CONTROL_PLANE_API.md` for how the same single-writer model applies to
future control-plane retry/resume/cancel endpoints.
