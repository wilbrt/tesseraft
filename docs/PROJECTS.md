# Tesseraft Projects

A **Project** is a first-class, named configuration aggregate. Repository-owned
identity lives in the portable descriptor `.tesseraft/project.json`; machine-local
registration lives in the user registry `$TESSERAFT_HOME/projects/registry.json`.
Together they identify a workspace root, run root, workflow discovery context,
non-secret settings, project-specific Jira/GitHub connection configuration, and
an optional primary work-tracker connection.

A project makes the previously-scattered project-scoped config into a single
addressable identity so that:

- runs are reproducible and traceable to a project (`project_id` persisted in
  run state);
- connections can be configured per-project; and
- the control-plane and HTTP API have an explicit project scope.

## Project identity

A project is addressed by a stable `project_id` slug: lowercase, matching
`^[a-z0-9][a-z0-9-]{0,62}$`. The slug is derived from the project name when
created via the API/CLI.

Portable repository descriptor (`.tesseraft/project.json`, versionable):

```json
{
  "version": 1,
  "project_id": "default",
  "name": "Default",
  "runs_root": "runs",
  "discovery": { "workflow-roots": ["examples"] },
  "connections": {
    "jira": { "base-url": "https://example.atlassian.net", "credential-ref": "env:JIRA_TOKEN" },
    "github": { "credential-ref": "env:GITHUB_TOKEN" },
    "work-tracker": {
      "provider": "plane",
      "credential-ref": "env:PLANE_TOKEN",
      "config": {
        "api-base-url": "https://api.plane.so",
        "workspace-slug": "acme",
        "project-id": "project-uuid"
      }
    }
  }
}
```

The portable descriptor must not contain `workspace_root`, raw credentials, runs,
or other machine-local state. Local registration maps that descriptor identity to
a canonical workspace root in `$TESSERAFT_HOME/projects/registry.json`.

## Project resolution: nearest ancestor and self-project

