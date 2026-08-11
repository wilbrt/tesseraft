# Projects, preferences, identities, and credentials

Tesseraft keeps portable repository configuration separate from machine-local user state. Each concern has one writer and one versioned format.

## Portable descriptor

`.tesseraft/project.json` is the sole normal project configuration:

```json
{
  "version": 2,
  "project_id": "example",
  "name": "Example",
  "runs_root": "runs",
  "discovery": { "workflow_roots": [".tesseraft/workflows", "workflows"] },
  "connections": {
    "code-host": { "provider": "github", "auth-mode": "ambient" },
    "work-tracker": {
      "provider": "plane",
      "credential-ref": "env:PLANE_TOKEN",
      "config": {
        "api-base-url": "https://api.plane.so",
        "workspace-slug": "example",
        "project-id": "project-uuid"
      }
    }
  },
  "runtime_defaults": { "default_executor": "pi-cli", "executor_mode": "live" }
}
```

The descriptor contains no absolute workspace path or secret value. Its schema is [`schemas/portable-project-descriptor.schema.json`](../../schemas/portable-project-descriptor.schema.json).

## User project registry

`$TESSERAFT_HOME/projects/registry.json` maps project IDs to absolute machine-local roots:

```json
{
  "version": 2,
  "projects": {
    "example": { "workspace_root": "/home/user/src/example" }
  }
}
```

Registration reads identity and configuration from the descriptor and writes only the registry. Unregistration removes only the registry entry; it never deletes repository files. Stale roots and descriptor/registry identity conflicts fail closed.

```bash
tesseraft control-plane project register /home/user/src/example
tesseraft control-plane project example
tesseraft control-plane project unregister example
```

When no explicit ID is supplied, Tesseraft selects the nearest descriptor. An unconfigured checkout may expose an ephemeral `default` view for command compatibility, but it has no persisted settings, credentials, or synthesized integrations.

## Connections

Connections are role-specific:

- `code-host` is GitHub repository and pull-request behavior. It uses ambient `gh` auth or a credential reference.
- `work-tracker` selects `plane`, `jira`, or `github-issues` from the provider catalog.

Provider config and credential references are portable. Secret values are not. Raw fields such as `token`, `access_token`, `password`, or `api_key` are rejected recursively before persistence.

## User-owned stores

All paths are beneath `$TESSERAFT_HOME` (default `~/.tesseraft`):

| Concern | File | Ownership |
| --- | --- | --- |
| Project locations | `projects/registry.json` | machine-local project roots |
| Preferences | `preferences.json` | color scheme, editor layout, default model/executor hints |
| Git identities | `git-identities.json` | one user default plus project overrides |
| Credentials | `credentials.json` | versioned local secret values |

Credential references use an explicit scheme, for example `env:PLANE_TOKEN`, `tesseraft:plane/main`, or `github-actions:secrets.PLANE_TOKEN`. Ambient CLI authentication is represented by the connection auth mode, not a fake secret reference.

## Migration

Legacy persisted forms are not normal resolution inputs. Inspect and apply explicit migrations:

```bash
tesseraft migrate project --project-root /path/to/project --dry-run
tesseraft migrate project --project-root /path/to/project --apply
tesseraft migrate credentials --legacy-file /path/to/credentials.json --dry-run
tesseraft migrate credentials --legacy-file /path/to/credentials.json --apply
```

Migrations are idempotent, back up source data where required, refuse conflicting destinations, and report source hashes. See the [authority map](../architecture/AUTHORITIES.md) for the complete ownership contract.
