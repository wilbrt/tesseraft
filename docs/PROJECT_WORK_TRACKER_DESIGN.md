# Project identity, credentials, and work-tracker design

Status: Planned

Delivery workflow for all phases:

- [`playwright-code-review-loop`](../examples/playwright-code-review-loop/workflow.edn)

Related current contracts:

- [`PROJECTS.md`](PROJECTS.md)
- [`CONTROL_PLANE_API.md`](CONTROL_PLANE_API.md)
- [`WORKFLOW_RUNS.md`](WORKFLOW_RUNS.md)
- [`schemas/project.schema.json`](../schemas/project.schema.json)

## Purpose

Tesseraft needs to know which project a command or run belongs to, which external
system (if any) owns that project's planned work, and how to obtain the required
credential without making a repository own a secret value.

Plane is the first new provider motivating this design, but Plane must not become
a global Tesseraft assumption. One repository may use Plane, another Jira,
another GitHub Issues, a custom adapter, or no tracker. GitHub code hosting and
pull requests are also distinct from choosing GitHub Issues as the work tracker.

This document defines the target contract and decomposes it into focused,
dependency-ordered increments. Every phase uses `playwright-code-review-loop`
so implementation, deterministic browser regression testing, and independent
review follow one delivery path. It does not claim that any target behavior is
implemented.

## Goals

- Resolve the current repository as a Tesseraft project without special cases,
  including when Tesseraft is developing Tesseraft itself.
- Support explicit multi-project registration without recursively scanning the
  filesystem.
- Keep a portable, secret-safe project descriptor close to the repository while
  keeping machine paths and credential values user/machine-owned.
- Select zero or one primary work tracker per project independently of code
  hosting and other service connections.
- Validate common and provider-specific configuration for Plane, Jira, GitHub
  Issues, and package-provided adapters.
- Provide one provider-neutral read boundary before adding mutations.
- Make Plane bootstrap/synchronization explicit, dry-run-first, idempotent, and
  separately reviewable.
- Keep default lint and test commands local-only and credential-free.

## Non-goals

- No hosted Tesseraft registry or fleet-wide project discovery.
- No filesystem-wide repository scan.
- No raw credentials in project files, workflow files, browser state, HTTP
  payload responses, logs, prompts, run artifacts, screenshots, or events.
- No requirement that every project use a tracker.
- No automatic bidirectional synchronization.
- No replacement of repository technical contracts or `STATUS.edn` with Plane.
- No removal of existing Jira/GitHub configuration before a compatible migration
  exists.
- No live Plane calls in schema, discovery, configuration, or default tests.

## Current state and gaps

Today:

- Project manifests are read from
  `<control-workspace>/.tesseraft/projects/<project-id>.json`.
- `default` prefers a persisted default manifest and otherwise synthesizes an
  implicit project from legacy settings. An explicit non-default id must name a
  manifest.
- `--project-id` is persisted into run state and scopes workflows, runs,
  settings, and Git identity.
- A manifest contains `workspace_root`, so a control workspace can point at
  child workspaces.
- Connection normalization and public configuration are fixed to `jira` and
  `github`.
- `github` primarily serves code-host and pull-request behavior; it does not
  mean that GitHub Issues is the planning authority.
- Credential references accept `env:` and shape-valid `github-actions:` values.
  Local credential handling is split across control-plane and doctor code.
- Documentation describes project manifests as safe to commit, while the root
  `.gitignore` currently ignores all `.tesseraft/` content. Machine-specific
  `workspace_root` values also make many current manifests non-portable.

The target contract must migrate these behaviors rather than silently changing
the meaning of `default`, `github`, or existing manifests.

## Terminology

- **Project descriptor**: portable, non-secret repository identity and project
  configuration stored at `.tesseraft/project.json` in a project root.
- **Project root**: canonical real path of the directory containing the project
  descriptor. It is implied and is not stored inside the descriptor.
- **Project registry**: user-local mapping from project id to project root. It
  enables explicit multi-project selection without copying project
  configuration into a control repository.
- **Legacy control manifest**: existing
  `.tesseraft/projects/<project-id>.json` aggregate, retained during migration.
- **Service connection**: configuration for an external capability such as a
  GitHub code host.
- **Primary work tracker**: optional project role that owns backlog state,
  priority, scheduling, and assignment.
