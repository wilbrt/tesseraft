# Tesseraft Control-plane API Contract

Status: Draft — current local API baseline plus next contract gaps

This document records the local HTTP control-plane API contract used by the Web
UI and CLI integrations. It began as a first-slice sketch; the repo now contains
an implemented local Express API over file-backed workflows and runs. This file
therefore distinguishes implemented baseline behavior from next/deferred
contract work.

## Scope

The current slice is a local, single-user HTTP API over existing Tesseraft
workflow packages and file-backed run records. It gives UI and CLI integrations
one boundary for inspecting workflows, linter output, graph data, run state,
event logs, node attempts, artifacts, settings, and supported runtime controls
without making browser state authoritative.

The API is an adapter over current contracts:

- workflow definition files and package assets described by [SPEC.md](../SPEC.md);
- normalized workflow and graph data produced by the spec/linter implementation;
- linter diagnostics compatible with `schemas/lint-result.schema.json`;
- `.agent-runs/<workflow>/<run-id>` run directories;
- run state, event logs, node attempts, logs, prompts, and declared artifacts
  described in [WORKFLOW_RUNS.md](WORKFLOW_RUNS.md);
- project/global configuration files such as `.tesseraft/git-user.json` and
  settings data.

## Current implementation baseline

The current Web UI server implements:

- `GET /api/workflows`, `GET /api/workflows/{name}`,
  `GET /api/workflows/{name}/graph` through `routeApi` → control-plane CLI.
- `GET /api/runs`, `GET /api/runs/{run-id}`,
  `GET /api/runs/{run-id}/events`, `GET /api/runs/{run-id}/artifacts`, and
  artifact content routes through `routeApi` → control-plane CLI.
- `GET /api/runs/{run-id}/stream` as a Server-Sent Events snapshot stream.
- `POST /api/runs` for run start plus background resume.
- `POST /api/runs/{run-id}/step` and `POST /api/runs/{run-id}/resume` for
  supported runtime controls.
- `DELETE /api/runs/{run-id}` for supported run deletion.
- `POST /api/studio/workflows`, `GET /api/studio/workflows/{name}`,
  `PUT /api/studio/workflows/{name}`, and
  `POST /api/studio/workflows/{name}/lint` for project-local Studio authoring.
- `GET`/`PUT /api/studio/workflows/{name}/assets/{path}` for path-confined
  prompt-like workflow package assets.
- `GET /api/git-user`, `PUT /api/git-user`, `GET /api/settings`,
  `PUT /api/settings`, and `GET /api/browse`.
- Pi-session routes: list/create/get/send prompt/events/SSE stream.

The implemented route set is covered by web-server and Studio tests in
`npm run web:test`.

## v3.2 contract implications

Phase 1 serves one developer automating their own work. The API should make
composition and safe rehearsal fast while preserving source-of-truth rules:

- expose package scope and shadowing metadata so the catalog can be a lens over
  existing discovery;
- carry executor/mock mode in run state and API responses (implemented in PR #8;
  executor-mode is persisted in run state and visible in API responses);
- record approval requests/decisions as durable runtime records once approval
  runtime support lands;
- keep settings/doctor checks local and avoid leaking secrets;
- require explicit auth/authz before any non-localhost exposure.

## Non-goals

- Replace workflow files, normalized workflow data, linter output, run state,
  event logs, artifacts, or node packages as durable contracts.
- Define a public hosted API, multi-user protocol, or public package registry.
- Define a database schema or require DB-backed persistence.
- Make browser/UI state authoritative for workflow behavior or runtime history.
- Treat currently implemented mutation routes as complete semantics for every
  future retry/cancel/approval/idempotency case.

## Source-of-truth rules

1. Workflow packages and [SPEC.md](../SPEC.md) define workflow behavior.
2. Normalized workflow data must remain JSON-compatible and portable.
3. Linter output is the validation authority for workflow/package diagnostics.
4. A run is pinned to an immutable workflow version at start time. Existing runs
   must not be silently repinned to different workflow content.
5. Runtime files describe runtime history and current status: run state, event
   logs, node attempts, approval records, and artifacts.
6. The API adapts existing spec, linter, and runtime data. It must not redefine
   workflow behavior or make browser/UI state authoritative.
7. UI filters, tabs, cached graph layout, local drafts, and recent-input history
   are presentation or convenience state only.
8. The current slice is local, single-user, and file-backed.

## Data sources

