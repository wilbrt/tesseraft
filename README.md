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

This lints the smoke, prompt-to-pr, worktree-to-pr, code-review-loop, and jira-to-pr example workflows, runs the local smoke workflow plus a mock executor dry run, verifies invalid fixtures fail lint, and runs the Web UI server/component suites. It does not run Pi, Jira, GitHub, or hosted-service workflows.

The Playwright browser gate builds and serves the production Web UI on
localhost, then performs a read-only Chromium inspection of the bundled
`smoke-demo` workflow graph. Install the pinned Chromium revision once with:

```bash
npx playwright install --with-deps chromium
```

Run it headlessly or in Playwright UI mode with:

```bash
npm run web:e2e
npm run web:e2e:ui
```

This gate is localhost-only and does not create workflows or start runs.

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
- `examples/canon-tdd-to-pr/workflow.edn` — approved agile use case, one-scenario-at-a-time Canon TDD in an isolated worktree, regression/review repair, and PR creation. See [`docs/CANON_TDD_WORKFLOW.md`](docs/CANON_TDD_WORKFLOW.md).
- `examples/mock-run-workflow/workflow.edn` — side-effect-free implementation/review workflow for runner and UI testing.
- See `docs/WORKFLOW_RUNS.md` for safe side-effecting workflow run instructions.
- `examples/pr-housekeeping/workflow.edn` — safe PR housekeeping report that classifies open pull requests without mutating GitHub state.
- `examples/jira-to-pr/workflow.edn` — Jira-to-PR workflow with manual browser testing.

