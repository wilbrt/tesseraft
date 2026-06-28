# Tesseraft Control-plane API Contract

Status: Draft

This document is design documentation only. It sketches the first local HTTP control-plane API contract for future Run Console and Workflow Studio work before implementing server code, UI code, route handlers, authentication, database schemas, or hosted runtime behavior.

## Scope

The first slice is a local, single-user, read-first HTTP API over existing Tesseraft workflow packages and file-backed run records. It gives UI and CLI integrations one boundary for inspecting workflows, linter output, graph data, run state, event logs, node attempts, and artifacts without reading internal files directly.

The API is an adapter over current contracts:

- workflow definition files and package assets described by [SPEC.md](../SPEC.md);
- normalized workflow and graph data produced by the spec/linter implementation;
- linter diagnostics compatible with `schemas/lint-result.schema.json`;
- `.agent-runs/<workflow>/<run-id>` run directories;
- run state, event logs, node attempts, logs, prompts, and declared artifacts described in [WORKFLOW_RUNS.md](WORKFLOW_RUNS.md).

## Non-goals

- Implement an HTTP server, frontend, route handlers, or runtime behavior in this document.
- Define a public hosted API, multi-user protocol, or authentication model.
- Replace workflow files, normalized workflow data, linter output, run state, event logs, or artifacts as durable contracts.
- Define a database schema or require DB-backed persistence.
- Promise streaming, WebSocket, or Server-Sent Events behavior for the first slice.
- Define mutation semantics for starting, resuming, aborting, retrying, or approving runs as first-slice implementation commitments.

## Source-of-truth rules

1. Workflow packages and [SPEC.md](../SPEC.md) define workflow behavior.
2. Normalized workflow data must remain JSON-compatible and portable.
3. Linter output is the validation authority for workflow/package diagnostics.
4. A run is pinned to an immutable workflow version at start time. Existing runs must not be silently repinned to different workflow content.
5. Runtime files describe runtime history and current status: run state, event logs, node attempts, approval records, and artifacts.
6. The API adapts existing spec, linter, and runtime data. It must not redefine workflow behavior or make browser/UI state authoritative.
7. UI filters, tabs, cached graph layout, and local drafts are presentation state only.
8. The first slice is local, single-user, and file-backed.

## Data sources

| Data | Source | Authority |
| --- | --- | --- |
| Workflow list and details | Known workflow package roots and `workflow.edn` files | Workflow package files and `SPEC.md` |
| Normalized workflow | Parser/normalizer output | `SPEC.md` and workflow package files |
| Linter result | Standalone linter output | Linter diagnostics and `schemas/lint-result.schema.json` |
| Graph data | Normalized states and transitions, or linter graph emit | Workflow package files and linter/spec code |
| Run summary/detail | `.agent-runs/<workflow>/<run-id>/state.edn` and related runtime files | Runtime state files |
| Events | `.agent-runs/<workflow>/<run-id>/events.jsonl` | Append-only event log |
| Node attempts | Runtime attempt records when present, plus event/state-derived summaries | Runtime files |
| Artifacts | Declared outputs and files under the run directory | Runtime artifact files and workflow output contracts |

## Common conventions

- Paths in this document are route sketches, not implemented routes.
- Responses are JSON-compatible. Shapes below are non-normative sketches; the underlying spec, schemas, linter output, and runtime files remain authoritative.
- Object keys should use stable, portable JSON names such as `run_id`, `workflow_name`, `workflow_version`, and `diagnostics` when mirroring existing schemas.
- Collection endpoints may later add pagination, filtering, and sorting. The first contract only requires deterministic, inspectable responses.
- Timestamps, when present, should be serialized as strings using the runtime's existing representation.
- Error responses should be JSON objects:

```json
{"error":{"code":"not_found","message":"Run not found","details":{}}}
```

Suggested statuses:

- `400 Bad Request` for malformed query parameters or invalid route values.
- `404 Not Found` for unknown workflows, runs, events, or artifact paths.
- `409 Conflict` when a requested view conflicts with pinned run metadata or file-backed state.
- `422 Unprocessable Entity` when a workflow or run file exists but cannot be parsed or validated.
- `500 Internal Server Error` for unexpected adapter failures.

## First-slice read endpoints

### `GET /workflows`

