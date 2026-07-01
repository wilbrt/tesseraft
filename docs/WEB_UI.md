# Tesseraft Web UI

Status: Draft

## Description

Tesseraft Web UI is a future product surface over the workflow specification, standalone linter, reference runner, and control-plane APIs. It is not a new workflow format and it is not a separate runtime authority.

The Web UI has two separate surfaces:

- **Workflow Studio** for authoring and validating workflow packages.
- **Run Console** for starting, observing, and controlling pinned workflow runs.

The durable contracts remain workflow files, normalized workflow data, linter results, run state, event logs, artifacts, and node packages. UI state may make those contracts easier to inspect or edit, but it must be disposable or reconstructable from them.

## Problem

Tesseraft already names a future Workflow Studio and Run Console, but without a design boundary the UI could accidentally combine authoring state, runtime control, and persisted run history. That would make UI state a hidden source of truth and weaken the workflow-as-code contract.

This document defines the initial vocabulary and boundaries so future UI work can stay aligned with the platform contract before choosing screens, frameworks, or implementation details.

## Glossary

- **Workflow Studio**: The authoring surface for workflow packages. It edits workflow files and related package assets, presents graph and contract views, and validates changes with the linter before they become workflow behavior.
- **Run Console**: The runtime surface for runs. It starts runs from selected workflow versions, observes run progress, displays node attempts, events, and artifacts, and records runtime controls such as approvals.
- **Control plane**: The API boundary used by the Run Console to create, observe, and control runs. It exposes runner operations without making the UI the owner of runtime state. The initial local read-first contract is sketched in [CONTROL_PLANE_API.md](CONTROL_PLANE_API.md).
- **Workflow package**: A set of workflow definition files and assets such as `workflow.edn`, prompt templates, scripts, schemas, and policies. The package defines workflow behavior.
- **Run**: One execution of a workflow pinned to an immutable workflow version such as a content hash or Git commit. Existing runs must not silently switch versions.
- **Artifact**: A declared output file or structured value produced by a node attempt and recorded according to the workflow's artifact contracts.
- **Resource**: A workflow object with proof semantics, such as an input, artifact, branch/worktree, schema, prompt template, approval, policy, or capability. Resources may be reusable, produced, consumed, one-shot, unavailable until produced, or capability-like.
- **Proof trace**: The durable runtime evidence for a run: event logs, artifacts, node attempts, validated transitions, approval records, and run state.
- **Expected outcome**: A declared node result such as `status: fail` that intentionally drives workflow transitions.
- **External failure**: A runtime/environment failure such as a missing dependency, malformed process output, nonzero subprocess exit, missing required artifact, timeout, or unknown handler/executor. It is recorded as failed evidence rather than treated as a declared transition outcome.
- **Event log**: The append-only runtime history for a run, including events such as `run.started`, `node.started`, `node.finished`, `node.failed`, `transition.selected`, `artifact.written`, `effect.applied`, `approval.requested`, `approval.decided`, and `agent.event`.
- **Node package**: A portable package for one reusable workflow node and its intrinsic assets, interface, requirements, and node declaration. Importing workflows own routing and integration.
- **Approval**: A human decision gate in a run. Approval requests and decisions are runtime events and must be recorded durably.

## Non-goals

- Replace workflow files as the source of truth.
- Add UI-only workflow behavior that is absent from the workflow package.
- Mutate workflow definitions during runtime execution.
- Mutate live run state from authoring sessions.
- Choose or commit to a UI framework.
- Define the final control-plane API, authentication model, or database schema.
- Define a public node repository protocol.

## Source-of-truth rules

1. Workflow definitions and workflow packages define workflow behavior.
2. Normalized workflow data must remain JSON-compatible and portable across implementations.
3. Linter output is the validation authority for authoring changes before a runner accepts them.
4. A run is pinned to an immutable workflow version at start time.
5. Runtime effects mutate run state, not workflow definitions.
6. Event logs, artifacts, node attempts, and run state describe runtime history and current status; together they form the reconstructable proof trace.
7. Approval requests and decisions are runtime records, not private UI state.
8. UI state may cache, filter, arrange, or draft information, but authoritative behavior and runtime history must be reconstructable from durable contracts.