- **Credential reference**: non-secret locator selecting exactly one credential
  store and key.
- **Credential value**: secret owned by a user, machine, CI environment, or
  secret manager, never by the repository.

## Architectural decisions

### 1. A repository describes itself

The canonical descriptor is `.tesseraft/project.json`. Its parent directory is
the project root. Therefore Tesseraft developing itself is ordinary:

```text
/home/user/Projects/tesseraft/.tesseraft/project.json
```

The Tesseraft executable reads that descriptor and manages its parent checkout.
There is no recursive relationship between the tool and the project.

Example target descriptor:

```json
{
  "version": 1,
  "project_id": "tesseraft",
  "name": "Tesseraft",
  "runs_root": ".agent-runs",
  "discovery": {
    "workflow_roots": ["examples", ".tesseraft/workflows"]
  },
  "connections": {
    "code-host": {
      "provider": "github",
      "credential-ref": "env:GITHUB_TOKEN"
    },
    "work-tracker": {
      "provider": "plane",
      "credential-ref": "env:PLANE_API_KEY",
      "config": {
        "api-base-url": "https://api.plane.so",
        "workspace-slug": "example-workspace",
        "project-id": "plane-project-uuid"
      }
    }
  }
}
```

The descriptor contains no `workspace_root`: location is derived from the
validated descriptor path. Relative roots resolve against that project root.

A repository may intentionally keep its descriptor local, but Tesseraft should
make the portable descriptor easy to version. The Tesseraft repository's ignore
rules and docs must stop claiming contradictory defaults. An init/migration
command should print exactly which files are safe to commit and which remain
local.

### 2. Project discovery is local and deterministic

Project resolution receives a starting directory (normally current working
directory or explicit `--workspace-root`) and optional explicit selectors.

Implicit resolution order:

1. Walk from the starting directory to its ancestors for the nearest
   `.tesseraft/project.json`.
2. During migration, use the current persisted legacy `default` manifest when
   no descriptor exists.
3. Preserve the current implicit default synthesis when neither exists.

Explicit resolution order for `--project-id <id>`:

1. A nearest descriptor with the requested id.
2. The user-local registry entry for that id.
3. A legacy control manifest with that id.
4. Return a structured not-found error.

An explicit `--project-root <path>` may select a descriptor directly for CLI
use. HTTP clients must select a registered project id; they must not submit an
arbitrary filesystem path.

If the same id resolves to different canonical roots, resolution fails with an
inspectable conflict rather than silently choosing one. Symlinks are resolved
before identity/conflict checks. Resolution returns `source`, canonical root,
and migration/duplicate diagnostics.

The resolver never scans sibling repositories or an entire home directory.

### 3. Multi-project registration is user-local

The target registry lives under `$TESSERAFT_HOME` and is not committed:

```json
{
  "version": 1,
  "projects": {
    "tesseraft": {"root": "/home/user/Projects/tesseraft"},
    "acme-api": {"root": "/home/user/Projects/acme-api"}
  }
}
```

Registration is explicit and idempotent:

```text
tesseraft control-plane project register <root>
tesseraft control-plane project unregister <project-id>
```

Registration reads and validates the descriptor; callers do not separately
supply an id that could disagree with it. Local CLI registration may point
outside the current workspace because it is an explicit local action. Browser
registration remains confined to server-configured roots.

### 4. Credentials have separate owners

| Concern | Owner | Durable location |
| --- | --- | --- |
| Required service and non-secret remote scope | Repository/project | Project descriptor |
| Credential reference | Repository/project | Project descriptor |
| Local credential value | User/machine | Environment, keychain, or `$TESSERAFT_HOME` credential store |
| CI credential value | CI administrator | CI secret store |
| Resolution and use | One runtime effect | Process memory only |

A reference selects one store; stores do not silently override one another.
Target stores are:

- `env:NAME` — local/CI process environment;
- `tesseraft:path` — user-local `$TESSERAFT_HOME/credentials.json` entry;
- `github-actions:NAME` — shape-valid and resolved only by a GitHub Actions
  integration;
- future stores such as an OS keychain can be additive.

The local credential file should have a versioned, explicit shape and restrictive
permissions. Legacy file entries remain readable during migration, with a
non-secret warning. Public APIs return the reference and a state such as
`present`, `absent`, `unresolved`, or `invalid`; they never return a token
preview. All raw-secret-key rejection and redaction must recurse through nested
maps and arrays.

