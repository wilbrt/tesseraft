# Canon TDD to PR workflow

`examples/canon-tdd-to-pr/workflow.edn` turns a user prompt into an agile use case, implements its behavioral scenarios one at a time using Kent Beck's Canon TDD loop, independently regression-tests and reviews the result, and creates a pull request from an isolated Git worktree.

This is a side-effecting example. The workflow can invoke Pi, create a branch and worktree, edit and commit files, push the branch, and create a GitHub pull request. See [WORKFLOW_RUNS.md](WORKFLOW_RUNS.md) for shared prerequisites and safe stepping guidance.

## Behavioral model

Canon TDD is represented explicitly:

1. Write an agile use case without implementation design.
2. Build a focused, non-overlapping list of behavioral test scenarios without concrete test code; pending scenarios must be capable of exposing missing or incorrect current behavior.
3. Select exactly one pending scenario that can provide meaningful red without borrowing behavior from another scenario.
4. Write one runnable test and a focused check manifest, execute it deterministically for red, then semantically assess that the failure represents only the selected behavior.
5. Make the current and all previous tests pass, then independently execute every accumulated focused check for green.
6. Optionally refactor, followed by the same deterministic behavior-preservation checks when files changed.
7. Mark the scenario complete, add newly discovered scenarios, and repeat until no pending scenarios remain.
8. Execute the declared broad validation plan plus all focused checks, then run code review before drafting and creating the PR.

The workflow deliberately separates behavioral analysis, interface design while writing a test, implementation while making it pass, and optional implementation design while refactoring. It does not create all concrete tests up front.

## State sequence

```text
collect-prompt -> write-use-case -> build-test-list
  -> choose-branch -> ensure-worktree
  -> select-scenario
       -> write-one-test -> run-red-check -> assess-red
       -> make-green -> run-green-check
       -> optional-refactor
            -> run-refactor-check (when refactoring occurred)
       -> update-test-list
            -> select-scenario (pending scenarios remain)
            -> run-regression-plan (list empty)
  -> review
       -> repair -> run-regression-plan (on findings)
  -> pr-draft -> create-pr -> done
```

The run is bounded by `:max-rounds 50`. Retry and scenario-loop transitions increment the round so failures cannot loop indefinitely.

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

The first two steps collect the prompt and run the use-case agent. A successful use case proceeds directly to `build-test-list`; there is no human approval pause. `build-test-list` and `choose-branch` invoke Pi, and `ensure-worktree` is the first Git worktree side effect. Use bounded `step` or `resume` when you want to inspect the use-case artifact before later nodes continue.

## Artifacts

Important artifact groups are:

- `prompt/` — original prompt in JSON and Markdown;
- `use-case/` — immutable use-case revisions and statuses;
- `test-list/` — initial behavioral list and immutable per-round snapshots;
- `design/` — repository constraints, branch name, and the explicit broad `validation-plan.json`, not an upfront implementation design;
- `worktree/path.txt` — isolated checkout path;
- `tdd/` — selected scenarios, per-scenario `check-<round>.json` manifests, deterministic red/green/refactor reports, semantic red assessments, discoveries, and statuses;
- `manual-testing/` — final deterministic broad-plus-focused regression evidence;
- `review/` and `repair/` — review decisions and bounded repairs;
- `pr/` — title, body, and created PR record.

Selection and update agents find the newest valid snapshot because workflow templates do not perform round arithmetic. Snapshots are immutable evidence; they do not replace the workflow definition as source of truth.

## Deterministic validation

Test execution is owned by `scripts/run_validation.py`, a process-node helper using the language-neutral JSON stdin/stdout protocol. It resolves the run's recorded worktree and executes only commands declared in versioned artifacts:

- `design/validation-plan.json` contains broad repository checks selected before implementation;
- each `tdd/check-<round>.json` contains one scenario's focused command, timeout, and expected red output markers;
- accumulated green/refactor checks use the latest manifest for each scenario;
- final regression combines the broad plan with all accumulated focused checks and rejects a test list that still contains pending scenarios.

Argv-array commands are preferred. Compound commands must be explicit strings with `"shell": true`. Every command has a bounded timeout. Reports capture command, exit code, timeout, stdout, and stderr. Red reports also capture tracked, staged, and untracked changed-file and diff evidence for `assess-red`; red fails when that evidence is empty, and the assessor may not waive missing or inconsistent evidence.

An expected red/green/regression gate failure exits the helper successfully and returns workflow `status: fail`, allowing declared retry transitions. Malformed manifests, missing worktrees, or runner crashes exit nonzero and become durable external `process_exit` failures. This keeps test failure distinct from validation-infrastructure failure.

`assess-red` remains a read-only agent because a nonzero exit cannot prove assertion quality or behavioral relevance. It has no shell tool and evaluates the deterministic report and referenced test code. Green, post-refactor, and final regression execution do not invoke a model.

Run the focused helper tests with:

```bash
python3 test/canon-validation-runner.test.py
```

## Mock-mode limitation

There is no automatic pause after use-case generation. To validate prompt collection and use-case prompt rendering without invoking Pi or reaching worktree creation, use a bounded mock run:

```bash
./bin/tesseraft run start examples/canon-tdd-to-pr/workflow.edn \
  --executor mock \
  --run-id canon-use-case-check \
  --input prompt='Describe a small behavior change' \
  --input repo-root=. \
  --format json

./bin/tesseraft run resume \
  --run-dir .agent-runs/canon-tdd-to-pr/canon-use-case-check \
  --max-steps 2 \
  --format json
```

After two steps, the run is positioned at `build-test-list` and no worktree has been created. Inspect `use-case/use-case-1.md` before continuing. Do not use an unbounded mock run as semantic proof: mock agents cannot create trustworthy test lists or validation manifests.

## Delivery automation

`ensure-worktree` and `create-pr` retain the same deterministic handlers and artifact inputs as `code-review-loop`:

- `:git/ensure-worktree` creates or reuses the implementation worktree using `design/branch-name.txt`.
- Agent authoring/implementation/refactoring/review nodes run from `{{run.worktree-dir}}`; deterministic validation process helpers explicitly execute their declared commands there.
- `:github/create-pr` reads the PR title/body, branch file, and worktree path, then pushes and creates or reuses the PR.

Worktrees are not removed automatically. Follow the cleanup instructions in [WORKFLOW_RUNS.md](WORKFLOW_RUNS.md).
