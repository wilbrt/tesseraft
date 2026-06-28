# Tesseraft Web UI Architecture Decision Matrix

Status: Draft

This document is design documentation only. It compares serving and control-plane architectures for the future Tesseraft Web UI before implementing UI code, HTTP APIs, database schemas, hosting, or authentication.

It extends the product boundaries in [WEB_UI.md](WEB_UI.md) and the user objectives in [WEB_UI_USE_CASES.md](WEB_UI_USE_CASES.md). The normative platform constraints remain in [SPEC.md](../SPEC.md): workflow definition files are the source of truth, runs are pinned to immutable workflow versions, and UI, database, or runtime state must not silently redefine workflow behavior.

## Decision drivers

The architecture should preserve these constraints:

- **Workflow-as-code source of truth.** Workflow packages define behavior. UI state may cache, arrange, draft, or filter information, but saved behavior must be reconstructable from package files and normalized workflow data.
- **Linter-backed authoring.** Workflow Studio should use the standalone linter as its validation boundary instead of duplicating validation rules in UI-only code.
- **Pinned and inspectable runs.** Run Console must start and observe runs that record an immutable workflow version such as a content hash or Git commit.
- **Durable runtime records.** Run state, node attempts, event logs, artifacts, approval requests, and approval decisions are runtime records owned by the runner/control plane, not private browser state.
- **Incremental local delivery.** The first useful slice should fit the current Babashka prototype, package split, and file-backed runner without requiring a hosted service.
- **Simple package boundaries.** `tesseraft-ui` should consume spec, linter, and runner/control-plane contracts; it should not become a new runtime authority.
- **Default tests without external services.** The default validation path should remain local-only, avoiding Pi, Jira, GitHub, browser automation, hosted databases, and credentials.
- **Migration path.** Early choices should preserve a control-plane contract that can later swap file-backed persistence for durable DB-backed or hosted implementations.

## Options compared

| Approach | Preserves workflow file as source of truth | Supports Run Console needs | Supports Workflow Studio needs | Supports approval nodes | Supports durable runs | Complexity | Testability without external services | Fit with current Babashka prototype | Migration path |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Static file/workspace viewer over local files | Strong for read-only inspection because it renders workflow files, normalized data, lint results, and run files directly. Risk grows if browser drafts become implicit behavior. | Weak to moderate. It can inspect existing run directories, events, state, and artifacts, but cannot safely start, resume, cancel, retry, or approve runs without another control boundary. | Strong for inspection and validation previews; limited for saved edits unless paired with explicit file writes and linter checks. | Weak. Approval decisions must be durable runtime events, so a static viewer cannot own decisions by itself. | Moderate for viewing existing file-backed runs; weak for creating or controlling them. | Low. Mostly static rendering plus local file access or generated assets. | Strong if generated from local files and linter output. | Strong for inspection because current contracts are file-backed and CLI-friendly. | Useful first read-only surface, but runtime controls still need an API boundary later. |
| Local HTTP control-plane server over file-backed workflows/runs | Strong if the server treats workflow packages, normalized data, linter results, run state, events, and artifacts as durable contracts rather than UI state. | Strong for first Run Console slice: start, inspect, stream, step/resume, cancel/retry when supported, and expose artifacts/events through one boundary. | Moderate to strong. It can provide linter-backed package inspection and explicit file-diff authoring without merging authoring with runtime state. | Strong enough for first slice if approval requests and decisions are persisted as runtime records and appended to the event log. | Moderate to strong. It can expose existing file-backed run directories and preserve pinned workflow versions; durability is filesystem-bound. | Moderate. Adds a server/API contract but avoids database and hosted multi-user concerns. | Strong. Tests can use temp workflow packages and run directories with no external services. | Strong. Babashka can serve a small local API over existing linter/runner/file-store code. | Best incremental path: preserve the API contract while replacing persistence with a DB-backed control plane later. |
| Durable DB-backed control plane | Strong if workflow package content or immutable versions remain authoritative and DB rows never redefine workflow behavior. Risk exists if normalized workflow copies become editable runtime truth. | Strong. A DB can index runs, events, attempts, artifacts, approvals, leases, retries, and resumptions more robustly. | Moderate. It can support authoring metadata, but Workflow Studio must still save behavior to workflow files and validate through the linter. | Strong. Approval requests/decisions can be transactional and auditable. | Strong. Durable run records, concurrency controls, and queryable history are the main benefits. | High. Requires schema design, migrations, operational policy, backup/restore, and concurrency semantics. | Moderate. Local embedded DB tests are possible, but the default path becomes heavier than file-only tests. | Moderate to weak for now. It is a larger step than the current Babashka/file-backed prototype needs. | Good later target if introduced behind the same control-plane API created by the local file-backed server. |
| Hosted/multi-user server | Strong only with careful source-of-truth rules, immutable versioning, authorization, and repository integration. Highest risk of turning hosted state into hidden workflow behavior. | Strong eventual fit for shared operations, collaboration, notifications, and remote run control. | Strong eventual fit for collaborative authoring if changes still land as explicit workflow package diffs. | Strong eventual fit with authenticated, auditable human decisions. | Strong if backed by durable persistence and operational controls. | Very high. Adds authn/authz, tenancy, network security, deployment, secrets, repository access, and operational support. | Weak for default tests unless a local substitute is maintained. | Weak as a first slice. It outruns the prototype and current package boundaries. | Good long-term destination after local API and persistence contracts are stable. |

## Recommendation

The recommended first runtime slice is a **local HTTP control-plane API over existing file-backed workflows and runs**.

This option gives Run Console a real boundary for starting, observing, and controlling runs without making browser state authoritative. It can expose the current runner's run directories, state files, event logs, node attempts, artifacts, and future approval records while preserving pinned workflow versions. It also lets Workflow Studio reuse the same local service for package inspection, graph data, and linter-backed diagnostics without duplicating spec or lint logic in UI code.

This is not a final architecture commitment. It is an incremental slice that keeps the workflow file as the source of truth, fits the current Babashka prototype, and remains testable with local files and `bb test`. The important design commitment is the control-plane contract: if that contract is kept explicit, a later durable DB-backed control plane can replace file-backed persistence without forcing the UI to become the runtime owner. The initial read-first route shape is sketched in [CONTROL_PLANE_API.md](CONTROL_PLANE_API.md).

## Suggested first-slice boundaries

- Serve normalized workflow data, graph data, and linter results for selected workflow packages.
- Expose run creation only from a selected immutable workflow version.
- Expose run state, node attempts, event logs, artifacts, failures, and workflow version from file-backed run records.
- Record approvals through the control plane as durable runtime records, including `approval.requested` and `approval.decided` events.
- Keep authoring saves as explicit file changes plus linter validation; do not let runtime controls mutate workflow definitions.
- Keep the server local-first and dependency-light so default tests can run without external services.

## Deferred decisions

- Final mutation route semantics and streaming protocol beyond the initial read-first contract in [CONTROL_PLANE_API.md](CONTROL_PLANE_API.md).
- Frontend framework or component model.
- Authentication and authorization.
- Database schema, migrations, and hosted deployment.
- Multi-user collaboration and repository integration.
- Public node package repository protocol.
