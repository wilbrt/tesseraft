# Tesseraft

Tesseraft is a package-split prototype for a workflow-as-code platform for deterministic and agentic state machines.

The name comes from tesserae: small pieces composed into intricate patterns. Tesseraft workflows use simple state nodes to build durable, inspectable agentic runs.

The important boundary is the workflow IaC file, not the implementation language. The current implementation is Babashka/Clojure because it is convenient for local CLI tooling, but the standalone contracts are JSON-compatible:

- `SPEC.md` defines the normative platform contract.
- `schemas/*.schema.json` define portable runtime/linter artifact formats.
- `bin/tesseraft lint` is a standalone linter CLI.
- `bin/tesseraft run` is a lightweight reference runner CLI.
- `bin/tesseraft-lint` and `bin/tesseraft-run` remain compatibility entry points.
- `bin/tesseraft control-plane` exposes a local read-only JSON inspection surface for workflows and runs.
- `examples/jira-to-pr/workflow.edn` is a real workflow declaration.
- `docs/CODE_STYLE.md` defines project code style and design principles.
- `docs/WEB_UI.md` defines initial Workflow Studio and Run Console product boundaries.
- `docs/WEB_UI_USE_CASES.md` documents Web UI user objectives before implementation details.
- `docs/WEB_UI_ARCHITECTURE.md` compares Web UI serving and control-plane architecture options.
- `docs/CONTROL_PLANE_API.md` sketches the initial local read-first control-plane API contract.
- `docs/PR_HOUSEKEEPING.md` describes the safe PR housekeeping workflow.

## Quick start

```bash
./scripts/check_deps.sh
./bin/tesseraft --version
./bin/tesseraft lint examples/jira-to-pr/workflow.edn
./bin/tesseraft lint examples/jira-to-pr/workflow.edn --format json
./bin/tesseraft lint examples/jira-to-pr/workflow.edn --emit mermaid
./bin/tesseraft control-plane workflows
./bin/tesseraft control-plane graph smoke-demo
```

The linter has no Pi, Jira, GitHub, or browser dependency. It only needs Babashka and the files being linted.

## Local smoke demo

`examples/smoke/workflow.edn` is a local-only workflow for validating the reference runner without Pi, Jira, GitHub, or browser dependencies.

```bash
./bin/tesseraft lint examples/smoke/workflow.edn
./bin/tesseraft run examples/smoke/workflow.edn --run-id smoke-demo --format json
```

Run the safe smoke checks with:

```bash
bb test
```

This lints the smoke, prompt-to-pr, worktree-to-pr, code-review-loop, Playwright code-review-loop, deterministic code-review-loop, Canon TDD, focused TDD, and jira-to-pr example workflows, runs the local smoke workflow plus a mock executor dry run, verifies invalid fixtures fail lint, and runs the Web UI server/component suites. It does not run Pi, Playwright, Jira, GitHub, or hosted-service workflows.

The Playwright browser gate builds and serves the production Web UI on
localhost, then runs Chromium coverage for workflow inspection and isolated
mutable UI journeys. Mutable tests use temporary workspaces and do not alter
the developer repository. Install the pinned Chromium revision once with:

```bash
npx playwright install --with-deps chromium
```

Run it headlessly or in Playwright UI mode with:

```bash
npm run web:e2e
npm run web:e2e:ui
```

This gate is localhost-only, requires no external services, and removes its temporary workflows and runs after testing.

## Mock executor dry run

Use runner-level mock mode to validate workflow transitions without invoking Pi, GitHub, Jira, or notification services:

```bash
./bin/tesseraft run examples/mock-run-workflow/workflow.edn \
  --executor mock \
  --run-id dry-run-demo \
  --input prompt='Test dry run' \
  --input repo-root=. \
  --format json
```

Mock mode is opt-in; default execution still uses each workflow's real executor and deterministic handlers. In mock mode, agent nodes render their prompts and write required artifacts with passing placeholder content. Known side-effect handlers for Jira, Git, GitHub, and Pinga return deterministic mock results instead of calling external services.

## Example workflows