| Data | Source | Authority |
| --- | --- | --- |
| Workflow list and details | Known workflow package roots and `workflow.edn` files | Workflow package files and `SPEC.md` |
| Normalized workflow | Parser/normalizer output | `SPEC.md` and workflow package files |
| Linter result | Standalone linter output | Linter diagnostics and `schemas/lint-result.schema.json` |
| Graph data | Normalized states and transitions, or linter graph emit | Workflow package files and linter/spec code |
| Studio draft sidecar | `.tesseraft/workflows/<name>/studio-state.json` | UI draft/cache only; not workflow behavior |
| Workflow package assets | Files under `.tesseraft/workflows/<name>/` | Workflow package files, when referenced by workflow contracts |
| Run summary/detail | `.agent-runs/<workflow>/<run-id>/state.edn` and related runtime files | Runtime state files |
| Events | `.agent-runs/<workflow>/<run-id>/events.jsonl` | Append-only event log |
| Node attempts | Runtime attempt records when present, plus event/state-derived summaries | Runtime files |
| Artifacts | Declared outputs and files under the run directory | Runtime artifact files and workflow output contracts |
| Git user/settings | Project/global `.tesseraft` config files | Local configuration files |

## Common conventions

- Public HTTP routes are rooted at `/api`.
- Responses are JSON-compatible. Shapes below are sketches; the underlying spec,
  schemas, linter output, and runtime files remain authoritative.
- Object keys should use stable, portable JSON names such as `run_id`,
  `workflow_name`, `workflow_version`, and `diagnostics` when mirroring existing
  schemas.
- Collection endpoints may later add pagination, filtering, and sorting. The
  current contract requires deterministic, inspectable responses.
- Timestamps, when present, should be serialized as strings using the runtime's
  existing representation.
- Error responses should be JSON objects:

```json
{"error":{"code":"not_found","message":"Run not found","details":{}}}
```

Suggested statuses:

- `400 Bad Request` for malformed query parameters or invalid route values.
- `404 Not Found` for unknown workflows, runs, events, or artifact paths.
- `409 Conflict` when a requested mutation conflicts with pinned run metadata,
  duplicate run ids, replayed decisions, or file-backed state.
- `422 Unprocessable Entity` when a workflow or run file exists but cannot be
  parsed or validated.
- `500 Internal Server Error` for unexpected adapter failures.

## Workflow and graph endpoints

### `GET /api/workflows`

Purpose: list workflow packages available to the local control plane.

Source data: configured workflow roots, examples, project-local
`.tesseraft/workflows`, global `~/.tesseraft/workflows`, `workflow.edn` files,
parsed metadata, and optional linter summaries. `TESSERAFT_HOME` or equivalent
configuration may override the global directory.

Default discovery order is examples, global workflows, then project workflows.
Project-local names override matching global or example names. Equal-precedence
duplicates should be reported as conflicts when resolving a single workflow.

Response sketch:

```json
{
  "workflows": [
    {
      "name": "review-loop",
      "path": "examples/review-loop/workflow.edn",
      "source": "configured",
      "api_version": "tesseraft.workflow/v1",
      "lint": {"ok": true, "errors": 0, "warnings": 0}
    }
  ]
}
```

Next contract gap: expose explicit `scope` (`example`, `global`, `project`) and
shadowing metadata so the catalog can show overrides and diffs.

### `GET /api/workflows/{name}`

Purpose: inspect one workflow package, its normalized workflow shape, and
validation status.

Constraints:

- `normalized` is a projection of the workflow contract, not a separate editable
  copy.
- Linter diagnostics should preserve paths, codes, severities, messages, and
  hints from the linter result format.
- The API must not hide lint errors by inventing fallback behavior.

### `GET /api/workflows/{name}/graph`

Purpose: provide graph data for presentation of workflow states, transitions,
terminal outcomes, and declared contracts.

Constraints:

- Graph layout coordinates, collapsed groups, colors, and filters are UI state
  unless explicitly derived from workflow metadata.
- The graph must be reconstructable from workflow files and linter/spec output.
- Unknown or invalid transitions should surface diagnostics rather than being
  silently repaired.

## Studio authoring endpoints

These endpoints are implemented as local authoring helpers. They write explicit
project-local package files and must not mutate live run state.

### `POST /api/studio/workflows`

Purpose: create a new project-local workflow package under
`.tesseraft/workflows/<name>/workflow.edn`.

Constraints:

- Validate workflow names conservatively.
- Do not overwrite an existing project workflow.
- The created file is source of truth once written; sidecar state is draft/cache.

### `GET /api/studio/workflows/{name}`

Purpose: read a workflow for Studio editing. Project-local workflows are read
first; bundled examples may be read as templates.