```bash
./bin/tesseraft lint examples/prompt-to-pr/workflow.edn
./bin/tesseraft lint examples/code-review-loop/workflow.edn
./bin/tesseraft lint examples/canon-tdd-to-pr/workflow.edn
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

- **node-packaging-system** (implemented) — Self-contained node package import/export via `bb node`.
  _Evidence:_ src/tesseraft/node/cli.clj, docs/NODES.md, docs/PACKAGES.md, bb.edn :node
- **mock-executor** (implemented) — Runner-level mock/dry-run mode: opt-in `--executor mock` execution that renders prompts and writes passing placeholder artifacts, with deterministic mock results for Jira/Git/GitHub/Pinga side-effect handlers; executor-mode persisted in run state.
  _Evidence:_ src/tesseraft/runtime/core.clj mock-mode?/executor-mode, src/tesseraft/executors/mock.clj, examples/mock-run-workflow/workflow.edn, scripts/test.sh mock dry-run, README.md §Mock mode
- **connections-doctor** (implemented) — Project-scoped local-first Connections Doctor: `tesseraft control-plane --project-id <id> doctor`, `GET /api/projects/:projectId/doctor`, and a Settings panel report bounded static/read-only readiness for GitHub/Jira credential refs, gh auth, Pi provider/model local catalog, Git author identity, repo/runs roots, Pinga config, and workflow discovery. Reports use fixed statuses/remediation and never return raw secrets, token previews, command environments, or stdout/stderr.
  _Evidence:_ src/tesseraft/control_plane/doctor.clj, src/tesseraft/control_plane/cli.clj doctor, web/src-server/routes/api.ts /api/projects/:projectId/doctor, web/src/components/ConnectionsDoctorPanel.tsx, test/web-server.test.js doctor endpoint, test/web-ui.test.js ConnectionsDoctorPanel, scripts/test.sh control-plane doctor, docs/CONTROL_PLANE_API.md Connections Doctor response, manual-testing/connections-doctor.md
- **project-abstraction** (implemented) — First-class Project abstraction: a named aggregate owning workspace root, run root, workflow discovery context, non-secret settings, and project-specific Jira/GitHub connection config. Raw credentials kept out of repos behind credential-refs resolved from ~/.tesseraft/credentials.json. Control-plane CRUD + resolve-project + default-project fallback (legacy settings/git-user read fallback), run-state project_id stamping with project.resolved event, and /api/projects* HTTP routes (secrets never returned; raw token writes rejected). Project-scoped operations: a global --project-id threads discovery, runs, settings, git-identity, and run identity (project_id, run_id) through the control-plane CLI and the HTTP API (/api/projects/:projectId/{workflows,runs,...}); project-scoped opts resolve the project's workspace_root/runs_root/discovery against the control workspace; the runtime honors --workspace-root/--runs-root so runs land under the selected project; legacy default routes are unchanged (delegate to the default project). A Web UI Project selector persists the active project and scopes all fetches.
  _Evidence:_ src/tesseraft/control_plane/core.clj project-scoped-opts/resolve-project/list-projects/get-project/create-project/update-project/migrate-project/get-project-connections/update-project-connections matching-run-files/resolve-run project_id filter, src/tesseraft/control_plane/cli.clj --project-id threading, src/tesseraft/runtime/core.clj init-context runs-root/workspace-root, src/tesseraft/runtime/cli.clj --runs-root/--workspace-root, schemas/run-state.schema.json project_id, schemas/project.schema.json, schemas/credential-ref.schema.json, web/src-server/routes/api.ts /api/projects/:projectId/{workflows,runs,settings,git-user}, web/src/lib/project.ts, web/src/components/ProjectSelector.tsx, web/src/App.tsx ProjectContext, web/src/components/{GitUserPanel,RunControls,ApprovalPanel,ArtifactBrowser,RunInspection,SettingsPanel,StartWorkflowWizard}.tsx projectApiUrl routing, test/project-scope.test.js, docs/PROJECTS.md, docs/CONTROL_PLANE_API.md project section
- **container-install** (implemented) — Containerized install path and install_deps script.
  _Evidence:_ docs/CONTAINER_INSTALL.md, scripts/install.sh, test/container/
- **blocked-run-state** (implemented) — Runtime approval/manual-input node: blocked run state, approval request/decision records, approval.requested/approval.decided events, and artifact comments.
  _Evidence:_ schemas/run-state.schema.json enum "blocked", src/tesseraft/runtime/core.clj approval pause/resume, web/src/components/ApprovalPanel.tsx, web/src-server/lib/approvals.ts, docs/MERGE_PROTOCOL.md
- **fragment-package-contract** (implemented) — First-class fragment packages (`tesseraft.fragment/v1`): boundary contract linting, `bb fragment lint|import`, scope model, and one fixture. Inclusion lints the boundary without duplicating internal proof.
  _Evidence:_ src/tesseraft/fragment/cli.clj, src/tesseraft/lint/core.clj lint-fragment-package, docs/FRAGMENTS.md, schemas/fragment-package.schema.json, examples/fragments/test-fix-loop/fragment.edn, bb.edn :fragment
- **scope-shadow-metadata** (implemented) — Workflow discovery (list + detail) exposes scope (configured/global/project), precedence, and shadowing metadata (duplicates lowered by precedence; conflicts at equal precedence) so the UI can show when a project workflow overrides a global/example one. Discovery precedence semantics are unchanged; metadata is purely inspectable.
  _Evidence:_ src/tesseraft/control_plane/core.clj list-workflows/get-workflow, test/discovery-scope.test.js, web/src/types/runConsole.ts, scripts/test.sh scope-shadow block
- **recovery-tests** (implemented) — Interrupted-agent recovery + orphan detection with node.recovered events.
  _Evidence:_ scripts/test.sh recovery fixture, src/tesseraft/runtime/core.clj
- **routeapi-architecture** (implemented) — Declarative routeApi mapping /api paths to control-plane commands.
  _Evidence:_ web/src-server/routes/api.ts, test/web-server.test.js
- **pinga-handler** (implemented) — Deterministic `:notify/pinga` handler shelling out to $PINGA_BIN.
  _Evidence:_ src/tesseraft/adapters/builtin.clj notify-pinga!, src/tesseraft/spec.clj
- **color-schemes** (implemented) — Project-scoped console color schemes with accessible Classic/Matrix settings, file-backed persistence, immediate application, project switching, and a complete black/green Matrix palette.
  _Evidence:_ src/tesseraft/control_plane/core.clj color_scheme settings contract, web/src/App.tsx data-color-scheme owner, web/src/components/SettingsPanel.tsx color scheme radio group, web/src/style.css Matrix semantic palette, test/web-server.test.js, test/project-scope.test.js

Partial:

- **web-ui** (partial) — Workflow Studio + Run Console scaffold exists; not feature-complete.
  _Evidence:_ web/src/, web/src/components/WorkflowStudio.tsx, docs/WEB_UI.md

Not yet implemented:

- Full Pi SDK executor
- Durable DB-backed runner
<!-- END STATUS -->
