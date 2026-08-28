# Tesseraft capabilities

> Generated from `STATUS.edn` by `bb status`. Do not edit by hand.

## credentials-and-preferences

Status: **Implemented**

Versioned user stores separately own credentials, preferences, and Git identities; raw integration tokens are rejected.

Evidence:

- [`schemas/local-credential-store.schema.json`](../../schemas/local-credential-store.schema.json)
- [`schemas/user-preferences.schema.json`](../../schemas/user-preferences.schema.json)
- [`schemas/git-identities.schema.json`](../../schemas/git-identities.schema.json)
- [`src/tesseraft/security/redaction.clj`](../../src/tesseraft/security/redaction.clj)

## project-model

Status: **Implemented**

Portable descriptor v2 owns project identity and configuration; registry v2 owns machine-local locations.

Evidence:

- [`schemas/portable-project-descriptor.schema.json`](../../schemas/portable-project-descriptor.schema.json)
- [`schemas/user-project-registry.schema.json`](../../schemas/user-project-registry.schema.json)
- [`src/tesseraft/project/descriptor.clj`](../../src/tesseraft/project/descriptor.clj)
- [`src/tesseraft/project/registry.clj`](../../src/tesseraft/project/registry.clj)

## handler-catalog

Status: **Implemented**

One closed catalog owns built-in deterministic handler metadata and dispatch.

Evidence:

- [`src/tesseraft/capabilities/handlers.clj`](../../src/tesseraft/capabilities/handlers.clj)
- [`test/tesseraft/capabilities/catalog_test.clj`](../../test/tesseraft/capabilities/catalog_test.clj)

## fragment-runtime

Status: **Implemented**

Fragment execution and recovery reuse the runtime engine while retaining pinned, inspectable nested evidence.

Evidence:

- [`src/tesseraft/runtime/fragment.clj`](../../src/tesseraft/runtime/fragment.clj)
- [`test/fragment_runtime_execution.test.py`](../../test/fragment_runtime_execution.test.py)
- [`test/fragment_runtime_recovery.test.py`](../../test/fragment_runtime_recovery.test.py)

## durable-runtime

Status: **Implemented**

Versioned run directories own state, events, artifacts, approvals, retries, cancellation, and process ownership.

Evidence:

- [`src/tesseraft/runtime/core.clj`](../../src/tesseraft/runtime/core.clj)
- [`src/tesseraft/runtime/store.clj`](../../src/tesseraft/runtime/store.clj)
- [`schemas/run-state.schema.json`](../../schemas/run-state.schema.json)
- [`test/tesseraft/runtime/core_test.clj`](../../test/tesseraft/runtime/core_test.clj)

## workflow-contracts

Status: **Implemented**

Versioned workflow, node, and fragment packages with schema and semantic lint boundaries.

Evidence:

- [`SPEC.md`](../../SPEC.md)
- [`schemas/workflow.schema.json`](../../schemas/workflow.schema.json)
- [`src/tesseraft/lint/pipeline.clj`](../../src/tesseraft/lint/pipeline.clj)

## container

Status: **Implemented**

Pinned multi-stage image runs non-root with explicit writable roots, health checks, and remote-exposure acknowledgement.

Evidence:

- [`Dockerfile`](../../Dockerfile)
- [`test/container/test.sh`](../../test/container/test.sh)
- [`docs/operations/CONTAINER_INSTALL.md`](../../docs/operations/CONTAINER_INSTALL.md)

## web-console

Status: **Implemented**

Express domain routers expose project-scoped APIs; React features use semantic models and capability metadata.

Evidence:

- [`web/src-server/routes/api.ts`](../../web/src-server/routes/api.ts)
- [`web/src/features`](../../web/src/features)
- [`web/src/lib/api.ts`](../../web/src/lib/api.ts)
- [`test/web-server.test.js`](../../test/web-server.test.js)

## migrations

Status: **Implemented**

Explicit dry-run/apply migrations own legacy project, preference, credential, and workflow conversion.

Evidence:

- [`src/tesseraft/migration/cli.clj`](../../src/tesseraft/migration/cli.clj)
- [`src/tesseraft/migration/project.clj`](../../src/tesseraft/migration/project.clj)
- [`test/tesseraft/migration/project_test.clj`](../../test/tesseraft/migration/project_test.clj)

## executor-catalog

Status: **Implemented**

One catalog owns executor metadata, availability, and dispatchability.

Evidence:

- [`src/tesseraft/capabilities/executors.clj`](../../src/tesseraft/capabilities/executors.clj)
- [`src/tesseraft/executors/opencode_cli.clj`](../../src/tesseraft/executors/opencode_cli.clj)
- [`test/tesseraft/capabilities/catalog_test.clj`](../../test/tesseraft/capabilities/catalog_test.clj)

## local-control-plane

Status: **Implemented**

Structured application operations and focused services own project, workflow, run, approval, and settings mutations.

Evidence:

- [`src/tesseraft/control_plane/operations.clj`](../../src/tesseraft/control_plane/operations.clj)
- [`src/tesseraft/control_plane/core.clj`](../../src/tesseraft/control_plane/core.clj)
- [`docs/reference/CONTROL_PLANE_API.md`](../../docs/reference/CONTROL_PLANE_API.md)

## work-tracker-catalog

Status: **Implemented**

One provider catalog drives Plane, Jira, and GitHub Issues validation, metadata, mock, doctor, and live fetch behavior.

Evidence:

- [`src/tesseraft/work_tracker/catalog.clj`](../../src/tesseraft/work_tracker/catalog.clj)
- [`test/work-tracker-contract.test.js`](../../test/work-tracker-contract.test.js)

## resumable-agent-sessions

Status: **Implemented**

Explicit agent session policies preserve one exact run/state-owned trajectory across bounded activations, with durable prompts, recovery evidence, and fail-closed Pi, OpenCode, Claude Code, and mock resumption.

Evidence:

- [`docs/design/RESUMABLE_SESSIONS.md`](../../docs/design/RESUMABLE_SESSIONS.md)
- [`schemas/session-binding.schema.json`](../../schemas/session-binding.schema.json)
- [`src/tesseraft/runtime/sessions.clj`](../../src/tesseraft/runtime/sessions.clj)
- [`test/resumable_session_contract.test.py`](../../test/resumable_session_contract.test.py)
- [`examples/catalog/resumable-code-review-loop/workflow.edn`](../../examples/catalog/resumable-code-review-loop/workflow.edn)

## Not yet implemented

- Full Pi SDK executor
- Database-backed or hosted runner
