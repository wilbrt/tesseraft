# Tesseraft

Tesseraft is a package-split prototype for a workflow-as-code platform for deterministic and agentic state machines.

The name comes from tesserae: small pieces composed into intricate patterns. Tesseraft workflows use simple state nodes to build durable, inspectable agentic runs.

The important boundary is the workflow IaC file, not the implementation language. The current implementation is Babashka/Clojure because it is convenient for local CLI tooling, but the standalone contracts are JSON-compatible:

- `SPEC.md` defines the normative platform contract.
- `schemas/*.schema.json` define portable runtime/linter artifact formats.
- `bin/tesseraft lint` is a standalone linter CLI.
- `bin/tesseraft run` is a lightweight reference runner CLI.
- `bin/agent-workflow-lint` and `bin/agent-workflow-run` remain compatibility entry points.
- `examples/jira-to-pr/workflow.edn` is a real workflow declaration.

## Quick start

```bash
./scripts/check_deps.sh
./bin/tesseraft lint examples/jira-to-pr/workflow.edn
./bin/tesseraft lint examples/jira-to-pr/workflow.edn --format json
./bin/tesseraft lint examples/jira-to-pr/workflow.edn --emit mermaid
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

This lints the smoke, prompt-to-pr, and jira-to-pr example workflows, runs only the local smoke workflow, and verifies an invalid fixture fails lint. It does not run Pi, Jira, GitHub, or browser-dependent workflows.

## Example workflows

- `examples/smoke/workflow.edn` — local-only runner smoke test.
- `examples/prompt-to-pr/workflow.edn` — prompt collection, design, execution, review, and PR creation. Lint-only by default; running it invokes Pi and GitHub side effects.
- `examples/jira-to-pr/workflow.edn` — Jira-to-PR workflow with manual browser testing.

```bash
./bin/tesseraft lint examples/prompt-to-pr/workflow.edn
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
- HTTP control-plane API
- UI Workflow Studio / Run Console
- Approval node UX
- Durable DB-backed runner