Constraint: editing an example/global workflow should save a project-local copy
rather than mutating the source package.

### `PUT /api/studio/workflows/{name}`

Purpose: save a Studio workflow draft or completed workflow.

Constraints:

- Accept either server-serialized draft JSON or EDN text.
- Draft saves may persist draft state, but drafts are not accepted workflow
  behavior until lint/contract checks pass.
- Completed saves must lint a temp file first and reject invalid content without
  clobbering the existing workflow file.
- Writes must be path-confined to `.tesseraft/workflows/<name>/`.

### `POST /api/studio/workflows/{name}/lint`

Purpose: run the standalone linter for the selected workflow package.

Constraint: linter output remains authoritative; the API must not fork rules in
UI-only code.

### `GET` / `PUT /api/studio/workflows/{name}/assets/{path}`

Purpose: read/write prompt-like workflow package assets.

Constraints:

- Asset paths must be safe relative paths under the selected workflow package.
- Reject absolute paths, `..`, path separators outside the allowed form, and
  disallowed extensions.
- Asset writes do not by themselves make workflow references valid; the linter
  remains the validation boundary.

## Run read endpoints

### `GET /api/runs`

Purpose: list known file-backed runs for the local workspace.

Constraints:

- Summaries should mirror `schemas/run-state.schema.json` where fields are
  present.
- Missing or malformed run directories should be reported or omitted according
  to an explicit adapter policy; they must not be rewritten by a read endpoint.
- Existing runs must retain their recorded workflow version.

### `GET /api/runs/{run-id}`

Purpose: inspect one run's current status, pinned workflow version, attempts,
liveness, and artifact/event summary.

Constraints:

- Attempt objects should preserve fields from `schemas/node-attempt.schema.json`
  when available.
- The endpoint may derive summaries from events, including `node.failed`
  runtime failure evidence, but derived fields must not overwrite runtime
  records.
- Runtime controls are not performed through this read endpoint.

### `GET /api/runs/{run-id}/events`

Purpose: read the chronological runtime history for a run.

Constraints:

- Events should be returned in recorded order.
- Invalid JSONL entries should produce inspectable errors rather than silent
  truncation.
- Filtering/pagination may be added later without changing the event log as
  authority.

### `GET /api/runs/{run-id}/artifacts`

Purpose: list artifacts available for a run, including declared outputs and
other inspectable runtime files when policy allows.

Constraints:

- Artifact paths are run-relative paths.
- Declared artifact metadata comes from workflow output contracts and runtime
  records; file listing is not a new contract for workflow behavior.

### `GET /api/runs/{run-id}/artifact?path={path}`

Purpose: read or download one artifact file from a run. The current server also
supports an artifact path route form where safe.

Constraints:

- Normalize and validate `path` before file access.
- Reject absolute paths, `..` traversal, symlink escapes, and paths outside the
  selected run directory.
- Reading artifacts must not execute files or mutate run state.

### `GET /api/runs/{run-id}/stream`

Purpose: stream run snapshots with Server-Sent Events.

Constraints:

- The stream emits snapshot events derived from run detail, events, artifacts,
  and run list state.
- Heartbeats are transport liveness, not runtime truth.
- Terminal runs may close the stream after the terminal snapshot.
- Clients must tolerate disconnects and reconnect by reading durable run state.

## Run mutation endpoints

These endpoints are implemented for current runner-supported operations. Their
semantics should be tightened before adding broader retry/cancel/approval flows.

### `POST /api/runs`

Purpose: create a run from a selected workflow with explicit inputs, then start
background resume with a bounded `max_steps` value.

Constraints:

- Validate workflow name, run id, input shape, optional git-user identity, and
  max-steps range.
- Reject duplicate run ids with `409`.
- Resolve the workflow through the control plane; do not accept browser-supplied
  workflow content as runtime truth.
- Record runtime state through the runner, not browser state.
- Runner-level mock mode landed in PR #8: `--executor mock` is persisted in run
  state (`:executor-mode`) and visible in API responses. Remaining gap: richer
  mock-mode presentation/badges in the UI.

### `POST /api/runs/{run-id}/step`

Purpose: run one supported runtime step for an existing run.

Constraints:

- Resolve run directory through run detail/control-plane data.
- Return refreshed run detail/evidence after the mutation.
- Do not mutate workflow definitions.

### `POST /api/runs/{run-id}/resume`

Purpose: background-resume an existing run with bounded `max_steps`.

Constraints:

- Validate `max_steps`.
- Apply runtime controls to run state only.
- Avoid duplicate execution through runner-side liveness/idempotency rules.