## Workflow Studio and Run Console separation

### Workflow Studio

Workflow Studio helps users author workflow packages. It may:

- edit `workflow.edn` and package assets such as prompts, scripts, schemas, and policies;
- render graph, node contract, artifact, and transition views from normalized workflow data;
- run linter validation and show diagnostics before changes are accepted;
- assist with explicit file diffs for authoring changes;
- import and export node packages while preserving package boundaries;
- preview how a workflow would be run without mutating live run state.

Workflow Studio must not:

- decide transitions for a live run;
- write event log entries for a live run;
- mutate run state, node attempts, artifacts, or approvals;
- treat unsaved UI edits as workflow behavior.

### Run Console

Run Console helps users operate runs. It may:

- start a run from a selected immutable workflow version;
- display current run state, node attempts, transition decisions, events, artifacts, failures, and the proof trace that distinguishes expected outcomes from external failures;
- stream agent and process events exposed by the runner;
- show the exact workflow version used by a run;
- request and record approval decisions through the control plane;
- expose safe retry, cancel, resume, or other runtime controls when the runner contract supports them.

Run Console must not:

- edit workflow definition files;
- silently upgrade a live run to different workflow content;
- let runtime Pi sessions modify workflow source files;
- make local UI filters, tabs, or draft controls part of runtime truth.

## Initial user objectives

See [WEB_UI_USE_CASES.md](WEB_UI_USE_CASES.md) for a use-case matrix that expands these objectives before implementation details. See [WEB_UI_ARCHITECTURE.md](WEB_UI_ARCHITECTURE.md) for the serving and control-plane architecture decision matrix.

Users should be able to:

1. Author and validate workflow packages with visible file changes.
2. Inspect workflow graph shape, node contracts, artifact declarations, template variables, and linter diagnostics.
3. Import or export node packages with clear ownership of intrinsic node behavior versus workflow integration.
4. Start a run from a selected workflow version.
5. Observe run progress, node attempts, transition choices, event logs, artifacts, and failures.
6. Decide approval nodes with durable recorded decisions.
7. Understand whether they are editing future workflow behavior or controlling an existing run.

## Initial implementation phases

### Phase 1: inspection and validation

Provide read-only workflow package inspection, graph rendering, node contract views, and linter-backed diagnostics. This phase proves that the UI is a presentation over existing spec and linter contracts.

### Phase 2: explicit authoring

Allow Workflow Studio edits to workflow packages through explicit file diffs. Save behavior only to package files and require linter checks before treating changes as valid.

### Phase 3: runtime console

Build Run Console over the control plane, event log, artifacts, run state, and approval records. Runs must be created from selected immutable workflow versions and must expose the version they use. The architecture matrix recommends a local file-backed HTTP control plane as the first runtime slice; see [CONTROL_PLANE_API.md](CONTROL_PLANE_API.md) for the initial read-first route contract.

### Phase 4: node package UX

Add discovery, import, and export flows for node packages. Keep node package contracts separate from repository or registry distribution mechanisms.

## Decisions

- **Separate Workflow Studio and Run Console.** Authoring changes and runtime controls have different durable records and must not share hidden UI state.
- **Keep workflow packages authoritative.** Tesseraft is workflow-as-code; UI convenience must not redefine behavior.
- **Use the linter as an authoring boundary.** Workflow Studio should surface diagnostics from the standalone linter rather than duplicate validation rules in UI-only code.
- **Pin runs to immutable workflow versions.** Run Console can show and control a run, but it cannot change the workflow content already selected for that run.
- **Defer framework and API details.** The first useful design commitment is the product boundary, not a component library or transport protocol.

## Open questions

- What mutation semantics should extend the read-first control-plane API shape in [CONTROL_PLANE_API.md](CONTROL_PLANE_API.md) for starting, retrying, canceling, resuming, and approving runs?
- What authentication and authorization model should protect authoring and runtime operations?
- What durable DB-backed runner model should own run state, node attempts, and event logs?
- What approval UX gives enough context while recording decisions as durable runtime events?
- How much agentic authoring assistance is useful while preserving explicit diffs and linter validation?
- How should node package repositories or registries distribute packages without weakening the local package contract?