- `examples/smoke/workflow.edn` — local-only runner smoke test.
- `examples/prompt-to-pr/workflow.edn` — prompt collection, design, execution, review, and PR creation. Lint-only by default; running it invokes Pi and GitHub side effects.
- `examples/worktree-to-pr/workflow.edn` — prompt-to-PR variant that creates a deterministic Git worktree and runs execute/review/PR steps from that isolated checkout.
- `examples/code-review-loop/workflow.edn` — design, isolated implementation, regression testing, code-review retry loop, and PR creation.
- `examples/playwright-code-review-loop/workflow.edn` — code-review-loop variant that replaces agentic regression testing with a deterministic `npm run web:e2e` gate in the implementation worktree.
- `examples/deterministic-code-review-loop/workflow.edn` — strict deterministic-first variant: agents design/implement/review only and **run no tests**; two deterministic `:process` gates (`bb test`, then Playwright) enforce pass before code review, using the `pi-cli` executor with OpenAI Codex models (`gpt-5.6-sol` for design/review, `gpt-5.5` for implementation).
- `examples/supervised-deterministic-code-review-loop/workflow.edn` — deterministic-first variant with a COAX-style, source-read-only supervisor after every three failed correction cycles. The supervisor inspects recent reports/logs and writes a durable direction consumed by the next implementation attempt.
- `examples/canon-tdd-to-pr/workflow.edn` — agile use case, one-scenario-at-a-time Canon TDD in an isolated worktree, deterministic validation, regression/review repair, and PR creation. See [`docs/CANON_TDD_WORKFLOW.md`](docs/CANON_TDD_WORKFLOW.md).
- `examples/focused-tdd-to-pr/workflow.edn` — lightweight focused TDD inside one coherent implementation state, followed by deterministic repository validation, independent whole-diff review, direct current-only correction cycles, and PR creation. See [`docs/FOCUSED_TDD_WORKFLOW.md`](docs/FOCUSED_TDD_WORKFLOW.md).
- `examples/mock-run-workflow/workflow.edn` — side-effect-free implementation/review workflow for runner and UI testing.
- See `docs/WORKFLOW_RUNS.md` for safe side-effecting workflow run instructions.
- `examples/pr-housekeeping/workflow.edn` — safe PR housekeeping report that classifies open pull requests without mutating GitHub state.
- `examples/jira-to-pr/workflow.edn` — Jira-to-PR workflow with manual browser testing.

```bash
./bin/tesseraft lint examples/prompt-to-pr/workflow.edn
./bin/tesseraft lint examples/code-review-loop/workflow.edn
./bin/tesseraft lint examples/playwright-code-review-loop/workflow.edn
./bin/tesseraft lint examples/canon-tdd-to-pr/workflow.edn
./bin/tesseraft lint examples/focused-tdd-to-pr/workflow.edn
./bin/tesseraft lint examples/pr-housekeeping/workflow.edn
```

## Local package locations

Keep project-specific workflow packages under `.tesseraft/workflows/<name>/workflow.edn` in the repository root. Keep global workflow packages under `~/.tesseraft/workflows/<name>/workflow.edn`. The control-plane and Web UI discover examples first, then global workflows, then project workflows; project-local workflow names override matching global or example names.

Keep reusable node packages beside them using the same scope convention: `.tesseraft/nodes/<name>/node.edn` for project nodes and `~/.tesseraft/nodes/<name>/node.edn` for global nodes. Node import/export commands still take explicit `node.edn` paths.

Fragment packages (reusable multi-node subgraphs, `tesseraft.fragment/v1`) use the same scope: `.tesseraft/fragments/<name>/fragment.edn`, `~/.tesseraft/fragments/<name>/fragment.edn`, and `examples/fragments/<name>/fragment.edn`. A workflow includes a fragment via a `{:type :fragment}` boundary node; inclusion lints the boundary contract without re-running the internal subgraph proof. See [docs/FRAGMENTS.md](docs/FRAGMENTS.md).

## Git branch and worktree modes

Tesseraft keeps the existing branch mode via `:git/ensure-branch`, which checks out the selected branch in `{{inputs.repo-root}}`. For isolated agent edits, use `:git/ensure-worktree` instead. It creates or reuses a deterministic worktree under `.agent-worktrees/<workflow>-<run-id>-<branch>`, writes the path artifact (default `worktree/path.txt`), and stores the path in `{{run.worktree-dir}}` for later nodes.

Minimal workflow fragment:

```edn
:ensure-worktree
{:type :deterministic
 :handler :git/ensure-worktree
 :runtime {:timeout "5m"}
 :inputs {:branch-file "design/branch-name.txt"}
 :outputs {:worktree-path {:path "worktree/path.txt" :required true}}
 :next :execute}

:execute
{:type :agent
 :executor :pi-cli
 :runtime {:cwd "{{run.worktree-dir}}" :timeout "90m"}
 ;; ...
 }
```

`github/create-pr` and other git helpers default to `{{run.worktree-dir}}` when present. You can also set deterministic node `:runtime {:cwd "{{run.worktree-dir}}"}` or `:inputs {:repo-dir-file "worktree/path.txt"}` explicitly.

Worktrees are not removed automatically. Cleanup is manual:

```bash
git worktree list
git worktree remove .agent-worktrees/<name>
git branch -D <branch>   # optional, after the PR/branch is no longer needed
```

## Package split

```text
src/tesseraft/spec.clj        shared parser/normalizer/template helpers
src/tesseraft/lint/core.clj   pure static linter library
src/tesseraft/lint/cli.clj    standalone linter CLI
src/tesseraft/runtime/*.clj   reference runner primitives
src/tesseraft/executors/*     executor implementations, including Pi CLI
src/tesseraft/adapters/*      deterministic handler adapters
```

## Current status

<!-- BEGIN STATUS — generated from STATUS.edn by `bb status`. Do not edit by hand. -->
Implemented:

- **fragment-runtime-recovery** (implemented) — Durable resume, cancellation, and orphan recovery for a non-approval `{:type :fragment}` node across process interruption. Re-entering a `:fragment` node first checks whether `fragments/<state>/<attempt>/state.edn` already exists: if not, the original fresh path runs; if it exists, `verify-pin!` refuses to continue when the package's content hash has changed since the original pin (`fragment_pin_changed`) regardless of whether the nested run already reached its own terminal status — `finish!` reads the reached exit entry and required-output contract from the *current* package on disk, not a snapshot, so a package edited after the nested run finished but before the parent recorded it is refused the same way an in-flight resume is; otherwise, a durable nested run that already reached its own terminal status is skipped straight to `finish!`, and one still in flight gets a parent `fragment.resumed` event before `run-until-done!` continues the internal graph from its persisted `:run :state`/`:round`/`:attempt` through the exact same `step!` the top-level runtime reuses — so an internal `:agent` node interrupted after writing its status artifact is recovered rather than re-invoked (existing agent-artifact recovery), and an internal `:process`/`:timer`/`:deterministic` node interrupted mid-execution durably orphans the nested run (`node.orphaned`) rather than silently re-running (existing orphan fail-fast). The top-level `step!` stops treating a `:fragment` node's own un-terminated `node.started` as an orphan once a durable nested run exists for it (`resumable-fragment?`), so the parent step resumes instead of failing first. Every event the nested loop appends (`node.*`, `transition.selected`, `effect.applied`, `run.*`) is mirrored live into the parent's own `events.jsonl` as it happens, inside `tesseraft.runtime.store/event!` itself rather than copied only at `finish!`, so the parent log alone proves what happened inside the boundary even if the process dies mid-fragment: the mirrored `:event` is namespaced `fragment.<original>`, the parent's own `:state`/`:attempt` identify the inclusion attempt, and the nested event's own `:state`/`:attempt` (when present) are preserved under `:internal_state`/`:internal_attempt`; `fragment.started`/`fragment.finished`/`fragment.resumed` remain parent-native, not mirror copies. The control plane's `get-run` reverses this transform per parent attempt to derive `:internal_attempts`, reusing `derive-attempts-from-events` verbatim, and `scan-artifacts` includes `fragments` so nested run evidence reads as an artifact of the parent run; `failures-from-run` excludes any artifact path under `fragments/` from its issues-artifact heuristic, so a fragment's own resolved (non-empty) `issues.json` remains readable without being reinterpreted as a parent-run failure. `run cancel` durably saves the parent's own `"cancelled"` status first, then marks every non-terminal `fragments/*/*/state.edn` `"cancelled"`, mirroring a `run.cancelled` into the parent log through the nested ctx's own persisted `:event-mirror` descriptor, so a nested run a killed parent process left running does not stay silently `"running"` forever; cancelling nested runs is best-effort per attempt directory, so a throw on one (e.g. an unreadable `state.edn`) is caught and logged rather than ever leaving the parent's own already-persisted cancellation unrecorded or blocking the remaining nested runs from being cancelled. Approvals inside fragments, nested fragments, and a per-node timeout engine remain out of scope; internal nodes keep top-level cancellation as their only enforcement path.
  _Evidence:_ src/tesseraft/runtime/fragment.clj durable-internal-run?/resume-internal-context/verify-pin!/resumed!/cancel-internal-runs!, src/tesseraft/runtime/core.clj run-fragment-node!/resumable-fragment?/cancel!, src/tesseraft/runtime/store.clj event!/mirrored-event, src/tesseraft/control_plane/core.clj attach-internal-attempts/internal-attempts-for-parent-attempt/scan-artifacts, test/fixtures/valid/fragment-runtime/{runtime-resume,runtime-hang}/fragment.edn, test/fragment_runtime_recovery.test.py, docs/FRAGMENTS.md#runtime-behavior, scripts/test.sh FI8