### 5. Work tracking is an optional project role

`connections.work-tracker` is absent when a project uses no work tracker. A
configured tracker has a common envelope:

```json
{
  "provider": "plane",
  "credential-ref": "env:PLANE_API_KEY",
  "config": {}
}
```

The common schema validates provider id, credential reference, secret absence,
and JSON-compatible non-secret config. Provider adapters validate config:

| Provider | Required non-secret config |
| --- | --- |
| `plane` | `api-base-url`, `workspace-slug`, `project-id` |
| `jira` | `base-url`, `project-key` (plus adapter-specific account metadata if required) |
| `github-issues` | `repository` (`owner/name`) |
| package adapter | Adapter-declared schema |

Plane Cloud defaults may be offered by the UI, but the persisted effective URL
must remain explicit so self-hosted Plane is unambiguous.

`connections.code-host` is separate. Existing `connections.github` and
`connections.jira` remain accepted as legacy service connections until a later
migration. Selecting GitHub Issues must not implicitly change PR transport, and
selecting Plane must not affect GitHub PR creation.

### 6. Provider adapters share a normalized read boundary

The first runtime behavior is read-only. A provider-neutral handler resolves the
run's persisted `project_id`, then resolves that project's work tracker and
credential at effect time:

```text
:work-tracker/fetch-item
```

Normalized artifact shape:

```json
{
  "version": 1,
  "provider": "plane",
  "project_id": "tesseraft",
  "remote_id": "uuid",
  "identifier": "TES-123",
  "title": "...",
  "description": "...",
  "state": {"id": "...", "name": "In Progress", "group": "started"},
  "priority": "high",
  "assignees": [],
  "labels": [],
  "url": "https://...",
  "fetched_at": "..."
}
```

The default artifact excludes provider raw responses because they may contain
emails or provider-specific private data. Debug metadata must be allowlisted and
redacted.

The Plane adapter must follow the official API contract:

- Cloud base URL `https://api.plane.so`; self-hosted URL from config;
- `X-API-Key` for personal keys (OAuth can be added separately);
- bounded timeouts;
- cursor pagination with explicit `per_page` (never rely on conflicting
  documented defaults);
- 60 requests/minute awareness using `X-RateLimit-Remaining` and
  `X-RateLimit-Reset`;
- structured handling for 400, 401, 404, 429, and 5xx responses;
- no URL/header/body logging that can reveal credentials.

Default tests use fake HTTP adapters and require no Plane/Jira/GitHub service.

### 7. Planning authority remains explicit

Recommended authority:

- external tracker: backlog state, priority, assignment, and scheduling;
- repository docs: technical contracts, acceptance criteria, dependencies, and
  non-goals;
- `STATUS.edn`: implemented capability truth only;
- GitHub PRs: delivery and review evidence;
- run artifacts/events: execution evidence.

Work items should link to repository contracts rather than copy large design
sections. Synchronization defaults to one-way, repository-plan-to-tracker
bootstrap. Bidirectional sync requires a later conflict/authority design.

### 8. Mutations are a separate, dry-run-first capability

Plane mutation must not be hidden inside project discovery or normal reads. A
future sync command first emits a deterministic plan, then requires an explicit
apply action.

Idempotency uses Plane's documented `external_source` and `external_id`:

```text
external_source = tesseraft-repo
external_id     = fragment:FI1
```

Before create, query by both fields. Exactly one match is updated, no match is
created, and multiple matches fail safely. Observe rate-limit headers and
checkpoint cursor progress. Persist only non-secret mapping/evidence. Never
silently delete remote work items.

## Migration and compatibility

1. Existing workflows and unscoped control-plane routes continue to resolve
   `default` as today until a descriptor is present.
2. Existing `.tesseraft/projects/*.json` manifests remain readable and listed as
   `legacy-manifest` sources.
3. Migration validates the destination root and descriptor before writing,
   refuses overwrite/conflicts, registers only after a successful write, and
   leaves the legacy source unchanged until explicit cleanup.
4. Existing Jira-to-PR and GitHub PR behavior remains unchanged while generic
   work-item intake is introduced separately.
5. Run state continues to persist `project_id`; recovery resolves the same
   project root from durable registration and fails clearly if it moved.
