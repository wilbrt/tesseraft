# Tesseraft Projects

A **Project** is a first-class, named configuration aggregate. Repository-owned
identity lives in the portable descriptor `.tesseraft/project.json`; machine-local
registration lives in the user registry `$TESSERAFT_HOME/projects/registry.json`.
Together they identify a workspace root, run root, workflow discovery context,
non-secret settings, and project-specific Jira/GitHub connection configuration.

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
    "github": { "credential-ref": "env:GITHUB_TOKEN" }
  }
}
```

The portable descriptor must not contain `workspace_root`, raw credentials, runs,
or other machine-local state. Local registration maps that descriptor identity to
a canonical workspace root in `$TESSERAFT_HOME/projects/registry.json`.

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

## Control-plane commands

```
tesseraft control-plane projects
tesseraft control-plane project <project-id>
tesseraft control-plane project create <project-id> [--name <name>] [--workspace-root <dir>] [--runs-root <dir>]
tesseraft control-plane project update <project-id> [--name <name>] [--workspace-root <dir>] [--runs-root <dir>]
tesseraft control-plane project migrate [<project-id>]
tesseraft control-plane project connections <project-id>
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
executable configuration, workflow discovery, and runs-root accessibility. Checks
are static or read-only with bounded timeouts; Jira/Pinga are not contacted and
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
- `schemas/run-state.schema.json` — optional `project_id`.