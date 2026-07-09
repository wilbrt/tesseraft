# Tesseraft Standalone Linter

## Quick start

```bash
tesseraft lint workflow.edn
tesseraft lint workflow.edn --format json
```

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

## Fragment package diagnostics

Fragment packages (`tesseraft.fragment/v1`) are validated by `lint-fragment-package`,
and inclusion in a workflow (`{:type :fragment}`) is validated by boundary checks in
`lint-workflow`. See [docs/FRAGMENTS.md](FRAGMENTS.md).

Fragment package lint:

- `fragment-missing-interface` — `:interface` is missing or not a map.
- `fragment-outcome-mismatch` — `:interface :outcomes` is not a non-empty keyword set, an `:exit` references an unknown outcome, or a declared outcome has no `:exit` entry.
- `fragment-exit-missing-output` — a required `:interface :outputs` entry is not produced on an `:exit` path.
- `fragment-asset-missing` — a declared asset does not exist.
- `fragment-internal-lint-failed` — (workflow-side) the fragment package itself failed lint when included.

Inclusion (workflow-side `{:type :fragment}` node) diagnostics:

- `fragment-unknown-package` — the referenced fragment package could not be discovered.
- `fragment-input-binding-missing` — a required `:interface :inputs` input is not bound at the import site.
- `fragment-unknown-outcome` — a transition references an outcome not declared in `:interface :outcomes`.
- `fragment-uncovered-outcome` — an `:interface :outcomes` member has no covering transition (warning).

Internal subgraph shape/transition/path/resource diagnostics within a fragment reuse the existing workflow diagnostic codes (`unknown-node-type`, `dead-end-non-terminal`, `unknown-next-state`, `invalid-artifact-path`, `output-missing-path`, `resource-*`, etc.).