6. A moved registered project requires explicit re-registration; no scan guesses
   its new location.
7. Descriptor and registry schemas are versioned. Unknown major versions fail
   with focused diagnostics.
8. Capability status changes only when code and tests implement the corresponding
   behavior; this design document alone does not update `STATUS.edn`.

## Security invariants

- Project and registry ids are validated slugs.
- Descriptor and registry paths are canonicalized; path traversal and symlink
  escapes are tested.
- Browser APIs accept project ids, not arbitrary roots.
- A credential reference is non-secret, but public output still avoids token
  previews and command environments.
- Raw secret keys (`token`, `api_key`, `access_token`, `password`, and spelling
  variants) are rejected recursively.
- Adapter exceptions and HTTP reports are allowlisted/redacted before becoming
  durable events or artifacts.
- No credential value is passed to an agent prompt or agent tool environment
  unless a separately reviewed executor contract explicitly requires it.
- Mock mode performs no tracker network requests.
- Default tests use temporary roots, fake resolvers, and fake HTTP servers.

## Dependency graph

```text
WT1 Project identity, discovery, registry, and migration          [Playwright review]
 └── WT2 Credential stores + recursive secret safety             [Playwright review]
      └── WT3 Optional primary work-tracker contract             [Playwright review]
           └── WT4 Settings UI + Connections Doctor              [Playwright review]
                └── WT5 Normalized read boundary + Plane          [Playwright review]
                     ├── WT6 Jira + GitHub Issues read adapters    [Playwright review]
                     │    └── WT6I Generic intake integration      [Playwright review]
                     └── WT7 Plane bootstrap/sync                  [Playwright review]
```

Merge every accepted PR before starting a dependent increment. Re-read current
repository and open PR state before each run; these prompts describe target
behavior, not proof that dependencies have landed.

## Running an increment

Every increment uses `playwright-code-review-loop`. Start from a clean base
branch containing all dependencies.

```bash
./bin/tesseraft run start examples/playwright-code-review-loop/workflow.edn \
  --run-id <id> \
  --input repo-root=. \
  --input base-branch=main \
  --input prompt='<paste one Playwright code-review-loop prompt below>' \
  --format json
```

Prompts intentionally cover one bounded contract and require focused,
non-overlapping tests. Merge every accepted increment before a dependent run so
later design and validation work reflects actual behavior.
Use bounded `step`/`resume` and stop before `create-pr` when you do not want the
push/PR side effect. See [`WORKFLOW_RUNS.md`](WORKFLOW_RUNS.md).

---

## WT1 — Project identity, discovery, registry, and migration

**Delivery workflow:** `playwright-code-review-loop`

**Depends on:** Current project abstraction baseline

**Suggested branch:** `feature/project-identity-discovery`

### Outcome

A repository can describe itself with `.tesseraft/project.json`; commands
resolve the nearest project deterministically; and users can explicitly register
and migrate projects without scanning, identity ambiguity, or source deletion.
Tesseraft's own checkout follows exactly the same contract as any repository.

### Required scope

- Add versioned portable descriptor and user-local registry schemas.
- Derive canonical project root from the descriptor parent; do not persist
  `workspace_root` in the descriptor.
- Implement bounded nearest-ancestor discovery plus explicit registered
  selection, register/unregister/list/detail behavior, and source inspection.
- Canonicalize roots and fail when one id identifies different roots.
- Preserve implicit `default` and legacy `.tesseraft/projects/*.json` fallback.
- Add transactional non-destructive legacy migration: validate/write descriptor,
  then register; never overwrite or delete the source implicitly.
- Confine browser registration to configured roots while allowing explicit local
  CLI registration.
- Reconcile safe-to-commit descriptor guidance with local registry/credential
  ignore rules.

### Acceptance criteria

- This repository and an ordinary temporary repository resolve identically.
- Root, nested, nearest-project, explicit registered, and no-descriptor behavior
  follow the documented precedence without sibling/home scanning.
- Repeat registration is idempotent; moved roots require explicit re-register.
- Descriptor/registry/legacy duplicate ids at different roots fail visibly.
- Invalid versions/content, unknown ids, path/symlink escapes, and malformed
  roots produce focused structured diagnostics.
- Migration success and rollback preserve legacy bytes and avoid partial
  registry/descriptor state.
- Existing default, project isolation, and run identity behavior remain green.

