# Local control-plane and HTTP API

The control plane is a local inspection and mutation boundary over project descriptors, workflow packages, and durable run directories. The Web server calls structured application operations; it does not reconstruct project writes or serialize workflow EDN.

## CLI

```bash
tesseraft control-plane projects
tesseraft control-plane --project-id example workflows
tesseraft control-plane --project-id example runs
tesseraft control-plane --project-id example run <run-id>
tesseraft control-plane --project-id example doctor
tesseraft approvals
tesseraft approvals list --format json
```

`tesseraft approvals` is an interactive inbox over every pending approval in
the current project. It shows the declared question, context artifacts, and
decision consequences one request at a time. A decision may include an overall
message and structured artifact annotations, and the reviewer chooses whether
to resume the run immediately. `tesseraft approvals decide` exposes the same
contract for scripts; run `tesseraft approvals --help` for its flags.

Mutations are also available through focused commands and the structured `control-plane apply --input -` boundary. Operations include:

- `project.register`, `project.update`, `project.delete`, and `project.connections.update`;
- `preferences.update`, `git-identity.update`, `credential.put`, and `credential.delete`;
- `workflow.save` and `workflow.validate`;
- `run.start`, `run.step`, `run.resume.prepare`, `run.cancel`, `run.decide`, `run.delete`, and `run.comment.add`.

Application-operation responses use one envelope:

```json
{ "ok": true, "operation": "project.update", "result": {} }
```

Errors use a stable public envelope and are redacted before output:

```json
{
  "status": 400,
  "error": { "code": "bad_request", "message": "...", "details": {} }
}
```

## HTTP server

The local API is composed from Express domain routers. Project-scoped routes are canonical.

### Project and settings routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects` | List registered and locally discovered projects |
| `POST` | `/api/projects` | Register an allowed descriptor root |
| `GET/PUT/DELETE` | `/api/projects/{id}` | Inspect, update, or unregister a project |
| `GET/PUT` | `/api/projects/{id}/connections` | Inspect or replace role-specific connections |
| `GET` | `/api/projects/{id}/doctor` | Static local readiness report |
| `GET/PUT` | `/api/projects/{id}/settings` | User preference view/update |
| `GET/PUT` | `/api/projects/{id}/git-user` | Resolved Git identity/project override |

Browser registration is confined to roots supplied by `browserAllowedProjectRoots`. Descriptor identity is always read from disk. HTTP clients cannot supply an alternate project ID, connection object, or machine-local workspace mapping during registration.

### Workflow and run routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects/{id}/workflows` | List workflows with scope and shadow metadata |
| `GET` | `/api/projects/{id}/workflows/{name}` | Read normalized workflow details |
| `GET` | `/api/projects/{id}/workflows/{name}/graph` | Read semantic graph data |
| `GET/POST` | `/api/projects/{id}/runs` | List or start runs |
| `GET/DELETE` | `/api/projects/{id}/runs/{run}` | Inspect or delete a terminal run |
| `POST` | `/api/projects/{id}/runs/{run}/step` | Execute one state transition |
| `POST` | `/api/projects/{id}/runs/{run}/resume` | Resume in a detached local process |
| `POST` | `/api/projects/{id}/runs/{run}/cancel` | Persist cancellation and reap owned processes |
| `GET` | `/api/projects/{id}/runs/{run}/events` | Read durable events |
| `GET` | `/api/projects/{id}/runs/{run}/stream` | Stream changing snapshots over SSE |
| `GET` | `/api/projects/{id}/runs/{run}/artifacts` | List durable artifacts |
| `GET` | `/api/projects/{id}/runs/{run}/artifact?path=...` | Read a confined previewable artifact |
| `GET/POST` | `/api/projects/{id}/runs/{run}/comments` | Read/add artifact comments |
| `GET` | `/api/projects/{id}/runs/{run}/approvals` | List approval requests and decisions |
| `POST` | `/api/projects/{id}/runs/{run}/approvals/{approval}` | Persist a decision |
| `GET` | `/api/projects/{id}/approvals` | List actionable approvals across project runs |
| `POST` | `/api/projects/{id}/approvals/{approval}/decisions` | Decide one approval and optionally resume its run |

The aggregate decision body requires `run_id` and `decision`. Optional fields
are `message`, `annotations`, `resume`, and `max_steps`. Each annotation has a
declared context `artifact_path`, a human `body`, and an `anchor` such as a diff
file, side, and line. The server validates the decision against the request's
declared options
before writing anything. `resume: true` launches a detached bounded resume only
after the decision advances the approval node successfully.

Deprecated unscoped workflow/run aliases delegate to the same default-project services and emit a `Deprecation` response header. Tesseraft’s own browser client always uses project-scoped routes.

### Catalog, Studio, and local utility routes

- `GET /api/capabilities` returns handler, executor, and work-tracker descriptors plus availability.
- `GET /api/work-tracker-providers` returns the provider-driven Settings form contract.
- `/api/studio/workflows/*` owns semantic drafts and delegates completed workflow save/validation to Clojure.
- `/api/pi-sessions/*` exposes local Pi chat sessions and SSE events.
- `GET /api/browse` lists paths confined to the configured workspace.
- `GET /api/health` reports static asset and local server readiness.

## Safety and concurrency

- Durable JSON/EDN writes use atomic sibling replacement and forced flushes; append-only logs use the runtime single-writer lock.
- Run mutation checks reject duplicate starts, live single-writer conflicts, unsafe artifact paths, invalid approval replays, stale approval requests, and deletion of executing runs.
- Secret-bearing request keys are rejected before child-process invocation. Public errors, events, and doctor reports pass through centralized redaction.
- The server binds to loopback by default. A non-loopback bind requires `--acknowledge-remote-exposure` because no remote authentication layer is provided.

The record-level details are defined by [`schemas/`](../../schemas/) and the [schema/linter responsibility map](CONTRACT_RESPONSIBILITIES.md).
