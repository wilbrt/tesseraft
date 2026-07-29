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
- `fragment-exit-invalid-produces-path` — an `:exit :produces` value is not a safe relative path.
- `fragment-asset-missing` — a declared asset does not exist.
- `fragment-internal-lint-failed` — (workflow-side) the fragment package itself failed lint when included. Within a single `lint-workflow` invocation this is de-duplicated per resolved file path: a fragment imported at N import sites surfaces the internal-proof failure at most once, so the importing workflow never re-proves the fragment's internal subgraph.

Inclusion (workflow-side `{:type :fragment}` node) diagnostics:

- `fragment-unknown-package` — the referenced fragment package could not be discovered in the allowed scope(s).
- `fragment-invalid-name` — `:fragment` is not a single safe package name.
- `fragment-name-mismatch` — the resolved package `:metadata :name` does not match the requested `:fragment` identity.
- `fragment-invalid-scope` — `:scope` is present but is not one of project/global/examples aliases.
- `fragment-invalid-version` / `fragment-version-mismatch` — `:version` is blank/non-string or does not exactly match resolved package metadata.
- `fragment-invalid-prefix` — `:prefix` is not a portable safe relative prefix.
- `fragment-interface-bindings-not-map` / `fragment-bindings-not-map` / `fragment-binding-contract-not-map` — interface declaration containers, authored binding containers, or declaration entries are malformed.
- `fragment-binding-name-collision` — declared or bound input/parameter names collide after keyword normalization.
- `fragment-input-binding-missing` / `fragment-parameter-binding-missing` — a required input or parameter has no non-`nil` effective value.
- `fragment-unknown-input` / `fragment-unknown-parameter` — the import site binds a name not declared by the interface.
- `fragment-missing-scalar-type` — an input/parameter declaration omits `:type` or sets it to `nil`.
- `fragment-unsupported-scalar-type` — an input/parameter declares a type outside `:string`, `:integer`, `:number`, or `:boolean`.
- `fragment-input-type-mismatch` / `fragment-parameter-type-mismatch` — a known literal/default value does not match its declared scalar type; lint does not coerce strings.
- `fragment-unknown-outcome` — a transition references an outcome not declared in `:interface :outcomes`.
- `fragment-uncovered-outcome` — an `:interface :outcomes` member has no covering transition (warning).

Successful workflow lint may include `:fragment-inclusions`, a derived map keyed by state id containing `:package-path`, canonical `:scope`, resolved `:version`, `:prefix`, effective `:inputs`, defaults-merged effective `:parameters`, and effective boundary `:resources`. Those resources are derived from package `:requirements :resources`: input/default aliases are applied for exact `{{inputs.x}}` / `{{defaults.x}}` bindings, safe prefixes are applied to boundary paths, and `:produces` includes only outputs present on every declared exit with the same resulting path. Lint analyzes these resources through a transient workflow view without mutating authored workflow data or exposing internal fragment-state resources.

Internal subgraph checks within a fragment run the **full** workflow primitive set on `:fragment :states` once in `lint-fragment-package`: top-level (`missing-initial-state`, `missing-terminal-state`), `node-type-checks`, `transition-checks`, `reachability-checks` (`unreachable-state`), `node-contract-checks` (`agent-missing-prompt-template`, `prompt-template-missing`, `deterministic-missing-handler`, `process-missing-command`, `timer-missing-duration`, `approval-missing-message`, `missing-runtime-timeout`), `duplicate-output-checks`, `workflow-resource-checks` (`resource-*`), `cycle-checks` (`cycle-without-explicit-limit`), `template-var-checks` (`unknown-template-root`, `unknown-*-template-var`), and `path-contract-checks` (`invalid-artifact-path`, `output-schema-missing`). Boundary inputs/parameters from `:interface` are synthesized as the internal `:inputs` so template-var checks for boundary bindings resolve. Inclusion sites (`{:type :fragment}`) lint **only** the boundary contract and never re-run these internal checks.