### Non-goals

No credential-store redesign, tracker configuration, provider API calls,
Settings UI, or automatic deletion of legacy manifests.

### Playwright code-review-loop prompt

```text
Implement WT1 from docs/PROJECT_WORK_TRACKER_DESIGN.md with
playwright-code-review-loop.
Add the canonical versioned `.tesseraft/project.json` descriptor, bounded
nearest-project discovery, explicit user-local registration, conflict-safe
project selection, and transactional non-destructive legacy manifest migration.
Tesseraft's own checkout must behave like any repository. Add focused behavioral
tests covering documented precedence, root/nested/registered/default behavior,
idempotency, identity conflicts, moved roots, invalid versions/content,
path/symlink/browser confinement, and migration success/rollback. Preserve
legacy default/project/run isolation and never scan the filesystem or delete
legacy sources. Do not redesign credentials, add trackers/UI, or call external
services. Validate accumulated focused project/schema/control-plane tests and bb
test; update STATUS.edn/README only if capability truth changes.
```

---

## WT2 — Credential stores, ownership, and recursive secret safety

**Delivery workflow:** `playwright-code-review-loop`

**Depends on:** WT1

**Suggested branch:** `refactor/project-credential-resolution`

### Outcome

Every project credential reference selects one explicit store, credential
values remain user/machine/CI-owned, and no public or durable boundary can leak
a value.

### Required scope

- Introduce one credential resolver boundary shared by control plane, doctor,
  and runtime adapters.
- Define versioned `tesseraft:` local credential-store shape and permissions.
- Preserve `env:` and shape-valid `github-actions:` behavior with documented
  migration for legacy entries.
- Remove token previews from project/connection APIs.
- Reject raw secret keys recursively in project/connection payloads.
- Centralize allowlisted redaction for errors, events, logs, and doctor output.
- Add fake resolver injection for credential-free tests.

### Acceptance criteria

- Each reference reads only its selected store; no implicit cross-store
  override occurs.
- Project descriptors and registry never contain raw values.
- Nested maps/arrays containing token-like keys are rejected before write.
- Sentinel secrets never appear in JSON output, errors, events, logs, prompts,
  or artifacts in focused tests.
- Legacy env and GitHub/Jira behavior remains compatible.

### Non-goals

No work-tracker selection, provider HTTP calls, OS keychain implementation,
OAuth flow, hosted vault, or UI redesign beyond removing previews.

### Playwright code-review-loop prompt

```text
Implement WT2 from docs/PROJECT_WORK_TRACKER_DESIGN.md with playwright-code-review-loop
after WT1. Create one project-scoped credential resolver used by control plane,
doctor, and adapters; make env:, tesseraft:, and validated github-actions:
references select explicit stores; version the local credential file; and
provide non-destructive legacy migration. Build focused, non-overlapping
scenarios for store selection, missing/invalid refs, recursive raw-secret
rejection, preview removal, legacy migration, and sentinel redaction across
public/durable boundaries; implement one at a time with fake resolvers and no
real credentials. Do not add tracker providers, network probes, OAuth,
keychain/vault integrations, or unrelated settings work. Validate focused
security/migration/API tests and bb test; update capability status only when
warranted.
```

---

## WT3 — Optional primary work-tracker configuration contract

**Delivery workflow:** `playwright-code-review-loop`

**Depends on:** WT2

**Suggested branch:** `feature/project-work-tracker-contract`

### Outcome

Each project explicitly selects Plane, Jira, GitHub Issues, a package adapter,
or no primary tracker without changing code-host behavior.

### Required scope

- Add the optional `connections.work-tracker` common envelope.
- Add provider config schema registration and Plane/Jira/GitHub Issues schemas.
- Require a credential reference when a tracker is configured.
- Preserve legacy `connections.github` and `connections.jira` semantics.
- Add CLI/control-plane/HTTP create, update, inspect, and clear operations.
- Normalize kebab/snake JSON input at one boundary and emit one documented wire
  shape.
- Return masked state only, never values or previews.

### Acceptance criteria

- Omitted tracker is valid and means none.
- Valid Plane Cloud/self-hosted, Jira, and GitHub Issues configurations pass.
- Missing provider-specific scope, malformed URLs/repositories/refs, unknown
  schema versions, and nested secrets fail before persistence.
