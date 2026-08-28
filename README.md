# Tesseraft

Tesseraft is a local-first workflow engine for durable, inspectable agent and deterministic automation. Workflows are versioned packages; every run keeps its state, events, artifacts, approvals, and recovery evidence on disk.

## Core architecture

- Workflow, node, and fragment packages are the behavior source of truth.
- JSON Schema defines structural contracts; the standalone linter owns semantic static checks.
- Clojure owns workflow serialization, project mutation, runtime decisions, and durable persistence.
- The local Express API delegates to the control plane and runtime; React holds semantic UI state only.
- Project descriptors are portable. Machine-local locations, preferences, identities, and credentials live in versioned user stores.

## Install

Reproducible test and container versions are pinned in [`.tool-versions`](.tool-versions).
The local `core` doctor also accepts a newer same-major Babashka release, so the
current Homebrew package can be used. For a local checkout:

```bash
npm ci
./bin/tesseraft doctor --profile core
```

See [the installation guide](docs/guides/GETTING_STARTED.md) and [container guide](docs/operations/CONTAINER_INSTALL.md) for supported setups.
On Windows, use the supported [WSL 2 quickstart](docs/guides/WINDOWS_QUICKSTART.md),
which installs Python in the default stack and verifies Git, GitHub CLI, and the
repository-pinned Pi and OpenCode executables.

## Five-minute smoke run

```bash
./bin/tesseraft lint examples/tutorials/smoke/workflow.edn
./bin/tesseraft run examples/tutorials/smoke/workflow.edn --run-id hello-tesseraft
./bin/tesseraft control-plane run hello-tesseraft
```

Start the local Web UI after building it:

```bash
npm run build:web
node web/server.js
```

The server binds to `127.0.0.1:7341` by default. Non-loopback binds require the explicit `--acknowledge-remote-exposure` flag because the local UI is not a remote authentication boundary.

## Minimal workflow

```clojure
{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "hello"}
 :initial :start
 :states
 {:start {:type :deterministic
          :handler :noop/succeed
          :next :done}
  :done {:type :terminal :status :success}}}
```

## Package layout

- `src/tesseraft/` — linter, control plane, runtime, catalogs, integrations, migrations, and persistence.
- `schemas/` — portable structural contracts.
- `web/` — local HTTP server and React console.
- `examples/` — maintained tutorials and catalog workflows.
- `test/fixtures/` — regression-only package and contract variants.
- `docs/` — guides, reference, architecture, operations, testing, generated evidence, and history.

## Current status

<!-- BEGIN STATUS — generated from STATUS.edn by `bb status`. Do not edit by hand. -->
| Capability | Status | Summary |
| --- | --- | --- |
| `credentials-and-preferences` | Implemented | Versioned user stores separately own credentials, preferences, and Git identities; raw integration tokens are rejected. |
| `project-model` | Implemented | Portable descriptor v2 owns project identity and configuration; registry v2 owns machine-local locations. |
| `handler-catalog` | Implemented | One closed catalog owns built-in deterministic handler metadata and dispatch. |
| `fragment-runtime` | Implemented | Fragment execution and recovery reuse the runtime engine while retaining pinned, inspectable nested evidence. |
| `durable-runtime` | Implemented | Versioned run directories own state, events, artifacts, approvals, retries, cancellation, and process ownership. |
| `workflow-contracts` | Implemented | Versioned workflow, node, and fragment packages with schema and semantic lint boundaries. |
| `container` | Implemented | Pinned multi-stage image runs non-root with explicit writable roots, health checks, and remote-exposure acknowledgement. |
| `web-console` | Implemented | Express domain routers expose project-scoped APIs; React features use semantic models and capability metadata. |
| `migrations` | Implemented | Explicit dry-run/apply migrations own legacy project, preference, credential, and workflow conversion. |
| `executor-catalog` | Implemented | One catalog owns executor metadata, availability, and dispatchability. |
| `local-control-plane` | Implemented | Structured application operations and focused services own project, workflow, run, approval, and settings mutations. |
| `work-tracker-catalog` | Implemented | One provider catalog drives Plane, Jira, and GitHub Issues validation, metadata, mock, doctor, and live fetch behavior. |
| `resumable-agent-sessions` | Implemented | Explicit agent session policies preserve one exact run/state-owned trajectory across bounded activations, with durable prompts, recovery evidence, and fail-closed Pi, OpenCode, Claude Code, and mock resumption. |

Detailed evidence: [docs/generated/CAPABILITIES.md](docs/generated/CAPABILITIES.md).
<!-- END STATUS -->

## Learn more

- [Documentation index](docs/README.md)
- [Authority map](docs/architecture/AUTHORITIES.md)
- [Project model](docs/reference/PROJECTS.md)
- [Control-plane API](docs/reference/CONTROL_PLANE_API.md)
- [Active roadmap](ROADMAP.md)
- [Contributing and test tasks](docs/testing/TESTING.md)

License: MIT.