Purpose: list workflow packages available to the local control plane.

Source data: configured workflow roots, `workflow.edn` files, parsed metadata, and optional linter summaries.

Response sketch:

```json
{
  "workflows": [
    {
      "name": "review-loop",
      "path": "examples/review-loop/workflow.edn",
      "api_version": "tesseraft.workflow/v1",
      "lint": {"ok": true, "errors": 0, "warnings": 0}
    }
  ]
}
```

Constraints:

- `name` is display/index data, not a new workflow identity authority.
- The endpoint must not treat cached UI labels as workflow behavior.
- Invalid workflows may be listed with lint errors so users can inspect diagnostics.

### `GET /workflows/{name}`

Purpose: inspect one workflow package, its normalized workflow shape, and validation status.

Source data: workflow package files, parser/normalizer output, and linter diagnostics.

Response sketch:

```json
{
  "workflow": {
    "name": "review-loop",
    "path": "examples/review-loop/workflow.edn",
    "api_version": "tesseraft.workflow/v1",
    "normalized": {},
    "lint": {"ok": true, "errors": [], "warnings": [], "diagnostics": []}
  }
}
```

Constraints:

- `normalized` is a projection of the workflow contract, not a separate editable copy.
- Linter diagnostics should preserve paths, codes, severities, messages, and hints from the linter result format.
- The API must not hide lint errors by inventing fallback behavior.

### `GET /workflows/{name}/graph`

Purpose: provide graph data for presentation of workflow states, transitions, terminal outcomes, and declared contracts.

Source data: normalized workflow states/transitions and linter graph emission when available.

Response sketch:

```json
{
  "workflow_name": "review-loop",
  "nodes": [
    {"id": "execute", "type": "agent", "title": "Execute"}
  ],
  "edges": [
    {"from": "execute", "to": "review", "condition": {"status": "pass"}}
  ],
  "diagnostics": []
}
```

Constraints:

- Graph layout coordinates, collapsed groups, colors, and filters are UI state unless explicitly derived from workflow metadata.
- The graph must be reconstructable from workflow files and linter/spec output.
- Unknown or invalid transitions should surface diagnostics rather than being silently repaired.

### `GET /runs`

Purpose: list known file-backed runs for the local workspace.

Source data: `.agent-runs` directories, run `state.edn` files, and available event metadata.

Response sketch:

```json
{
  "runs": [
    {
      "run_id": "smoke-demo",
      "workflow_name": "smoke",
      "workflow_version": "git:abc123",
      "state": "done",
      "status": "done",
      "round": 1,
      "created_at": "2026-06-28T00:00:00Z",
      "updated_at": "2026-06-28T00:01:00Z"
    }
  ]
}
```

Constraints:

- Summaries should mirror `schemas/run-state.schema.json` where fields are present.
- Missing or malformed run directories should be reported or omitted according to an explicit adapter policy; they must not be rewritten by a read endpoint.
- Existing runs must retain their recorded workflow version.

### `GET /runs/{run-id}`

Purpose: inspect one run's current status, pinned workflow version, attempts, and artifact/event summary.

Source data: run directory state, node attempt records when present, events, and artifact files.

Response sketch:

```json
{
  "run": {
    "run_id": "smoke-demo",
    "workflow_name": "smoke",
    "workflow_version": "git:abc123",
    "state": "done",
    "status": "done",
    "round": 1,
    "attempts": [
      {"node_id": "start", "attempt": 1, "status": "done", "artifacts": []}
    ],
    "links": {
      "events": "/runs/smoke-demo/events",
      "artifacts": "/runs/smoke-demo/artifacts"
    }
  }
}
```

Constraints:

- Attempt objects should preserve fields from `schemas/node-attempt.schema.json` when available.
- The endpoint may derive summaries from events, but derived fields must not overwrite runtime records.
- Runtime controls are not performed through this read endpoint.

### `GET /runs/{run-id}/events`

Purpose: read the chronological runtime history for a run.

Source data: append-only `events.jsonl` in the run directory.

Response sketch:

```json
{
  "run_id": "smoke-demo",
  "events": [
    {"type": "run.started", "run_id": "smoke-demo", "timestamp": "2026-06-28T00:00:00Z"}
  ],
  "continuation": null
}
```