- **work-tracker-plane-read** (implemented) — Read-only provider-neutral `:work-tracker/fetch-item` boundary for Plane, Jira, and GitHub Issues: resolves the selected run project's persisted `connections.work-tracker`, records that selected Tesseraft project separately from provider remote scope, uses only the project-scoped tracker credential ref, performs injectable bounded read requests, rejects malformed provider refs/config and GitHub PR payloads, and persists versioned normalized work-item artifacts without raw provider payloads or secrets. Mock mode remains offline. Legacy Jira ticket fetch and GitHub code-host/PR behavior remain independent.
  _Evidence:_ src/tesseraft/work_tracker/runtime.clj, src/tesseraft/work_tracker/plane.clj, src/tesseraft/work_tracker/jira.clj, src/tesseraft/work_tracker/github_issues.clj, src/tesseraft/adapters/builtin.clj :work-tracker/fetch-item, schemas/normalized-work-item.schema.json, test/work-tracker-read.test.js, test/work-tracker-read-adapters.test.js, test/fixtures/valid/work-tracker-fetch/workflow.edn, scripts/test.sh WT5/WT6 blocks
- **node-packaging-system** (implemented) — Self-contained node package import/export via `bb node`.
  _Evidence:_ src/tesseraft/node/cli.clj, docs/NODES.md, docs/PACKAGES.md, bb.edn :node
- **mock-executor** (implemented) — Runner-level mock/dry-run mode: opt-in `--executor mock` execution that renders prompts and writes passing placeholder artifacts, with deterministic mock results for Jira/Git/GitHub/Pinga side-effect handlers; executor-mode persisted in run state.
  _Evidence:_ src/tesseraft/runtime/core.clj mock-mode?/executor-mode, src/tesseraft/executors/mock.clj, examples/mock-run-workflow/workflow.edn, scripts/test.sh mock dry-run, README.md §Mock mode