Command/HTTP resolution for a project id walks from the starting directory
(normally the current working directory, or an explicit `--workspace-root`)
upward through ancestor directories for the nearest `.tesseraft/project.json`.
It never scans sibling repositories or an entire home directory. A repository
describes itself: Tesseraft's own checkout resolves through exactly this same
contract — there is no special case for Tesseraft developing Tesseraft. When
no descriptor is found, resolution falls back to a persisted legacy manifest
and finally to the synthesized implicit `default` project (see "Default
project and migration" below).

## Credential ownership

| Concern | Owner | Durable location |
| --- | --- | --- |
| Provider/config and the credential *reference* | Project | `.tesseraft/project.json` (or the legacy manifest) |
| The credential *value* (local) | User/machine | `env:` process environment, or `$TESSERAFT_HOME/credentials.json` |
| The credential *value* (CI) | CI administrator | CI secret store (e.g. GitHub Actions secrets) |
| Resolution and use | One runtime effect | Process memory only; never persisted or echoed back |

In short: **the project owns the credential reference; the user, machine, or
CI owns the referenced value.** A `credential-ref` such as `env:PLANE_API_KEY`
is safe to commit — it names a store and key, not a secret. Public APIs return
only masked credential state (`present`/`absent`/`unresolved`/`invalid`), never
a value or a preview.

## Credential references (not raw tokens)

Raw credentials are kept **out of repositories** behind **credential
references**. A `credential-ref` is a string of the form `<store>:<path>`:

- `env:VARIABLE_NAME` — resolved from the process environment at effect time.
  This is the only store wired for local single-user resolution in the initial
  implementation.
- `github-actions:/secrets/NAME` — validated shape-wise, but resolved only in a
  GitHub Actions runner (not wired for local resolution). Locally it is reported
  as `:unresolved` with a clear error.

The adapter resolves the ref at effect time and **never** persists the resolved
secret to disk. Resolved secrets live in an out-of-repo store at
`~/.tesseraft/credentials.json` (or `$TESSERAFT_HOME/credentials.json`), which
is outside the repository and therefore never tracked. Portable descriptors and user-local registry entries store **only the reference**,
never the token.

## Default project and migration

When no portable descriptor or registration exists, a **default project** is
synthesized from the current defaults + legacy `.tesseraft/settings.json` /
`.tesseraft/git-user.json` (returned with `:source :implicit`). Legacy workspace
project manifests under `.tesseraft/projects/<slug>.json` remain read-only
fallback/migration sources.

A portable migration writes `.tesseraft/project.json` and matching user-local
registry state without deleting or rewriting the legacy source bytes.

## Work tracker connection

`connections.work-tracker` is optional. Omission means the project has no primary
tracker. The role is independent from legacy `connections.github` (code host/PR)
and legacy `connections.jira` semantics.

Canonical persisted/public shape uses kebab-case:

```json
{
  "provider": "jira",
  "credential-ref": "tesseraft:jira/tracker",
  "config": { "base-url": "https://example.atlassian.net", "project-key": "TES" }
}
```

Built-in providers are contract-only in WT3; Tesseraft validates and stores the
configuration but does not call provider APIs, fetch issues, sync state, or add
UI behavior.

- `plane`: `config.api-base-url` must be `http(s)`, plus `workspace-slug` and
  `project-id`.
- `jira`: `config.base-url` must be `http(s)`, plus `project-key`.
- `github-issues`: `config.repository` must be `owner/name`.

CLI/HTTP writes accept snake_case aliases at the boundary and return normalized
kebab-case. Raw secret-looking keys are rejected recursively; use
`credential-ref`. Clearing `work-tracker` is idempotent and leaves GitHub/Jira
connections unchanged.

### Settings editor and diagnosis (WT4)

The Settings UI's "Projects and connections" card includes a schema-driven
work-tracker editor (`WorkTrackerPanel`). The provider `<select>` includes an
explicit "No tracker" option; its fields are rendered from
`GET /api/work-tracker-providers` (Plane/Jira/GitHub Issues, plus any
package-registered provider) rather than a hard-coded Plane-only field set.
Saving posts `PUT /api/projects/{id}/connections` with
`{work_tracker: {provider, credential_ref, config}}`; clearing posts
`{clear_work_tracker: true}` and is idempotent when already absent. The editor
never renders a credential value or preview — only the masked
`credential-state` and, via the Connections Doctor below, the five-state
diagnosis.

The Connections Doctor (`GET /api/projects/{id}/doctor`,
[CONTROL_PLANE_API.md](CONTROL_PLANE_API.md#work-tracker-diagnosis-wt4))
distinguishes five states for the selected project's tracker: `absent`
(no tracker — a valid, intentional state), `incomplete` (missing
provider/credential-ref/required config), `invalid` (rejected config or
malformed reference), `unresolved` (statically valid, but the credential
value doesn't resolve locally — an expected state when a reference is owned
by CI), and `ready` (statically valid and the reference resolves). All tracker
checks are static: no Plane/Jira/GitHub API call is made.

## Control-plane commands

```
tesseraft control-plane projects
tesseraft control-plane project <project-id>
tesseraft control-plane project create <project-id> [--name <name>] [--workspace-root <dir>] [--runs-root <dir>]
tesseraft control-plane project update <project-id> [--name <name>] [--workspace-root <dir>] [--runs-root <dir>]
tesseraft control-plane project migrate [<project-id>]
tesseraft control-plane project connections <project-id> [--work-tracker-provider <plane|jira|github-issues> --work-tracker-credential-ref <ref> --work-tracker-config '<json>'] [--clear-work-tracker]
tesseraft control-plane project work-tracker-providers
tesseraft control-plane --project-id <project-id> doctor
```

## HTTP API

See [CONTROL_PLANE_API.md](CONTROL_PLANE_API.md) for the project endpoint
contracts. Secrets never leave the process: project detail, connection, and
Connections Doctor endpoints return only references/statuses/remediation, never
raw token values; raw token payloads are rejected on write (only
`credential_ref` is accepted).

`GET /api/projects/{id}/doctor` and `tesseraft control-plane --project-id <id>
doctor` run the local-first Connections Doctor for the selected project. The
report checks GitHub credential-ref resolution and `gh auth status`, Jira base
URL/credential-ref configuration, Pi provider/model local catalog availability,
effective Git author identity, repository-root Git/read/write readiness, Pinga
executable configuration, workflow discovery, runs-root accessibility, and
work-tracker provider/config and credential-reference classification (see
"Settings editor and diagnosis" above). Checks are static or read-only with
bounded timeouts; Jira/Pinga/work-tracker providers are not contacted and
Pinga is not executed.

## Run-state persistence

Runs persist `project_id` in `state.edn`. Absent means `"default"` (backward
compatibility for in-flight runs). A `project.resolved` event is emitted at run
start.

## Schemas

- `schemas/portable-project-descriptor.schema.json` — repository-owned `.tesseraft/project.json` descriptor shape.
- `schemas/user-project-registry.schema.json` — user-local `$TESSERAFT_HOME/projects/registry.json` registry shape.
- `schemas/project.schema.json` — legacy project manifest shape retained for compatibility.
- `schemas/credential-ref.schema.json` — credential reference shape.
- `schemas/work-tracker*.schema.json` — optional project work-tracker envelope and built-in provider config shapes.
- `schemas/run-state.schema.json` — optional `project_id`.