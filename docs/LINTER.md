# Tesseraft Standalone Linter

The linter is a standalone product surface.

It must not depend on:

- Pi
- Jira
- GitHub
- agent-browser
- runner state
- UI state

It may be used in:

- CI
- pre-commit hooks
- Workflow Studio validation
- Pi authoring helper patch validation
- runner startup validation

## Commands

```bash
tesseraft lint workflow.edn
tesseraft lint workflow.edn --format json
tesseraft lint workflow.edn --strict
tesseraft lint workflow.edn --emit graph
tesseraft lint workflow.edn --emit mermaid
```

## Resource declaration diagnostics

Optional `:resources` declarations are linted for conservative shape and consistency:

- `resources-not-map` — `:resources` exists but is not a map.
- `resource-group-not-vector` — `:requires`, `:consumes`, or `:produces` is not a vector.
- `resource-not-map` — a resource entry is not a map.
- `resource-missing-kind` / `resource-missing-name` — required resource keys are absent.
- `resource-unknown-field` — a resource map contains a field outside the documented vocabulary.
- `resource-unknown-group` — an unknown top-level resource group was declared.
- `resource-unknown-mode` — a keyword mode is outside the suggested modes.
- `duplicate-resource-declaration` — duplicate `[group kind name path]` entries appear in one declaration.
- `invalid-resource-path` — `:path` or produced-resource `:schema` is not a safe relative path.

Unknown groups, unknown modes, and duplicates are warnings; malformed declarations, unknown fields, and unsafe paths are errors. `--strict` treats warnings as failures.

Resource kinds are intentionally open-ended. Workflows may declare higher-level contracts such as `:manual-testing-spec`, `:web-service`, or `:test-server` without schema changes as long as the resource maps use the documented fields. The linter checks declaration shape and known handler names; it does not prove that every consumer reads the produced service URL.
