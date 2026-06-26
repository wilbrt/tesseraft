# Safe workflow runs

This guide covers the side-effecting example workflows:

- `examples/prompt-to-pr/workflow.edn`
- `examples/review-loop/workflow.edn`

Linting and prompt-collection checks are safe. Full or unbounded runs invoke Pi with `--approve` and can create or check out branches, change files in the target repository, push to GitHub, and create pull requests.

## Prerequisites

Before running side-effecting nodes, make sure you have:

- `bb`, `pi`, and `gh` installed and on `PATH`.
- A clean git tree in the target repository.
- GitHub CLI authentication working: `gh auth status`.
- The base branch available, usually `main`.
- An optional deterministic `--run-id` so the run directory is easy to inspect.

## Safe checks before running

These checks do not run Pi or GitHub commands:

```bash
bb test
./bin/tesseraft lint examples/prompt-to-pr/workflow.edn
./bin/tesseraft lint examples/review-loop/workflow.edn
```

For a prompt-collection-only check, start a run and execute just the first node:

```bash
./bin/tesseraft run start examples/prompt-to-pr/workflow.edn \
  --run-id <id> \
  --input prompt='<prompt>' \
  --input repo-root=. \
  --input base-branch=main \
  --format json

./bin/tesseraft run step --run-dir .agent-runs/prompt-to-pr/<id> --format json
```

That first `step` runs `collect-prompt`, which writes prompt artifacts and logs under `.agent-runs/...`; the next state is `design`, which invokes Pi.

Use the same pattern for review-loop with `.agent-runs/review-loop/<id>`.

## Step-by-step execution

Prefer explicit `start`, `step`, and bounded `resume` commands when learning or when you need to stop before PR creation.

Start a prompt-to-PR run without executing a node:

```bash
./bin/tesseraft run start examples/prompt-to-pr/workflow.edn \
  --run-id <id> \
  --input prompt='<prompt>' \
  --input repo-root=. \
  --input base-branch=main \
  --format json
```

Execute one node at a time:

```bash
./bin/tesseraft run step --run-dir .agent-runs/prompt-to-pr/<id> --format json
```

Resume with a bounded number of steps:

```bash
./bin/tesseraft run resume \
  --run-dir .agent-runs/prompt-to-pr/<id> \
  --max-steps <n> \
  --format json
```

For review-loop, use `examples/review-loop/workflow.edn` and `.agent-runs/review-loop/<id>`.

## Inspecting run state and artifacts

Inspect current state with:

```bash
./bin/tesseraft run inspect --run-dir .agent-runs/prompt-to-pr/<id> --format json
```

Useful run files and directories include:

- `state.edn` — current run context, state, status, round, attempt, workflow file, and inputs.
- `events.jsonl` — run, node, transition, and effect events.
- `issues.json` — merged execution/review issues used by retry loops.
- `logs/` — process and Pi stdout/stderr logs.
- `prompts/generated/` — rendered prompts sent to Pi.
- `pi-sessions/` — Pi session data.
- `prompt/`, `design/`, `execution/`, `review/`, and `pr/` — workflow artifacts declared by the nodes.

The key state sequence is:

```text
collect-prompt -> design -> ensure-branch -> execute -> review -> pr-draft -> create-pr -> done
```

`review-loop` uses the same state shape, with an explicit pass/fail review artifact loop. Failed `execute` or `review` steps merge issues, increment the round, and return to `execute` until the workflow passes or fails.

## Where side effects happen

- `collect-prompt` runs a local process and writes `prompt/prompt.json`, `prompt/prompt.md`, and logs under the run directory.
- Agent nodes (`design`, `execute`, `review`, `pr-draft`) render prompts, then run `pi --approve` in `repo-root`. They can read and write according to the node tools and prompts.
- `ensure-branch` runs `git fetch origin`, then checks out an existing branch or creates one from the base branch.
- `create-pr` pushes the branch and creates or reuses a GitHub pull request via `gh`, writing `pr/pr.json`.

## Stopping before PR creation

Do not use an unbounded full `run` if you want to avoid PR creation. Use `start` plus repeated `step`, or a small `--max-steps`, and inspect the state between steps.

Safe stop points:

- Stop at `pr-draft` if you do not want PR title/body generation to run.
- If `pr/pr-title.txt` and `pr/pr-body.md` exist and the current state is `create-pr`, stop there. The next `step` performs the push/PR side effect.

## Cleanup

Run data is under `.agent-runs/<workflow>/<run-id>`. Branches created by `ensure-branch` are normal git branches in the target repository and require normal git cleanup if unwanted.