Constraints:

- Events should be returned in recorded order.
- Basic pagination or filtering query parameters may be added later; they are not required for the first contract.
- Streaming, SSE, and WebSocket delivery are deferred unless specified by a later contract.
- Invalid JSONL entries should produce inspectable errors rather than silent truncation.

### `GET /runs/{run-id}/artifacts`

Purpose: list artifacts available for a run, including declared outputs and other inspectable runtime files when policy allows.

Source data: workflow output declarations, event records such as `artifact.written`, and files under the run directory.

Response sketch:

```json
{
  "run_id": "smoke-demo",
  "artifacts": [
    {
      "path": "execution/status-1.json",
      "name": "status",
      "node_id": "execute",
      "required": true,
      "content_type": "application/json",
      "size": 84
    }
  ]
}
```

Constraints:

- Artifact paths are run-relative paths.
- The API must not expose files outside the run directory.
- Declared artifact metadata comes from workflow output contracts and runtime records; file listing is not a new contract for workflow behavior.

### `GET /runs/{run-id}/artifacts/{path}`

Purpose: read or download one artifact file from a run.

Source data: the requested run-relative file under the run directory.

Response sketch:

```json
{
  "run_id": "smoke-demo",
  "path": "execution/status-1.json",
  "content_type": "application/json",
  "content": {"status": "pass", "summary": "implemented", "issues_file": null}
}
```

Binary or large artifacts may be returned as bytes or a local download response by a later server implementation; JSON wrapping is only a sketch for small structured artifacts.

Constraints:

- Normalize and validate `path` before file access.
- Reject absolute paths, `..` traversal, symlink escapes, and paths outside the selected run directory.
- Reading artifacts must not execute files or mutate run state.
- Missing files should return `404`; blocked paths should return `400` or `403` according to the eventual local server policy.

## Deferred mutation endpoints

These endpoints are likely needed for Run Console, but they are not first-slice implementation promises. A later contract must define request bodies, idempotency, concurrency, authorization, validation, and durable event semantics before implementation.

### `POST /runs`

Intended purpose: create a run from a selected workflow and immutable workflow version with explicit inputs.

Constraints to preserve later:

- validate the workflow through the linter before accepting runnable content;
- record the chosen workflow version in run state;
- write durable `run.started` or equivalent creation records;
- never silently repin an existing run.

### `POST /runs/{run-id}/resume`

Intended purpose: resume or advance a paused/blocked/runnable run when the runner contract supports it.

Constraints to preserve later:

- apply runtime controls to run state only;
- append durable events for resumed work;
- avoid duplicate execution through explicit idempotency/concurrency rules.

### `POST /runs/{run-id}/abort`

Intended purpose: request intentional termination of a run.

Constraints to preserve later:

- record an abort event and terminal status when accepted;
- define how in-flight executors are stopped or allowed to finish;
- do not mutate workflow definition files.

### `POST /runs/{run-id}/approvals/{approval-id}`

Intended purpose: record a human approval decision for an approval gate.

Constraints to preserve later:

- approval requests and decisions are durable runtime records;
- append `approval.decided` with actor, decision, timestamp, and context supported by the auth model;
- reject decisions that do not match the active approval request;
- never store approval decisions only in browser state.

## Security and locality constraints

The first slice is local and single-user, but it still needs safe file boundaries:

- bind only to a local interface unless a later authenticated server contract says otherwise;
- require explicit workspace/run roots rather than arbitrary filesystem browsing;
- confine run artifact reads to the selected run directory;
- reject traversal, absolute paths, and symlink escapes for artifact reads;
- avoid exposing secrets from environment variables, credentials, `.git`, Pi session internals, or unrelated workspace files unless a later policy explicitly allows it;
- treat hosted, multi-user, and remote access as separate architecture work with authentication and authorization requirements.

## Open questions

- What exact discovery mechanism selects workflow package roots for `GET /workflows`?
- What pagination and filtering parameters should be standardized for run and event lists?
- Should large artifacts be returned inline, as downloads, or through preflight metadata plus a content route?
- What local authentication, if any, should protect a browser-accessible server bound to localhost?
- What concurrency/idempotency model should deferred mutation endpoints use?
- How will a later DB-backed control plane preserve this contract while replacing file-backed persistence?