### `DELETE /api/runs/{run-id}`

Purpose: delete a run when supported by the control-plane/runtime policy.

Constraints:

- Deletion policy must be explicit and path-confined to run storage.
- The API response should report deleted run id, liveness, and path when
  available.

### `POST /api/runs/{run-id}/approvals/{approval-id}`

Purpose: record a human approval decision for an approval gate. **Implemented**
in PR #44 (merged): the runtime writes approval request/decision records and
appends `approval.requested`/`approval.decided` events; the API shell outs to
`tesseraft runtime decide --run-dir <dir> --approval-id <id> --decision <d>`.

Constraints to preserve:

- approval requests and decisions are durable runtime records;
- append `approval.decided` with actor, decision, timestamp, and context
  supported by the auth model;
- reject decisions that do not match the active approval request;
- reject replayed decisions with conflict semantics;
- never store approval decisions only in browser state.

### `POST /api/runs/{run-id}/comments`

Purpose: annotate a run artifact with a durable comment (line-range anchor
optional). **Implemented** in PR #44 (merged): comments are appended to
run-relative `comments/<safe-path>/.json` via `tesseraft control-plane comment
add`.

Constraints to preserve:

- path-traversal-safe artifact/comment paths;
- comments are metadata reconstructed from files, not workflow behavior;
- never store comments only in browser state.

## Settings, browse, and Pi-session endpoints

### `GET /api/git-user` / `PUT /api/git-user`

The control plane exposes local git-user identity (name + email) that Tesseraft
workflow runs apply to git operations. It is local workspace runtime config, not
workflow behavior: the file is the source of truth and the browser only
round-trips it through the control plane.

Config file: `.tesseraft/git-user.json` (project-local) takes precedence over
`~/.tesseraft/git-user.json` (`TESSERAFT_HOME` overrides the global path). Shape:
`{"name": "...", "email": "..."}`. A missing file means no configured user;
handlers fall back to ambient git config, so the feature is additive and
non-breaking.

### `GET /api/settings` / `PUT /api/settings`

Purpose: round-trip local settings such as Pi defaults, tokens, and default repo
root through the control plane.

Constraints:

- Do not expose secret values unnecessarily.
- Token update semantics should preserve unchanged secrets without sending them
  back to the browser as plain text.
- Settings are local configuration, not workflow behavior.

### `GET /api/browse`

Purpose: browse paths under the allowed repository/workspace root for UI
selection helpers.

Constraints:

- Confine browsing to the allowed root.
- Reject traversal, symlink escapes, and hidden arbitrary filesystem access.

### Pi-session routes

Implemented route family:

- `GET /api/pi-sessions`
- `POST /api/pi-sessions`
- `GET /api/pi-sessions/{session-id}`
- `POST /api/pi-sessions/{session-id}/prompts`
- `GET /api/pi-sessions/{session-id}/events`
- `GET /api/pi-sessions/{session-id}/stream`

Constraints:

- Pi-session chat is a UI/tooling surface, not workflow behavior.
- Runtime Pi sessions must not mutate workflow source files.
- Fake/local adapters should keep default tests free of external services.

## Security and locality constraints

The current slice is local and single-user, but it still needs safe file
boundaries:

- bind only to a local interface unless a later authenticated server contract
  says otherwise;
- require explicit workspace/run roots rather than arbitrary filesystem
  browsing;
- confine run artifact reads to the selected run directory;
- confine Studio writes to project-local workflow package directories;
- reject traversal, absolute paths, and symlink escapes for artifact, asset, and
  browse routes;
- avoid exposing secrets from environment variables, credentials, `.git`, Pi
  session internals, or unrelated workspace files unless a later policy
  explicitly allows it;
- treat hosted, multi-user, and remote access as separate architecture work with
  authentication and authorization requirements.

## Open questions / next contract work

- What exact scope/shadowing fields should workflow/node/fragment discovery
  return for the catalog?
- What pagination and filtering parameters should be standardized for run and
  event lists?
- Should large artifacts be returned inline, as downloads, or through preflight
  metadata plus a content route?
- What local authentication, if any, should protect a browser-accessible server
  bound to localhost?
- What concurrency/idempotency model should retry, resume, cancel/abort, and
  approval decisions use?
- How will a later DB-backed control plane preserve this contract while
  replacing file-backed persistence?
- How should mock executor mode be represented in run state and API responses?
- Open: what richer approval presentation payload should be exposed beyond the
  initial question/artifacts/decision contract — render hints, per-option
  consequences text, and self-routing remain future work (P3.1)?