- Custom/package provider ids resolve an installed config schema or fail as
  unsupported; arbitrary unchecked maps do not pass as runnable.
- Selecting Plane does not alter GitHub PR transport or Jira legacy workflows.

### Non-goals

No Settings UI, network doctor probe, work-item fetch, mutations, sync, or
provider credentials in tests.

### Playwright code-review-loop prompt

```text
Implement WT3 from docs/PROJECT_WORK_TRACKER_DESIGN.md with playwright-code-review-loop
after WT2. Add an optional primary `connections.work-tracker` role with a common
provider/credential-ref/config envelope and registered schemas for Plane, Jira,
and GitHub Issues; omission means no tracker. Build focused, non-overlapping
scenarios for each valid provider/no-tracker contract, incomplete or malformed
scope, unsupported adapter schemas, normalized CLI/HTTP create-update-inspect-
clear behavior, recursive secret rejection, project isolation, and preservation
of GitHub code-host/PR plus legacy Jira semantics; implement one at a time. Do
not call external APIs or add UI/sync behavior. Validate focused schema/project
CRUD/security tests and bb test; update STATUS.edn/README truthfully if this
lands a new capability.
```

---

## WT4 — Work-tracker Settings UI and Connections Doctor

**Delivery workflow:** `playwright-code-review-loop`

**Depends on:** WT3

**Suggested branch:** `feature/work-tracker-settings-doctor`

### Outcome

A developer can select, configure, inspect, clear, and diagnose the current
project's tracker without exposing credentials or contacting the provider by
default.

### Required scope

- Add schema-driven tracker fields to project Settings.
- Explain current-project discovery, self-project behavior, and credential
  ownership in UI/docs.
- Add provider config and credential-reference doctor checks.
- Keep checks static by default; an optional future explicit probe is not part of
  readiness.
- Show no-tracker as an intentional valid project state, distinct from an
  incomplete configured tracker.
- Add local UI/API/manual tests with fake project data.

### Acceptance criteria

- Plane fields cover API base URL, workspace slug, remote project id, and
  credential reference.
- Jira/GitHub Issues forms are driven by their schemas rather than hard-coded
  Plane-only state.
- Clearing the tracker is explicit and idempotent.
- Browser payloads contain references/config only.
- Doctor distinguishes no tracker, incomplete config, unresolved credential,
  invalid config, and statically ready config.
- Default tests make no network requests.

### Non-goals

No real authentication probe, work-item list, Plane mutation, workflow handler,
or broad Settings redesign.

### Playwright code-review-loop prompt

```text
Implement WT4 from docs/PROJECT_WORK_TRACKER_DESIGN.md with
playwright-code-review-loop after WT3. Add a schema-driven primary work-tracker
editor and static Connections Doctor checks
for the selected Tesseraft project. Explain nearest-project/self-project
resolution and that projects own credential references while users/machines/CI
own values. Support explicit no-tracker and clear operations; distinguish absent,
incomplete, unresolved, invalid, and statically ready states. Use only
reference/non-secret config payloads and fake local fixtures. Do not contact
Plane/Jira/GitHub, fetch work items, add sync, or redesign unrelated Settings.
Validate focused web server/UI/doctor tests, build/type checks, manual spec, and
bb test; update status docs only for implemented truth.
```

---

## WT5 — Provider-neutral read boundary and Plane adapter

**Delivery workflow:** `playwright-code-review-loop`

**Depends on:** WT4

**Suggested branch:** `feature/plane-work-item-read-adapter`

### Outcome

A workflow can fetch one Plane work item through a provider-neutral handler and
receive a stable normalized artifact with durable, redacted failure evidence.

### Required scope

- Define/version normalized work-item schema.
- Add `:work-tracker/fetch-item` dispatch through the resolved project tracker.
- Implement Plane API-key read support with bounded HTTP behavior.
- Handle Plane Cloud/self-hosted base URLs, explicit pagination defaults, rate
  headers, and structured HTTP failures.
- Inject HTTP transport and credential resolver for tests.
- Add a small local fake-server workflow fixture and mock-mode behavior.
- Keep raw Plane responses out of default artifacts/logs.

### Acceptance criteria

- Fake Plane success normalizes identifier/title/description/state/priority/
  assignees/labels/url.
- 401, 404, 429, timeout, malformed JSON, and 5xx become inspectable failures
  without secrets.
