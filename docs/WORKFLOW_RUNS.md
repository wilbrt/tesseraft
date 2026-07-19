# Safe workflow runs

This guide covers the side-effecting implementation workflows:

- `examples/prompt-to-pr/workflow.edn`
- `examples/code-review-loop/workflow.edn`
- `examples/canon-tdd-to-pr/workflow.edn`

Linting and prompt-collection checks are safe. Full or unbounded runs invoke Pi
with `--approve` and can create worktrees, change files in the target repository,
push to GitHub, and create pull requests.

## Prerequisites

Before running side-effecting nodes, make sure you have:

- `bb`, `pi`, and `gh` installed and on `PATH`;
- a clean Git tree in the target repository;
- GitHub CLI authentication working (`gh auth status`);
- GitHub SSH write access for branch publication;
- the base branch available, usually `main`;
- an optional deterministic `--run-id` so the run directory is easy to inspect.

## Safe checks before running

These checks do not run Pi or GitHub commands:

```bash
bb test
./bin/tesseraft lint examples/prompt-to-pr/workflow.edn
./bin/tesseraft lint examples/code-review-loop/workflow.edn
./bin/tesseraft lint examples/canon-tdd-to-pr/workflow.edn
```

For a prompt-collection-only check, start a run and execute just the first node:

```bash
./bin/tesseraft run start examples/code-review-loop/workflow.edn \
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
./bin/tesseraft run start examples/code-review-loop/workflow.edn \
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

Use the same command shape with `examples/prompt-to-pr/workflow.edn` and
`.agent-runs/prompt-to-pr/<id>` for the simpler prompt-to-PR flow.

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
- `prompt/`, `design/`, `execution/`, `manual-testing/`, `review/`, and `pr/` —
  workflow artifacts declared by the nodes.

The code-review-loop state sequence is:

```text
collect-prompt -> design -> ensure-worktree -> execute
  -> manual-testing -> review -> pr-draft -> create-pr -> done
```

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
[CANON_TDD_WORKFLOW.md](CANON_TDD_WORKFLOW.md) for the artifact model, Canon
loop semantics, deterministic validation, and safe bounded mock guidance.

## Where side effects happen

- `collect-prompt` runs a local process and writes `prompt/prompt.json`,
  `prompt/prompt.md`, and logs under the run directory.
- Agent nodes render prompts, then run `pi --approve` in their configured
  working directory. The Canon TDD workflow uses agents for use cases,
  test lists, scenario/test authoring, semantic red assessment, implementation,
  refactoring, repair, and review.
- Canon TDD red/green/post-refactor/final-regression commands run through a
  workflow-owned process helper from explicit validation manifests. Expected
  failed checks select normal retry transitions; runner faults remain external
  process failures.
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
