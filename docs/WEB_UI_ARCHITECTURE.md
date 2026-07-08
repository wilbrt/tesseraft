# Tesseraft Web UI Architecture Decision Matrix

Status: Draft — current baseline plus v3.2 alignment

This document compares serving and control-plane architectures for the Tesseraft
Web UI. It also records the current implementation baseline so future work does
not treat already-shipped local surfaces as only hypothetical.

It extends the product boundaries in [WEB_UI.md](WEB_UI.md) and the user
objectives in [WEB_UI_USE_CASES.md](WEB_UI_USE_CASES.md). The normative platform
constraints remain in [SPEC.md](../SPEC.md): workflow definition files are the
source of truth, runs are pinned to immutable workflow versions, and UI,
database, or runtime state must not silently redefine workflow behavior.

## Current architecture baseline

The repo currently implements the recommended first slice: a **local HTTP API
over file-backed workflows and runs**, serving a React/Vite Web UI.

Implemented pieces include:

- Express API routes under `/api` backed by control-plane and runtime CLI
  commands.
- Workflow list/detail/graph endpoints using existing workflow discovery and
  linter/control-plane data.
- Run list/detail/events/artifacts endpoints using file-backed run records.
- Server-Sent Events snapshot streams for runs and Pi sessions.
- Mutating run controls for start, step, background resume, and delete where
  the runner supports them.
- Workflow Studio authoring routes that create/save project-local workflow
  package files under `.tesseraft/workflows/<name>/` and use lint as the
  completed-save gate.
- Workflow package asset read/write routes, path-confined to the package
  directory.
- Settings, git-user, browse, and Pi-session routes.
- Local web/server tests and Studio tests run by `npm run web:test`.

This baseline confirms the architecture recommendation. Remaining work should
extend the contract deliberately rather than replacing it with browser-owned
state, hosted state, or a DB as source of truth.

## v3.2 architecture implications

Phase 1 is for one technical developer automating their own work. Architecture
should therefore optimize for local iteration, composition, inspectability, and
safe rehearsal:

- **Catalog as lens:** render example/global/project discovery, scope,
  overrides, schemas, and import/export semantics; do not introduce a hosted
  registry as the first abstraction.
- **Mock mode as REPL:** once runner-level mock mode lands, the API and UI must
  persist and display executor mode so mock artifacts/events cannot be confused
  with real effects.
- **Self-checkpoint approvals:** once runtime approval support lands, approval
  requests/decisions must be durable runtime records through the control plane,
  not browser-only forms.
- **Local-first security:** localhost is the assumed first deployment; any
  non-localhost exposure requires explicit auth/authz work before use.

## Decision drivers

The architecture should preserve these constraints:

- **Workflow-as-code source of truth.** Workflow packages define behavior. UI
  state may cache, arrange, draft, or filter information, but saved behavior
  must be reconstructable from package files and normalized workflow data.
- **Linter-backed authoring.** Workflow Studio should use the standalone linter
  as its validation boundary instead of duplicating validation rules in UI-only
  code.
- **Pinned and inspectable runs.** Run Console must start and observe runs that
  record an immutable workflow version such as a content hash or Git commit.
- **Durable runtime records.** Run state, node attempts, event logs, artifacts,
  approval requests, and approval decisions are runtime records owned by the
  runner/control plane, not private browser state.
- **Incremental local delivery.** Useful slices should fit the current
  Babashka/file-backed runner without requiring a hosted service.
- **Simple package boundaries.** `tesseraft-ui` should consume spec, linter, and
  runner/control-plane contracts; it should not become a new runtime authority.
- **Default tests without external services.** The default validation path
  should remain local-only, avoiding Pi, Jira, GitHub, browser automation,
  hosted databases, and credentials where possible.
- **Migration path.** Early choices should preserve a control-plane contract
  that can later swap file-backed persistence for durable DB-backed or hosted
  implementations.

## Options compared

