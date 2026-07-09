# Tesseraft Web UI

Status: Draft — current baseline plus v3.2 alignment

## Description

Tesseraft Web UI is the local browser surface over the workflow specification,
standalone linter, reference runner, and control-plane APIs. It is not a new
workflow format and it is not a separate runtime authority.

The Web UI has two separate surfaces:

- **Workflow Studio** for authoring and validating workflow packages.
- **Run Console** for starting, observing, and controlling pinned workflow runs.

The durable contracts remain workflow files, normalized workflow data, linter
results, run state, event logs, artifacts, approval records, and node packages.
UI state may make those contracts easier to inspect or edit, but it must be
disposable or reconstructable from them.

## Current implementation snapshot

As of the v3.2 roadmap reconciliation, the repo already contains a local Web UI
implementation under `web/`:

- React/Vite frontend with Workflow, Runs, Pi Sessions, Settings, and Workflow
  Studio surfaces.
- Express/local HTTP API under `/api` backed by control-plane and runtime CLI
  commands.
- Workflow discovery, workflow detail, graph data, run list/detail, events, and
  artifact routes.
- Server-Sent Events streams for runs and Pi sessions.
- Workflow Studio create/read/save/lint routes that write explicit package files
  under `.tesseraft/workflows/<name>/` and use the linter as the completed-save
  gate.
- Workflow package asset read/write routes for prompt-like assets, path-confined
  to the package directory.
- Run creation, background resume, step, resume, and delete controls where the
  runner supports them.
- Settings, git-user, browse, and Pi-session routes.
- Web tests in `npm run web:test` plus manual testing notes in `manual-testing/`.

Known semantic gaps remain:

- Runner-level mock executor / dry-run mode landed in PR #8 (merged); the
  remaining roadmap dependency is the one-key mock-run UI surface and mock-mode
  badges (P2.2), built on the now-implemented `--executor mock` runtime and
  executor-mode persistence.
- Runtime approval/manual-input support landed in PR #44 (merged); the remaining
  roadmap dependency is the diff-centric self-checkpoint approval UX itself
  (P3.1), built on the now-implemented approval request/decision records and
  `approval.requested`/`approval.decided` events.
- Catalog-as-lens, cross-scope shadowing visibility, and fragment packages are
  next-step UX/product work over existing package discovery concepts.

## v3.2 phase-1 product frame

Phase 1 is optimized for **one technical developer automating their own daily
corporate work**: ticket intake, environment setup, development, tests, failure
loops, PR drafting, review comments, and fixes. That developer lives in the
terminal; the Web UI earns its place for graphs, rich artifacts, diffs,
notifications, and fast workflow composition.

Design implications:

- **Composition and reuse are central.** The catalog should be a lens over
  existing workflow/node discovery, scopes, schemas, and import/export, not a
  new registry.
- **Mock mode is the Studio REPL once available.** It should be clearly badged
  and side-effect-free.
- **Gates are self-checkpoints in phase 1.** Approval UX should be low-ceremony,
  diff-centric, and durable, but not multi-user/fleet-oriented yet.
- **CLI and UI are one local surface.** CLI commands should point to the UI when
  useful, and UI views should expose copy-as-CLI affordances where practical.

## Problem

Tesseraft already has both implementation and design vocabulary for Workflow
Studio and Run Console. Without a clear boundary, the UI could accidentally
combine authoring state, runtime control, and persisted run history. That would
make UI state a hidden source of truth and weaken the workflow-as-code contract.

This document defines the vocabulary, current baseline, and boundaries so future
UI work can stay aligned with the platform contract while extending existing
screens, APIs, and tests.

## Glossary

- **Workflow Studio**: The authoring surface for workflow packages. It edits
  workflow files and related package assets, presents graph and contract views,
  and validates changes with the linter before they become accepted workflow
  behavior.
- **Run Console**: The runtime surface for runs. It starts runs from selected
  workflow versions, observes run progress, displays node attempts, events, and
  artifacts, and records supported runtime controls.