- **connections-doctor** (implemented) — Project-scoped local-first Connections Doctor: `tesseraft control-plane --project-id <id> doctor`, `GET /api/projects/:projectId/doctor`, and a Settings panel report bounded static/read-only readiness for GitHub/Jira credential refs, gh auth, Pi provider/model local catalog, Git author identity, repo/runs roots, Pinga config, workflow discovery, and (WT4) work-tracker provider/config and credential-reference classification. `work-tracker-config` and `work-tracker-credential` classify distinct concerns (provider/config vs. the credential-ref) rather than cloning one shared verdict, each carrying one of five states (absent/incomplete/invalid/unresolved/ready); a report-level `work_tracker` block gives the single combined verdict. Diagnosis is derived from the raw durable connections source (scoped by the control workspace root, not the project's own workspace root) rather than resolve-project output, so a malformed tracker is diagnosable even where legacy manifests would otherwise silently drop it, an unreadable durable source is distinguished from an intentionally absent one, and a project's own workspace root differing from the control workspace root does not lose the diagnosis. Reports use fixed statuses/remediation and never return raw secrets, token previews, command environments, or stdout/stderr.
  _Evidence:_ src/tesseraft/control_plane/doctor.clj work-tracker-doctor-check, src/tesseraft/control_plane/core.clj project-connection-source/work-tracker-diagnosis/work-tracker-config-diagnosis/work-tracker-credential-diagnosis, src/tesseraft/control_plane/cli.clj doctor, web/src-server/routes/api.ts /api/projects/:projectId/doctor, web/src/components/ConnectionsDoctorPanel.tsx tracker-state pills, test/web-server.test.js doctor endpoint, test/work-tracker-settings-doctor.test.js, test/web-ui.test.js ConnectionsDoctorPanel, scripts/test.sh control-plane doctor, docs/CONTROL_PLANE_API.md Connections Doctor response / Work-tracker diagnosis, manual-testing/connections-doctor.md
- **project-abstraction** (implemented) — First-class Project abstraction: a named aggregate owning workspace root, run root, workflow discovery context, non-secret settings, and project-specific Jira/GitHub connection config. Raw credentials stay out of repositories behind credential-refs. Portable .tesseraft/project.json identity supports bounded nearest-project discovery and maps through a versioned user-local registry; resolution preserves documented precedence and fails closed with all applicable canonical roots on identity conflicts. Registration supports explicitly moved roots, and portable migration writes descriptor/registry state transactionally without deleting or rewriting legacy source bytes. Control-plane CRUD + resolve-project + default-project fallback (legacy settings/git-user read fallback), run-state project_id stamping with project.resolved event, and /api/projects* HTTP routes are project scoped; browser roots remain confined while trusted local CLI roots are explicit. Legacy default routes remain compatible, and the Web UI selector scopes fetches.
  _Evidence:_ src/tesseraft/control_plane/core.clj project-scoped-opts/resolve-project/read-project-descriptor/read-project-registry/migrate-project-portable/list-projects/get-project/create-project/update-project/get-project-connections/update-project-connections matching-run-files/resolve-run project_id filter, src/tesseraft/control_plane/cli.clj --project-id and project register/migrate threading, src/tesseraft/runtime/core.clj init-context runs-root/workspace-root, src/tesseraft/runtime/cli.clj --runs-root/--workspace-root, schemas/run-state.schema.json project_id, schemas/project.schema.json, schemas/portable-project-descriptor.schema.json, schemas/user-project-registry.schema.json, schemas/credential-ref.schema.json, web/src-server/routes/api.ts /api/projects/:projectId/{workflows,runs,settings,git-user}, web/src/lib/project.ts, web/src/components/ProjectSelector.tsx, web/src/App.tsx ProjectContext, web/src/components/{GitUserPanel,RunControls,ApprovalPanel,ArtifactBrowser,RunInspection,SettingsPanel,StartWorkflowWizard}.tsx projectApiUrl routing, test/project-contract.test.js, test/project-root-selection.test.js, test/project-scope.test.js, docs/PROJECTS.md, docs/CONTROL_PLANE_API.md project section
- **work-tracker-contract** (implemented) — Optional project-owned `connections.work-tracker` contract with normalized provider/credential-ref/config envelope, built-in Plane/Jira/GitHub Issues schema validation, CLI/HTTP set-inspect-clear behavior, recursive secret rejection, atomic project-scoped persistence, and no provider API execution. Legacy GitHub code-host/PR and Jira connection semantics remain independent. A schema-driven Settings editor (`WorkTrackerPanel`) and `GET /api/work-tracker-providers`/`project work-tracker-providers` expose ordered provider field metadata (label/type/required/placeholder) so the form renders from the registry rather than a hard-coded Plane-only field set, including runtime-registered package providers.
  _Evidence:_ src/tesseraft/control_plane/core.clj normalize-work-tracker/update-project-connections/list-work-tracker-providers/register-work-tracker-provider!, src/tesseraft/control_plane/cli.clj --work-tracker-* and --clear-work-tracker and project work-tracker-providers, web/src-server/routes/api.ts work_tracker forwarding and /api/work-tracker-providers, web/src/components/WorkTrackerPanel.tsx, web/src/components/SettingsPanel.tsx, schemas/work-tracker*.schema.json, schemas/project.schema.json connections.work-tracker, schemas/portable-project-descriptor.schema.json connections.work-tracker, test/work-tracker-contract.test.js, test/work-tracker-settings-doctor.test.js, test/web-server.test.js WT4 HTTP work-tracker editor round trip, test/web-ui.test.js WorkTrackerPanel, docs/PROJECTS.md Work tracker connection / Settings editor and diagnosis, docs/CONTROL_PLANE_API.md project connections work_tracker, docs/WEB_UI.md
- **container-install** (implemented) — Containerized install path and install_deps script.
  _Evidence:_ docs/CONTAINER_INSTALL.md, scripts/install.sh, test/container/
- **blocked-run-state** (implemented) — Runtime approval/manual-input node: blocked run state, approval request/decision records, approval.requested/approval.decided events, and artifact comments.
  _Evidence:_ schemas/run-state.schema.json enum "blocked", src/tesseraft/runtime/core.clj approval pause/resume, web/src/components/ApprovalPanel.tsx, web/src-server/lib/approvals.ts, docs/MERGE_PROTOCOL.md
- **fragment-package-contract** (implemented) — First-class fragment packages (`tesseraft.fragment/v1`): EDN/JSON-normalized boundary contract linting, JSON-compatible portable projection, `bb fragment lint|import`, deterministic safe-name/scope/version/input/parameter/prefix inclusion contracts, package identity verification, derived effective inclusion inspection data, static workflow resource-flow projection of valid inclusion boundary requires/consumes/all-exit produces, and transactional complete `fragment import` that strict-lints package/candidate workflow, writes explicit input/parameter/outcome bindings, reuses identical assets, rejects collisions, and rolls back handled failures without mutating authored workflow data. Inclusion lints the boundary without duplicating internal proof.
  _Evidence:_ src/tesseraft/spec.clj read-fragment-package/portable-fragment-package-data/safe-relative-prefix?, src/tesseraft/fragment/cli.clj, src/tesseraft/lint/core.clj lint-fragment-package/fragment-inclusions/workflow-with-fragment-boundary-resources, docs/FRAGMENTS.md, docs/LINTER.md, schemas/fragment-package.schema.json, examples/fragments/test-fix-loop/fragment.edn, test/fixtures/valid/fragment-parity/fragment.{edn,json}, test/fixtures/invalid/fragment-parity/fragment.{edn,json}, test/fragment_package_parity.test.py, test/fragment_inclusion_contract.test.py, test/fragment_boundary_resources.test.py, test/fragment_import_transaction.test.py, bb.edn :fragment
- **scope-shadow-metadata** (implemented) — Workflow discovery (list + detail) exposes scope (configured/global/project), precedence, and shadowing metadata (duplicates lowered by precedence; conflicts at equal precedence) so the UI can show when a project workflow overrides a global/example one. Discovery precedence semantics are unchanged; metadata is purely inspectable.
  _Evidence:_ src/tesseraft/control_plane/core.clj list-workflows/get-workflow, test/discovery-scope.test.js, web/src/types/runConsole.ts, scripts/test.sh scope-shadow block
- **recovery-tests** (implemented) — Interrupted-agent recovery + orphan detection with node.recovered events.
  _Evidence:_ scripts/test.sh recovery fixture, src/tesseraft/runtime/core.clj
- **routeapi-architecture** (implemented) — Declarative routeApi mapping /api paths to control-plane commands.
  _Evidence:_ web/src-server/routes/api.ts, test/web-server.test.js
- **pinga-handler** (implemented) — Deterministic `:notify/pinga` handler shelling out to $PINGA_BIN.
  _Evidence:_ src/tesseraft/adapters/builtin.clj notify-pinga!, src/tesseraft/spec.clj
- **fragment-runtime-execution** (implemented) — Runtime for `{:type :fragment}` nodes covering reachable `:agent`/`:process`/`:timer`/`:deterministic`/`:router`/`:terminal` internal graphs through the exact same executor/handler/transition machinery as top-level workflows: per-execution re-resolution and pin of the package identity/content hash with the parent run, rendered input/effective-parameter binding into an isolated nested run context (package-relative prompt/script assets resolve against the pinned package dir, and runner mock mode is inherited so a `--executor mock` parent renders package templates and writes placeholder artifacts with no credentials), fragment-local `:max-rounds`/round/attempt bookkeeping isolated from the parent, mapping of the reached terminal outcome onto the parent `:fragment/outcome` transition, and durable inspectable nested `pin.json`/`state.edn`/`events.jsonl` under `fragments/<state>/<attempt>`. On success, `finish!` materializes the reached exit entry's declared `:produces` paths from the nested run dir into the parent run dir at the inclusion's `:prefix` (a blank prefix projects onto the identical relative path, matching the FI4 lint prefix projection exactly). Every `:produces` value must be a safe relative path: `fragment-interface-checks` blocks any that is not at package-lint time (`fragment-exit-invalid-produces-path`), and `finish!` independently refuses an unsafe value with `fragment_exit_output_invalid_path` before reading or writing anything, so a package that predates the lint rule still cannot escape the nested or parent run dir. A key required by `:interface :outputs` whose file was never written raises `fragment_exit_output_missing`, and a destination path already owned by a different parent inclusion state, or one that already exists in the parent run dir with no recorded fragment ownership at all, raises `fragment_exit_output_conflict` (tracked in a per-run `fragments/exit-index.json` ownership index; the same inclusion state re-materializing on its own retry is not a conflict), so two inclusions of the same fragment, or a blank-prefix inclusion colliding with a parent-owned artifact, can never silently overwrite one another. Materialized paths are exposed on both the `node.finished` result and the `fragment.finished` event as `:exit_outputs`. A reachable `:approval` internal node is still rejected with `fragment_unsupported_node` before any internal execution; a nested `:fragment` state is rejected earlier and separately, as a package-lint structural error surfacing as `fragment_unresolved`; an otherwise-unresolvable inclusion also fails with `fragment_unresolved`; exhausting the fragment's own rounds fails with `fragment_max_rounds` without advancing the parent round; a genuine internal `node.failed` fails the parent with `fragment_internal_failure`; a nested run that reaches its own terminal in full but whose outcome no parent transition would route fails with `fragment_outcome_unrouted` naming the reached outcome, decided by the same `spec/match-transition?` predicate that later chooses the transition, over a result the one `finish!` returns only extends (`:exit_outputs` is added afterward; `match-transition?` reads only the keys a transition's `:when` names), so the two can never disagree. A nested run's `fragments/<state>/<attempt>/state.edn` is excluded from the control plane's run inventory (CLI `run list`, `GET /api/runs`, Web UI Runs table) by matching only a `fragments` segment at or beyond the run's own two identity segments, so a fragment inclusion never appears as its own run entry while a top-level run whose *run id* is literally `fragments` still does. A detached process a fragment-internal `:deterministic`/`:process` handler starts is marked with the nested run dir, and the parent's own `run cancel`/terminal-run cleanup reaps it by matching owner markers nested under the given run dir, not just an exact match. A nested failure raised outside `execute-node!`'s own try/catch (no parent transition matches the reached internal result) propagates its original cause into the parent's `node.failed` result instead of being reported as fragment step-budget exhaustion.
  _Evidence:_ src/tesseraft/runtime/fragment.clj, src/tesseraft/runtime/core.clj run-fragment-node!/execute-node!/choose-transition/owned-by-run-dir?, src/tesseraft/spec.clj match-transition?/outcome-name/safe-relative-path?, src/tesseraft/lint/core.clj fragment-interface-checks, src/tesseraft/control_plane/core.clj run-state-files/nested-fragment-run-state-file?, test/fixtures/valid/fragment-runtime/{runtime-pass,runtime-fail,runtime-rounds,runtime-timer,runtime-unrouted,runtime-bound,runtime-internal-failure,runtime-approval,runtime-process,runtime-mock-agent,runtime-exit-outputs,runtime-exit-outputs-missing,runtime-retry-loop}/fragment.edn, test/fixtures/invalid/fragment-exit-unsafe-produces/fragment.edn, test/fragment_runtime_execution.test.py, test/fragment_runtime_nodes.test.py, docs/FRAGMENTS.md#runtime-behavior, scripts/test.sh FI6, scripts/test.sh FI7
- **color-schemes** (implemented) — Project-scoped console color schemes with accessible Classic/Matrix settings, file-backed persistence, immediate application, project switching, and a complete black/green Matrix palette.
  _Evidence:_ src/tesseraft/control_plane/core.clj color_scheme settings contract, web/src/App.tsx data-color-scheme owner, web/src/components/SettingsPanel.tsx color scheme radio group, web/src/style.css Matrix semantic palette, test/web-server.test.js, test/project-scope.test.js

Partial:

- **web-ui** (partial) — Workflow Studio + Run Console scaffold exists; not feature-complete.
  _Evidence:_ web/src/, web/src/components/WorkflowStudio.tsx, docs/WEB_UI.md

Not yet implemented:

- Full Pi SDK executor
- Durable DB-backed runner
<!-- END STATUS -->
