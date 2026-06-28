# Tesseraft

Tesseraft is a package-split prototype for a workflow-as-code platform for deterministic and agentic state machines.

The name comes from tesserae: small pieces composed into intricate patterns. Tesseraft workflows use simple state nodes to build durable, inspectable agentic runs.

The important boundary is the workflow IaC file, not the implementation language. The current implementation is Babashka/Clojure because it is convenient for local CLI tooling, but the standalone contracts are JSON-compatible:

- `SPEC.md` defines the normative platform contract.
- `schemas/*.schema.json` define portable runtime/linter artifact formats.
- `bin/tesseraft lint` is a standalone linter CLI.
- `bin/tesseraft run` is a lightweight reference runner CLI.
- `bin/agent-workflow-lint` and `bin/agent-workflow-run` remain compatibility entry points.
- `bin/tesseraft control-plane` exposes a local read-only JSON inspection surface for workflows and runs.
- `examples/jira-to-pr/workflow.edn` is a real workflow declaration.
- `docs/CODE_STYLE.md` defines project code style and design principles.
- `docs/WEB_UI.md` defines initial Workflow Studio and Run Console product boundaries.
- `docs/WEB_UI_USE_CASES.md` documents Web UI user objectives before implementation details.
- `docs/WEB_UI_ARCHITECTURE.md` compares Web UI serving and control-plane architecture options.
- `docs/CONTROL_PLANE_API.md` sketches the initial local read-first control-plane API contract.
- `docs/PR_HOUSEKEEPING.md` describes the safe PR housekeeping workflow.

## Quick start

```bash
./scripts/check_deps.sh
./bin/tesseraft --version
./bin/tesseraft lint examples/jira-to-pr/workflow.edn
./bin/tesseraft lint examples/jira-to-pr/workflow.edn --format json
./bin/tesseraft lint examples/jira-to-pr/workflow.edn --emit mermaid
./bin/tesseraft control-plane workflows
./bin/tesseraft control-plane graph smoke-demo
```

The linter has no Pi, Jira, GitHub, or browser dependency. It only needs Babashka and the files being linted.

## Local smoke demo

`examples/smoke/workflow.edn` is a local-only workflow for validating the reference runner without Pi, Jira, GitHub, or browser dependencies.

```bash
./bin/tesseraft lint examples/smoke/workflow.edn
./bin/tesseraft run examples/smoke/workflow.edn --run-id smoke-demo --format json
```

Run the safe smoke checks with:

```bash
bb test
```

This lints the smoke, prompt-to-pr, worktree-to-pr, review-loop, and jira-to-pr example workflows, runs only the local smoke workflow, and verifies an invalid fixture fails lint. It does not run Pi, Jira, GitHub, or browser-dependent workflows.

## Example workflows

- `examples/smoke/workflow.edn` — local-only runner smoke test.
- `examples/prompt-to-pr/workflow.edn` — prompt collection, design, execution, review, and PR creation. Lint-only by default; running it invokes Pi and GitHub side effects.
- `examples/worktree-to-pr/workflow.edn` — prompt-to-PR variant that creates a deterministic Git worktree and runs execute/review/PR steps from that isolated checkout.
- `examples/review-loop/workflow.edn` — prompt-to-PR variant with an explicit pass/fail code-review artifact and review-fix loop before PR drafting and creation.
- See `docs/WORKFLOW_RUNS.md` for safe prompt-to-PR and review-loop run instructions.
- `examples/pr-housekeeping/workflow.edn` — safe PR housekeeping report that classifies open pull requests without mutating GitHub state.
- `examples/jira-to-pr/workflow.edn` — Jira-to-PR workflow with manual browser testing.

```bash
./bin/tesseraft lint examples/prompt-to-pr/workflow.edn
./bin/tesseraft lint examples/review-loop/workflow.edn
./bin/tesseraft lint examples/pr-housekeeping/workflow.edn
```

## Git branch and worktree modes

Tesseraft keeps the existing branch mode via `:git/ensure-branch`, which checks out the selected branch in `{{inputs.repo-root}}`. For isolated agent edits, use `:git/ensure-worktree` instead. It creates or reuses a deterministic worktree under `.agent-worktrees/<workflow>-<run-id>-<branch>`, writes the path artifact (default `worktree/path.txt`), and stores the path in `{{run.worktree-dir}}` for later nodes.

Minimal workflow fragment:

```edn
:ensure-worktree
{:type :deterministic
 :handler :git/ensure-worktree
 :runtime {:timeout "5m"}
 :inputs {:branch-file "design/branch-name.txt"}
 :outputs {:worktree-path {:path "worktree/path.txt" :required true}}
 :next :execute}

:execute
{:type :agent
 :executor :pi-cli
 :runtime {:cwd "{{run.worktree-dir}}" :timeout "90m"}
 ;; ...
 }
```

`github/create-pr` and other git helpers default to `{{run.worktree-dir}}` when present. You can also set deterministic node `:runtime {:cwd "{{run.worktree-dir}}"}` or `:inputs {:repo-dir-file "worktree/path.txt"}` explicitly.

Worktrees are not removed automatically. Cleanup is manual:

```bash
git worktree list
git worktree remove .agent-worktrees/<name>
git branch -D <branch>   # optional, after the PR/branch is no longer needed
```

## Package split

```text
src/agent_workflow/spec.clj        shared parser/normalizer/template helpers
src/agent_workflow/lint/core.clj   pure static linter library
src/agent_workflow/lint/cli.clj    standalone linter CLI
src/agent_workflow/runtime/*.clj   reference runner primitives
src/agent_workflow/executors/*     executor implementations, including Pi CLI
src/agent_workflow/adapters/*      deterministic handler adapters
```

## Current status

Implemented:

- Normative `SPEC.md`
- JSON schemas for workflow, lint result, status, issues, run state, node attempt, process protocol
- Standalone linter CLI with human/JSON/EDN output
- Graph/mermaid emit from the linter
- Static checks for graph shape, node contracts, artifacts, prompt files, template variables, handlers, executors, and policies
- Lightweight reference runner skeleton that refuses to run invalid workflows
- Example Jira-to-PR workflow using agent-browser-only manual testing

Not yet implemented:

- Full Pi SDK executor
- HTTP control-plane server (the first read-only library/CLI skeleton is available via `tesseraft control-plane`)
- UI Workflow Studio / Run Console (see `docs/WEB_UI.md`)
- Approval node UX
- Durable DB-backed runner
