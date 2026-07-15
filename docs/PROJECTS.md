# Tesseraft Projects

A **Project** is a first-class, named configuration aggregate that owns a
workspace root, a run root, a workflow discovery context, non-secret settings,
and project-specific Jira/GitHub connection configuration.

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

```clojure
{:project_id      "default"
 :name            "Default"
 :workspace_root  "."            ; abs-normalized at load; confined under the workspace
 :runs_root       ".agent-runs"
 :discovery       {:workflow-roots ["examples"]
                   :tesseraft-home nil}
 :settings        {:pi-default-provider ...
                   :pi-default-model ...
                   :default-repo-root ...}   ; NON-SECRET only
 :connections     {:jira   {:base-url "..."
                            :credential-ref "env:JIRA_TOKEN"}
                   :github {:credential-ref "env:GITHUB_TOKEN"}}}
```

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
is outside the repository and therefore never tracked. Project manifests under
`.tesseraft/projects/<slug>.json` store **only the reference**, never the token.

## Default project and migration

When no project manifests exist, a **default project** is synthesized from the
current defaults + legacy `.tesseraft/settings.json` / `.tesseraft/git-user.json`
(returned with `:source :implicit`). Legacy files remain a read fallback
(migration, not cutover).

A `migrate` command writes the synthesized default project to
`.tesseraft/projects/default.json`, stamped with `:migrated-from
:legacy-settings`. Legacy files are **not** deleted in this phase.

## Control-plane commands

```
tesseraft control-plane projects
tesseraft control-plane project <project-id>
tesseraft control-plane project create <project-id> [--name <name>] [--workspace-root <dir>] [--runs-root <dir>]
tesseraft control-plane project update <project-id> [--name <name>] [--workspace-root <dir>] [--runs-root <dir>]
tesseraft control-plane project migrate [<project-id>]
tesseraft control-plane project connections <project-id>
```

## HTTP API

See [CONTROL_PLANE_API.md](CONTROL_PLANE_API.md) for the project endpoint
contracts. Secrets never leave the process: project detail and connection
endpoints return masked/absent token state; raw token payloads are rejected on
write (only `credential_ref` is accepted).

## Run-state persistence

Runs persist `project_id` in `state.edn`. Absent means `"default"` (backward
compatibility for in-flight runs). A `project.resolved` event is emitted at run
start.

## Schemas

- `schemas/project.schema.json` — committed-safe project manifest shape.
- `schemas/credential-ref.schema.json` — credential reference shape.
- `schemas/run-state.schema.json` — optional `project_id`.