- **Control plane**: The API boundary used by the Run Console and Workflow
  Studio to inspect workflows/runs and invoke supported runner operations
  without making the UI the owner of runtime state. The local HTTP contract is
  sketched in [CONTROL_PLANE_API.md](CONTROL_PLANE_API.md).
- **Workflow package**: A set of workflow definition files and assets such as
  `workflow.edn`, prompt templates, scripts, schemas, and policies. The package
  defines workflow behavior.
- **Run**: One execution of a workflow pinned to an immutable workflow version
  such as a content hash or Git commit. Existing runs must not silently switch
  versions.
- **Artifact**: A declared output file or structured value produced by a node
  attempt and recorded according to the workflow's artifact contracts.
- **Resource**: A workflow object with proof semantics, such as an input,
  artifact, branch/worktree, schema, prompt template, approval, policy, or
  capability. Resources may be reusable, produced, consumed, one-shot,
  unavailable until produced, or capability-like.
- **Proof trace**: The durable runtime evidence for a run: event logs,
  artifacts, node attempts, validated transitions, approval records, and run
  state.
- **Expected outcome**: A declared node result such as `status: fail` that
  intentionally drives workflow transitions.
- **External failure**: A runtime/environment failure such as a missing
  dependency, malformed process output, nonzero subprocess exit, missing
  required artifact, timeout, or unknown handler/executor. It is recorded as
  failed evidence rather than treated as a declared transition outcome.
- **Event log**: The append-only runtime history for a run, including events
  such as `run.started`, `node.started`, `node.finished`, `node.failed`,
  `transition.selected`, `artifact.written`, `effect.applied`,
  `approval.requested`, `approval.decided`, and `agent.event`.
- **Node package**: A portable package for one reusable workflow node and its
  intrinsic assets, interface, requirements, and node declaration. Importing
  workflows own routing and integration.
- **Approval**: A human decision gate in a run. Approval requests and decisions
  are runtime events and must be recorded durably once runtime approval support
  lands.

## Non-goals

- Replace workflow files as the source of truth.
- Add UI-only workflow behavior that is absent from the workflow package.
- Mutate workflow definitions during runtime execution.
- Mutate live run state from authoring sessions.
- Treat browser drafts, filters, graph layout, or tabs as durable behavior.
- Define a public node repository protocol.
- Build hosted, multi-user, fleet, or compliance dashboards in phase 1.

## Source-of-truth rules

1. Workflow definitions and workflow packages define workflow behavior.
2. Normalized workflow data must remain JSON-compatible and portable across
   implementations.
3. Linter output is the validation authority for authoring changes before a
   runner accepts them.
4. A run is pinned to an immutable workflow version at start time.
5. Runtime effects mutate run state, not workflow definitions.
6. Event logs, artifacts, node attempts, and run state describe runtime history
   and current status; together they form the reconstructable proof trace.
7. Approval requests and decisions are runtime records, not private UI state.
8. UI state may cache, filter, arrange, or draft information, but authoritative
   behavior and runtime history must be reconstructable from durable contracts.

## Workflow Studio and Run Console separation

### Workflow Studio

Workflow Studio helps users author workflow packages. It may:

- edit `workflow.edn` and package assets such as prompts, scripts, schemas, and
  policies;
- render graph, node contract, artifact, and transition views from normalized
  workflow data;
- run linter validation and show diagnostics before changes are accepted;
- assist with explicit file diffs for authoring changes;
- import and export node packages while preserving package boundaries;
- preview how a workflow would be run without mutating live run state;
- copy example/global packages into project scope before editing them.

Workflow Studio must not:

- decide transitions for a live run;
- write event log entries for a live run;
- mutate run state, node attempts, artifacts, or approvals;
- treat unsaved UI edits as workflow behavior;
- mutate bundled examples or global packages when the user's intent is a
  project-local edit.

### Run Console

Run Console helps users operate runs. It may:

- start a run from a selected immutable workflow version;
- display current run state, node attempts, transition decisions, events,
  artifacts, failures, and the proof trace that distinguishes expected outcomes
  from external failures;
- stream agent and process events exposed by the runner;
- show the exact workflow version used by a run;
- request and record approval decisions through the control plane once runtime
  approval support lands;
- expose safe step, resume, delete/cancel, retry, or other runtime controls when
  the runner contract supports them.

Run Console must not:

- edit workflow definition files;
- silently upgrade a live run to different workflow content;
- let runtime Pi sessions modify workflow source files;
- make local UI filters, tabs, or draft controls part of runtime truth.

## Initial user objectives

See [WEB_UI_USE_CASES.md](WEB_UI_USE_CASES.md) for a use-case matrix that
expands these objectives. See [WEB_UI_ARCHITECTURE.md](WEB_UI_ARCHITECTURE.md)
for the serving and control-plane architecture decision matrix.

Users should be able to:

1. Author and validate workflow packages with visible file changes.
2. Inspect workflow graph shape, node contracts, artifact declarations, template
   variables, and linter diagnostics.
3. Import or export node packages with clear ownership of intrinsic node
   behavior versus workflow integration.
4. Start a run from a selected workflow version.
5. Observe run progress, node attempts, transition choices, event logs,
   artifacts, liveness, and failures.
6. Decide approval nodes with durable recorded decisions once the approval
   runtime lands.
7. Understand whether they are editing future workflow behavior or controlling
   an existing run.
8. Compose personal workflows from catalog nodes/fragments rather than writing
   bespoke nodes for every automation.

## Implementation phases and roadmap alignment

### Implemented baseline: local Studio + Run Console

The current implementation already provides local workflow inspection,
graph/detail views, Studio create/save/lint, package asset editing, run
start/step/resume/delete, run/event/artifact inspection, SSE refresh, Settings,
git-user, and Pi-session surfaces. This baseline should be maintained behind
`npm run web:test` and manual-testing scripts.

### Next: catalog and composition UX

Add the catalog-as-lens over existing example/global/project discovery, scope
badges, override/shadowing visibility, and node import/export affordances. Add
fragment package contracts and gallery support after the contract is designed.

### Next: Studio inner loop

Add continuous lint-in-context, resolved prompt preview, schema-driven launch
forms, and one-key mock-run on top of the landed runner-level mock mode
(`--executor mock`; remaining work is the UI surface, P2.2).

### Next: self-checkpoint gates

The approval/manual-input runtime landed in PR #44 (merged), exposing durable
approval request/decision records and `approval.requested`/`approval.decided`
events through the control plane. Next, add diff-centric approval screens,
needs-you strip, and notification/deep-link flows for the single-developer
phase-1 persona (P3.1) on top of those durable records.

## Decisions

- **Separate Workflow Studio and Run Console.** Authoring changes and runtime
  controls have different durable records and must not share hidden UI state.
- **Keep workflow packages authoritative.** Tesseraft is workflow-as-code; UI
  convenience must not redefine behavior.
- **Use the linter as an authoring boundary.** Workflow Studio should surface
  diagnostics from the standalone linter rather than duplicate validation rules
  in UI-only code.
- **Pin runs to immutable workflow versions.** Run Console can show and control
  a run, but it cannot change the workflow content already selected for that
  run.
- **Keep the local HTTP control plane explicit.** The UI consumes spec, linter,
  runner, and file-backed control-plane contracts; it does not own them.

## Open questions

- What exact mutation semantics should be standardized for retry, cancel/abort,
  approval decisions, and idempotent resume beyond the currently implemented
  start/step/resume/delete paths?
- What authentication and authorization model should protect authoring and
  runtime operations before non-localhost exposure?
- What approval UX gives enough diff/artifact context while recording decisions
  as durable runtime events?
- How should catalog cards show scope, shadowing, and schema-derived resource
  signatures?
- How can agentic authoring assistance remain useful while preserving explicit
  diffs and linter validation?
- How should fragments be packaged and linted without weakening the local
  workflow/node package contract?
