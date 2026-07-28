# Work item to PR

`work-item-to-pr` is the provider-neutral successor example for implementing a tracked work item and publishing a GitHub pull request. It has one graph for Plane, Jira, and GitHub Issues intake.

## What is provider-neutral

The first node fetches the selected project tracker through `:work-tracker/fetch-item` and writes `work-tracker/item.json` using `schemas/normalized-work-item.schema.json`. Agent prompts are instructed to use only normalized common fields: `identifier`, `title`, `description`, `state`, `priority`, `assignees`, `labels`, and `url`.

Tracker choice controls intake only. GitHub code-host/PR configuration and credentials control PR publication through `:github/create-pr`; selecting the GitHub Issues tracker does not supply PR transport credentials.

## Local mock fixtures

The fixture project contexts are non-secret and use inert credential references:

- `fixtures/plane-project.json`
- `fixtures/jira-project.json`
- `fixtures/github-issues-project.json`

Mock runs do not call Plane, Jira, GitHub Issues, GitHub PR APIs, or external credential stores.

```bash
./bin/tesseraft run examples/work-item-to-pr/workflow.edn \
  --executor mock \
  --project-context "$(cat examples/work-item-to-pr/fixtures/plane-project.json)" \
  --project-id wt6i-plane \
  --run-id work-item-plane-mock \
  --max-steps 7 \
  --input item-id=PLANE-42 \
  --input repo-root=. \
  --format json

./bin/tesseraft run examples/work-item-to-pr/workflow.edn \
  --executor mock \
  --project-context "$(cat examples/work-item-to-pr/fixtures/jira-project.json)" \
  --project-id wt6i-jira \
  --run-id work-item-jira-mock \
  --max-steps 7 \
  --input item-id=JIRA-42 \
  --input repo-root=. \
  --format json

./bin/tesseraft run examples/work-item-to-pr/workflow.edn \
  --executor mock \
  --project-context "$(cat examples/work-item-to-pr/fixtures/github-issues-project.json)" \
  --project-id wt6i-github-issues \
  --run-id work-item-github-issues-mock \
  --max-steps 7 \
  --input item-id=42 \
  --input repo-root=. \
  --format json
```

## Real-run prerequisites

Before any non-mock run, configure an explicit project work-tracker connection and separate GitHub PR transport credentials. A project with no tracker fails at the initial fetch before branch, agent, push, or PR effects.

Also ensure the target repository is clean, `pi` and `gh` are installed, GitHub CLI auth/SSH push access are ready, and the base branch exists.

## Safe bounded execution

Prefer `start`, one-node `step`, and bounded `resume --max-steps` while learning:

```bash
./bin/tesseraft run start examples/work-item-to-pr/workflow.edn \
  --project-id <project-id> \
  --run-id <run-id> \
  --input item-id=<item-id> \
  --input repo-root=. \
  --input base-branch=main \
  --format json

./bin/tesseraft run step \
  --run-dir .agent-runs/work-item-to-pr/<run-id> \
  --format json

./bin/tesseraft run resume \
  --run-dir .agent-runs/work-item-to-pr/<run-id> \
  --max-steps <n> \
  --format json
```

Stop when the run state is `create-pr` if you do not want branch push/PR creation. At that point `pr/pr-title.txt` and `pr/pr-body.md` have been drafted; the next step pushes and creates or reuses the pull request.