| Approach | Preserves workflow file as source of truth | Supports Run Console needs | Supports Workflow Studio needs | Supports approval nodes | Supports durable runs | Complexity | Testability without external services | Fit with current Babashka prototype | Migration path |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Static file/workspace viewer over local files | Strong for read-only inspection because it renders workflow files, normalized data, lint results, and run files directly. Risk grows if browser drafts become implicit behavior. | Weak to moderate. It can inspect existing run directories, events, state, and artifacts, but cannot safely start, resume, cancel, retry, or approve runs without another control boundary. | Strong for inspection and validation previews; limited for saved edits unless paired with explicit file writes and linter checks. | Weak. Approval decisions must be durable runtime events, so a static viewer cannot own decisions by itself. | Moderate for viewing existing file-backed runs; weak for creating or controlling them. | Low. Mostly static rendering plus local file access or generated assets. | Strong if generated from local files and linter output. | Strong for inspection because current contracts are file-backed and CLI-friendly. | Useful for read-only views, but runtime controls and saved authoring need an API boundary. |
| Local HTTP control-plane server over file-backed workflows/runs | Strong if the server treats workflow packages, normalized data, linter results, run state, events, and artifacts as durable contracts rather than UI state. | Strong for Run Console: start, inspect, stream, step/resume, delete/cancel when supported, and expose artifacts/events through one boundary. | Strong enough for current Studio: package inspection, graph data, linter-backed diagnostics, explicit project-local file writes, and package asset editing. | Strong enough once runtime approval support lands, if approval requests and decisions are persisted as runtime records and appended to the event log. | Moderate to strong. It exposes existing file-backed run directories and preserves pinned workflow versions; durability is filesystem-bound. | Moderate. Adds a server/API contract but avoids database and hosted multi-user concerns. | Strong. Tests can use temp workflow packages and run directories with no external services. | Strong and already implemented as the current baseline. | Best incremental path: preserve the API contract while replacing persistence with a DB-backed control plane later if evidence requires it. |
| Durable DB-backed control plane | Strong if workflow package content or immutable versions remain authoritative and DB rows never redefine workflow behavior. Risk exists if normalized workflow copies become editable runtime truth. | Strong. A DB can index runs, events, attempts, artifacts, approvals, leases, retries, and resumptions more robustly. | Moderate. It can support authoring metadata, but Workflow Studio must still save behavior to workflow files and validate through the linter. | Strong. Approval requests/decisions can be transactional and auditable. | Strong. Durable run records, concurrency controls, and queryable history are the main benefits. | High. Requires schema design, migrations, operational policy, backup/restore, and concurrency semantics. | Moderate. Local embedded DB tests are possible, but the default path becomes heavier than file-only tests. | Moderate to weak for now. It is a larger step than the current Babashka/file-backed prototype needs. | Good later target if introduced behind the same control-plane API created by the local file-backed server. |
| Hosted/multi-user server | Strong only with careful source-of-truth rules, immutable versioning, authorization, and repository integration. Highest risk of turning hosted state into hidden workflow behavior. | Strong eventual fit for shared operations, collaboration, notifications, and remote run control. | Strong eventual fit for collaborative authoring if changes still land as explicit workflow package diffs. | Strong eventual fit with authenticated, auditable human decisions. | Strong if backed by durable persistence and operational controls. | Very high. Adds authn/authz, tenancy, network security, deployment, secrets, repository access, and operational support. | Weak for default tests unless a local substitute is maintained. | Weak as a phase-1 focus. It outruns the prototype and current package boundaries. | Good long-term destination after local API and persistence contracts are stable. |

## Recommendation

Continue with the **local HTTP control-plane API over existing file-backed
workflows and runs**.

This option already gives Run Console a real boundary for starting, observing,
and controlling runs without making browser state authoritative. It exposes the
current runner's run directories, state files, event logs, node attempts,
artifacts, and future approval records while preserving pinned workflow
versions. It also lets Workflow Studio reuse the same local service for package
inspection, graph data, linter-backed diagnostics, and explicit file writes
without duplicating spec or lint logic in UI code.

This is not a final persistence or hosting commitment. The important design
commitment is the control-plane contract: if that contract stays explicit, a
later durable DB-backed control plane can replace file-backed persistence
without forcing the UI to become the runtime owner.

## Current and next-slice boundaries

Implemented / current:

- Serve workflow lists, details, graph data, and linter-derived diagnostics.
- Create project-local workflow packages and save workflow files through Studio
  routes.
- Read/write prompt-like package assets under path-confined package directories.
- Start runs from selected workflow content and inspect file-backed run records.
- Expose run state, node attempts, event logs, artifacts, liveness, failures,
  and workflow version from file-backed run records.
- Stream run and Pi-session snapshots with Server-Sent Events.
- Step, background-resume, and delete runs through runtime/control-plane
  commands where supported.
- Round-trip local settings and git-user configuration through the control
  plane.

Next:

- Expose scope and shadowing metadata for example/global/project packages.
- Add node/fragment catalog endpoints and schema-derived signatures.
- Add runner-level mock-mode start once the executor lands, including persisted
  mode and UI badges.
- Add approval decision endpoints once approval/manual-input runtime support
  lands.
- Standardize retry/cancel/abort/idempotency semantics before expanding those
  controls.
- Add auth/authz before any non-localhost bind or remote access story.

## Deferred decisions

- Frontend framework replacement or component-system commitment beyond the
  existing React/Vite implementation.
- Authentication and authorization for non-localhost or shared use.
- Database schema, migrations, and hosted deployment.
- Multi-user collaboration and repository integration.
- Public node/fragment package repository protocol.
- Fleet dashboards, compliance evidence, and org-level budget controls.
