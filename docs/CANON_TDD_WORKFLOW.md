# Canon TDD to PR workflow

`examples/canon-tdd-to-pr/workflow.edn` turns a user prompt into an approved agile use case, implements its behavioral scenarios one at a time using Kent Beck's Canon TDD loop, independently regression-tests and reviews the result, and creates a pull request from an isolated Git worktree.

This is a side-effecting example. The workflow can invoke Pi, create a branch and worktree, edit and commit files, push the branch, and create a GitHub pull request. See [WORKFLOW_RUNS.md](WORKFLOW_RUNS.md) for shared prerequisites and safe stepping guidance.

## Behavioral model

Canon TDD is represented explicitly:

1. Write and approve an agile use case without implementation design.
2. Build a list of behavioral test scenarios without concrete test code.
3. Select exactly one pending scenario.
4. Write one runnable test and independently verify meaningful red.
5. Make the current and all previous tests pass and independently verify green.
6. Optionally refactor, with a separate behavior-preservation check.
7. Mark the scenario complete, add newly discovered scenarios, and repeat until no pending scenarios remain.
8. Run broader regression testing and code review before drafting and creating the PR.

The workflow deliberately separates behavioral analysis, interface design while writing a test, implementation while making it pass, and optional implementation design while refactoring. It does not create all concrete tests up front.

## State sequence

```text
collect-prompt -> write-use-case -> approve-use-case
  -> build-test-list -> choose-branch -> ensure-worktree
  -> select-scenario
       -> write-one-test -> verify-red
       -> make-green -> verify-green
       -> optional-refactor
            -> verify-refactor (when refactoring occurred)
       -> update-test-list
            -> select-scenario (pending scenarios remain)
            -> regression-testing (list empty)
  -> review
       -> repair -> regression-testing (on findings)
  -> pr-draft -> create-pr -> done
```

The run is bounded by `:max-rounds 50`. Retry and scenario-loop transitions increment the round so failures cannot loop indefinitely.

## Use-case approval

`approve-use-case` is a human gate. It exposes the latest `use-case/use-case-<round>.md` and parks the run with status `blocked` before a branch or worktree is created.

Decisions:

- `approve` continues to behavioral test-list creation.
- `revise` returns to `write-use-case` for a new immutable revision.

Inspect the pending approval and use its exact `approval_id`:

```bash
./bin/tesseraft run inspect \
  --run-dir .agent-runs/canon-tdd-to-pr/<id> \
  --format json

./bin/tesseraft run decide \
  --run-dir .agent-runs/canon-tdd-to-pr/<id> \
  --approval-id approve-use-case-<attempt> \
  --decision approve \
  --summary 'Behavioral scope is correct' \
  --format json
```

Use `--decision revise` to request another use-case revision. A decision advances the approval state; continue with bounded `step` or `resume` commands.

## Starting safely

Linting has no Pi, Git, or GitHub side effects:

```bash
./bin/tesseraft lint examples/canon-tdd-to-pr/workflow.edn
```

Start without running a node:

```bash
./bin/tesseraft run start examples/canon-tdd-to-pr/workflow.edn \
  --run-id <id> \
  --input prompt='<desired behavior>' \
  --input repo-root=. \
  --input base-branch=main \
  --format json
```

Advance one node at a time:

```bash
./bin/tesseraft run step \
  --run-dir .agent-runs/canon-tdd-to-pr/<id> \
  --format json
```

The first two steps collect the prompt and run the use-case agent. The next step enters the approval gate and parks without creating a worktree. After approval, `build-test-list` and `choose-branch` invoke Pi; `ensure-worktree` is the first Git worktree side effect.

## Artifacts

Important artifact groups are:

- `prompt/` — original prompt in JSON and Markdown;
- `use-case/` — immutable use-case revisions and statuses;
- `test-list/` — initial behavioral list and immutable per-round snapshots;
- `design/` — repository constraints and branch name, not an upfront implementation design;
- `worktree/path.txt` — isolated checkout path;
- `tdd/` — selected scenarios, red/green/refactor reports, commands, discoveries, and statuses;
- `manual-testing/` — final independent regression evidence;
- `review/` and `repair/` — review decisions and bounded repairs;
- `pr/` — title, body, and created PR record.

Selection and update agents find the newest valid snapshot because workflow templates do not perform round arithmetic. Snapshots are immutable evidence; they do not replace the workflow definition as source of truth.

## Mock-mode limitation

Mock mode safely validates prompt collection, prompt rendering, and the approval request without invoking Pi:

```bash
./bin/tesseraft run examples/canon-tdd-to-pr/workflow.edn \
  --executor mock \
  --run-id canon-preapproval \
  --input prompt='Describe a small behavior change' \
  --input repo-root=. \
  --format json
```

The run parks at `approve-use-case`. Mock agents always emit `pass`; they cannot semantically determine whether a generated behavioral list still has pending scenarios. `pass` compatibility transitions allow bounded graph inspection, but a full mock run is not proof of the Canon TDD decisions. Use lint plus the pre-approval mock boundary as the safe default validation.

## Delivery automation

`ensure-worktree` and `create-pr` retain the same deterministic handlers and artifact inputs as `code-review-loop`:

- `:git/ensure-worktree` creates or reuses the implementation worktree using `design/branch-name.txt`.
- Agent edit/test/review nodes run from `{{run.worktree-dir}}`.
- `:github/create-pr` reads the PR title/body, branch file, and worktree path, then pushes and creates or reuses the PR.

Worktrees are not removed automatically. Follow the cleanup instructions in [WORKFLOW_RUNS.md](WORKFLOW_RUNS.md).