- Project A cannot use project B's tracker or credential.
- Mock mode does not contact HTTP.
- Existing Jira-to-PR and GitHub flows are unchanged.
- Default tests need no Plane account or token.

### Non-goals

No create/update/sync, OAuth, Jira/GitHub Issues implementation, replacing the
Jira example, or UI backlog browser.

### Playwright code-review-loop prompt

```text
Implement WT5 from docs/PROJECT_WORK_TRACKER_DESIGN.md with playwright-code-review-loop
after WT4. Define a versioned normalized work-item artifact and provider-neutral
`:work-tracker/fetch-item` handler, then add the smallest read-only Plane API-key
adapter for cloud/self-hosted scope. Build focused, non-overlapping scenarios for
normalization, project/credential isolation, mock no-network behavior, bounded
timeout, malformed JSON, 401, 404, 429/reset metadata, and 5xx redacted durable
failures; implement one at a time with injectable fake HTTP and no real token.
Never persist raw Plane responses. Do not add mutations, OAuth, other tracker
adapters, or replace legacy Jira behavior. Validate focused runtime/adapter/
schema tests and bb test; update capability status if warranted.
```

---

## WT6 — Jira and GitHub Issues normalized read adapters

**Delivery workflow:** `playwright-code-review-loop`

**Depends on:** WT5

**Suggested branch:** `feature/work-tracker-read-adapters`

### Outcome

Jira- and GitHub-Issues-configured projects fetch through the WT5 boundary and
produce the same normalized work-item contract without regressing legacy Jira
or GitHub code-host/PR behavior.

### Required scope

- Implement Jira and GitHub Issues dispatch behind
  `:work-tracker/fetch-item`.
- Resolve only the selected project's tracker and explicit credential reference.
- Normalize provider fields into the WT5 schema and allowlist durable/prompt
  data.
- Define explicit GitHub issue-versus-pull-request behavior.
- Keep GitHub Issues tracker and GitHub code-host roles/tokens independent.
- Add injectable fake transports and mock no-network behavior.
- Preserve existing `jira-to-pr` and GitHub PR behavior unchanged.

### Acceptance criteria

- Representative Jira and GitHub Issues variants normalize deterministically to
  the same core contract.
- Missing/malformed config/ref, project isolation, not-found, auth, rate,
  timeout, malformed output, and provider failure are durable and redacted.
- Provider-only/private fields do not leak into normalized artifacts/prompts.
- Selecting GitHub Issues does not alter PR creation/fetch transport or token.
- Existing Jira/GitHub tests remain green and default tests need no service.

### Non-goals

No generic intake example, provider mutation, OAuth UI, webhooks, code-host
refactor, or legacy adapter removal.

### Playwright code-review-loop prompt

```text
Implement WT6 from docs/PROJECT_WORK_TRACKER_DESIGN.md with playwright-code-review-loop
after WT5. Add read-only Jira and GitHub Issues adapters behind the normalized
`:work-tracker/fetch-item` boundary while preserving legacy jira-to-pr and
GitHub code-host/PR behavior. Add focused behavioral tests covering equivalent
normalization, provider dispatch, explicit credential/project isolation,
GitHub issue-versus-PR and role/token independence, malformed config/ref,
not-found/auth/rate/timeout/malformed output, redaction/allowlisting, and mock
no-network behavior with fake transports. Do not add generic intake, mutation,
OAuth, webhooks, code-host refactors, or remove legacy behavior. Validate
accumulated focused adapter/runtime/compatibility tests and bb test; update
status only for implemented truth.
```

---

## WT6I — Generic work-item intake integration

**Delivery workflow:** `playwright-code-review-loop`

**Depends on:** WT6

**Suggested branch:** `feature/generic-work-item-intake`

### Outcome

Plane, Jira, and GitHub Issues projects can use one generic work-item-to-PR
example consuming only normalized artifacts, while legacy examples remain
runnable.

### Required scope

- Add a generic `work-item-to-pr` example over `:work-tracker/fetch-item`.
- Keep provider data out of prompts except normalized allowlisted fields.
- Add mock fixtures demonstrating all three providers through the same graph.
- Produce a clear pre-effect failure when the workflow requires a tracker and
  none is configured.
- Retain `jira-to-pr` compatibility and all existing examples.
- Document project/tracker setup and safe bounded runs.

