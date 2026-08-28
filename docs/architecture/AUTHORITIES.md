# Durable authority map

Status: Accepted
Decision date: 2026-08-10
Supersedes: Multiple implicit authority descriptions
Superseded by: —

This table is the ownership contract for durable Tesseraft data. Normal runtime,
control-plane, and Web services must read and write only the listed authority.
Legacy forms are migration inputs, never alternate normal authorities. A change
that moves ownership must update this map in the same change.

| Concept | Authoritative source | Readers | Writers | Schema/contract | Migration owner | Compatibility policy |
|---|---|---|---|---|---|---|
| Workflow packages | Repository/global `workflow.edn` package | spec, linter, runtime, control plane, Studio save service | humans and the control-plane workflow save operation | `schemas/workflow.schema.json` plus linter rules | `tesseraft.migration.workflows` | Version codecs only; deprecated behavior is warned before removal |
| Node packages | `node.edn` plus package-relative assets | node CLI, linter, Studio catalog | humans and node export | `schemas/node-package.schema.json` | `tesseraft.migration.workflows` | Command aliases may delegate; old persisted forms are migration-only |
| Fragment packages | `fragment.edn`/`fragment.json` plus package-relative assets | fragment CLI, linter, runtime | humans and fragment import/export | `schemas/fragment-package.schema.json` | `tesseraft.migration.workflows` | Version codecs only |
| Project descriptor | Repository-owned `.tesseraft/project.json` | project service, runtime context, control plane | project application service only | `schemas/portable-project-descriptor.schema.json` | `tesseraft.migration.project` | v1 is migration input; v2 is the normal form |
| Project registry | `$TESSERAFT_HOME/projects/registry.json`, mapping project ID to canonical local root only | project service | project application service only | `schemas/user-project-registry.schema.json` | `tesseraft.migration.project` | Repeated v1 project configuration is migration input only |
| User preferences | `$TESSERAFT_HOME/preferences.json` | Web UI and preference service | preference application service only | versioned preferences contract | `tesseraft.migration.preferences` | Legacy settings are migration input only |
| Git identity | user-local default with an optional project-local override | runtime execution context and Git handlers | git-identity application service only | versioned git-identity contract | `tesseraft.migration.preferences` | Ambient Git config is an explicit fallback, never persisted as project state |
| Credentials | environment references and `$TESSERAFT_HOME/credentials.json` | credential resolver at effect/doctor time | credential application service only | `schemas/credential-ref.schema.json`, `schemas/local-credential-store.schema.json` | `tesseraft.migration.credentials` | Raw tokens in settings are migration-only and cannot be newly written |
| Run state and execution ownership | `<runs-root>/<workflow>/<run>/state.edn`, including versioned execution intents and the exact active PID/start claim | runtime launcher/bootstrap/lifecycle and run-query service | runtime lifecycle service under the OS run lock only | `schemas/run-state.schema.json` and version codec | `tesseraft.migration.runs` | Older versions decode at the boundary; `runtime-process.json` is a derived compatibility mirror and never grants execution; browser/launcher process state is not authority |
| Resumable session bindings | `<run-dir>/sessions/<encoded-state-id>/binding.json` | runtime session lifecycle and run-query/artifact services | `tesseraft.runtime.sessions` only | `schemas/session-binding.schema.json` | `tesseraft.migration.runs` | Versioned run-local authority; missing, incompatible, or orphaned bindings fail closed and never select an ambient session |
| Events | Run-local append-only `events.jsonl` | runtime recovery, run-query service, Web stream | runtime event store only | versioned event envelope | `tesseraft.migration.runs` | Append-only; aliases confined to old-version codecs |
| Artifacts | Files below the owning run directory | runtime, control plane, Web artifact browser | runtime/handler safe-write service | node output contracts and artifact metadata | none | Paths must remain run-confined |
| Approvals | Run-local approval request, immutable evidence/decision, feedback, and comment records; adapter owner/capability records are transient lifecycle metadata only | runtime, approval service, Web UI, focused loopback adapter | approval application/evidence services only; adapter may write only its ownership lifecycle records | durable approval/event contracts; optional `:review-server {:kind :git-diff}` workflow contract | `tesseraft.migration.runs` | API aliases delegate to the canonical project-scoped operation; browser/listener state is never decision authority |
| Handler catalog | Clojure handler descriptors | runtime, mock mode, linter, doctor, capability API | built-in catalog composition | descriptor contract | none | Deprecated IDs are recorded in `deprecations.edn`; no second dispatch table |
| Executor catalog | Clojure executor descriptors | runtime, linter, doctor, capability API | built-in catalog composition | descriptor contract | none | Unavailable executors are explicit; no lint-only executor IDs |
| Provider catalog | Clojure work-tracker provider descriptors | project validation, runtime, mock, doctor, capability API | built-in catalog composition | descriptor and provider schemas | none | Closed built-in set until executable plugin loading exists |
| Studio draft sidecars | Project-local `.tesseraft/workflows/<name>/studio-state.json` semantic drafts | Studio and workflow save service | Studio draft service only | versioned semantic draft contract | `tesseraft.migration.workflows` | Browser drafts are not executable workflow authority |
| Status documentation | `STATUS.edn` | status generator and evidence audit | maintainers | generator contract | none | README is generated summary; detailed evidence stays in status documentation |

## Compatibility categories

Only these categories are permitted:

1. **Command alias** — may remain indefinitely when it delegates directly and
   adds no behavior (for example `tesseraft-lint`).
2. **Persisted legacy data** — read only inside `tesseraft.migration.*`; normal
   services return an actionable migration error.
3. **Deprecated API or workflow behavior** — a temporary delegating shim listed
   in `deprecations.edn` with a measurable removal condition.

Normal services must not probe several legacy/current sources, synthesize a
credential or integration, or silently select a fallback. Structural changes
must be a behavior-preserving relocation, a contract change with a migrator, a
documented deprecation removal, or a security correction with regression tests.