### Acceptance criteria

- One workflow graph accepts equivalent Plane/Jira/GitHub Issues fixtures.
- Provider choice changes intake only, not GitHub PR transport.
- No-tracker failure occurs before an external effect and unrelated workflows
  remain unchanged.
- All examples lint and local mock/default suites require no credentials.

### Non-goals

No new provider behavior, mutation/synchronization, provider browser, webhooks,
OAuth, or legacy example deletion.

### Playwright code-review-loop prompt

```text
Implement WT6I from docs/PROJECT_WORK_TRACKER_DESIGN.md with playwright-code-review-loop
after WT6. Add a generic work-item-to-PR example that consumes only the
normalized WT5 artifact and works with local mock Plane, Jira, and GitHub Issues
fixtures through one graph. Keep provider-specific/private fields out of
prompts, tracker choice separate from GitHub PR transport, and legacy jira-to-pr
plus all examples runnable. Require a tracker before external effects and
document setup/safe bounded runs. Do not add provider behavior, mutations,
webhooks, OAuth, browser backlog UI, or delete legacy examples. Validate all
example lints, focused generic/mock integration tests, and bb test; update
STATUS.edn/README only for actual capability truth.
```

---

## WT7 — Plane bootstrap and idempotent one-way synchronization

**Delivery workflow:** `playwright-code-review-loop`

**Depends on:** WT5; WT6I optional

**Suggested branch:** `feature/plane-work-plan-sync`

### Outcome

A developer can preview and explicitly apply a one-way repository-plan-to-Plane
bootstrap without duplicate work items, hidden authority changes, or partial
unreported mutation.

### Required scope

- Define a versioned repository work-plan input with stable external ids.
- Implement read-only plan generation as the default command.
- Require an explicit `--apply` (or approval node) for mutations.
- Match Plane work items by both `external_source` and `external_id`.
- Create on zero matches, patch on one, and fail on duplicates.
- Respect cursor pagination, 60/minute limits, reset/retry bounds, and durable
  progress evidence.
- Never delete remote items automatically.
- Link work items to repository contracts and PRs without copying secrets.
- Add fake Plane transactional/idempotency/rate-limit/interruption tests.

### Acceptance criteria

- Repeating the same apply creates no duplicates.
- Dry-run performs no mutation and emits a deterministic diff/plan.
- Duplicate remote identities, malformed local plans, 401/429/5xx, interruption,
  and partial apply are durable and recoverable.
- Plane remains planning authority for mutable work state; repository plans own
  technical scope and stable identity.
- Default tests require no Plane service or token.

### Non-goals

No bidirectional sync, remote deletion, webhook daemon, automatic state changes
from every run event, Jira/GitHub mutation, or bulk import of stale roadmap docs.

### Playwright code-review-loop prompt

```text
Implement WT7 from docs/PROJECT_WORK_TRACKER_DESIGN.md with playwright-code-review-loop
after WT5. Add a versioned repository work-plan format and Plane bootstrap
command that is read-only/dry-run by default and mutates only with explicit
--apply. Build focused, non-overlapping scenarios for deterministic dry-run,
external_source+external_id zero/one/multiple matching, repeat-apply
idempotency, no deletion, cursor/rate-limit bounds, 401/429/5xx, interruption,
partial progress, and recovery; implement one at a time with fake Plane and no
external credentials. Persist only non-secret evidence and link repository
contracts rather than duplicating specs. Do not add bidirectional sync,
webhooks, automatic run-state mutation, other-provider writes, or import
unreconciled roadmap items. Validate focused sync/CLI tests and bb test; update
STATUS.edn/README only for behavior actually implemented.
```

## Completion criteria

This initiative is complete when:

- repository-local and registered project discovery is deterministic and
  migration-safe;
- Tesseraft's own checkout resolves through the same contract as other repos;
- actual credentials remain outside projects while project-owned references are
  inspectable and safe;
- no tracker is a supported first-class state;
- Plane/Jira/GitHub Issues reads normalize through one tested boundary;
- code-host behavior remains independent;
- Plane writes, if enabled, are explicit, idempotent, rate-aware, recoverable,
  and dry-run-first;
- default tests remain local-only and credential-free; and
- `PROJECTS.md`, control-plane docs, schemas, UI, adapters, `STATUS.edn`, and
  README describe actual—not planned—capability truth.
