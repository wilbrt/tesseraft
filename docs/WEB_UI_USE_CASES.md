# Tesseraft Web UI Use Cases

Status: Draft — current baseline plus v3.2 alignment

This document records user objectives for the Tesseraft Web UI before expanding
screens or APIs further. Some objectives already have local implementation; this
file distinguishes the current baseline from next work.

## Framing

The Web UI has two separate surfaces:

- **Workflow Studio** helps users author, inspect, and validate workflow
  packages.
- **Run Console** helps users start, observe, and control pinned workflow runs.

User intention comes first. Workflow files, normalized workflow data, linter
results, run state, event logs, artifacts, approval records, and node packages
remain the durable contracts. UI state may cache, arrange, filter, or draft
information, but it must not become the source of truth for workflow behavior or
runtime history.

## Phase-1 user and product focus

Phase 1 targets one technical developer automating their own corporate workflow:
Jira/spec intake, environment setup, development, tests, failures, PRs, review
comments, and fixes. They live in the terminal; the Web UI earns its keep where
the terminal is weak: graphs, diffs, rich artifacts, notifications, and workflow
composition.

The adoption gate is reuse: a developer should compose a personalized workflow
from existing catalog nodes/fragments and mock-run it safely before spending
credentials, tokens, or external effects.

## Current implementation baseline

The current local Web UI already supports:

- workflow list/detail/graph inspection via the control plane;
- Workflow Studio create/read/save/lint for project-local packages under
  `.tesseraft/workflows/<name>/`;
- prompt-like package asset read/write with path confinement;
- run list/detail, event/artifact views, liveness/staleness presentation, and
  run SSE refresh;
- run start, step, background resume, and delete controls where supported by the
  runner;
- Settings, local git-user configuration, repository browse, and Pi-session
  surfaces;
- web-server and Studio tests in `npm run web:test` plus manual testing notes.

Known next-work gaps:

- catalog cards over example/global/project scopes, node packages, and override
  visibility;
- fragment package contracts and gallery;
- one-key mock-run from Studio, blocked on runner-level mock executor support;
- approval/self-checkpoint UX; the runtime approval/manual-input support landed in
  PR #44 (merged), so the remaining work is the diff-centric self-checkpoint UI
  (P3.1);
- richer CLI↔UI deep links and copy-as-CLI affordances.

## Use-case matrix

| User objective / intention | Surface | Current CLI/file-based way | Current / planned UI support | Notes / open questions |
| --- | --- | --- | --- | --- |
| Understand the workflow shape before changing or running it. | Workflow Studio | Read `workflow.edn`; run `./bin/tesseraft lint workflow.edn --emit graph` or `--emit mermaid`; inspect normalized states, transitions, terminal nodes, and artifact declarations. | **Implemented baseline:** workflow list/detail and graph rendering from control-plane/linter data. **Next:** resource-port and contract visualizations for composition. | Graph presentation must be reconstructable from workflow files and linter output, not saved as hidden behavior. |
| Validate whether a workflow package is acceptable. | Workflow Studio | Run `./bin/tesseraft lint workflow.edn`, `--format json`, or `--strict`; use linter output in CI or local checks. | **Implemented baseline:** Studio lint route and completed-save lint gate. **Next:** continuous lint-in-context on graph, node editor, assets, and EDN/source panes. | The standalone linter remains the validation authority; UI should not fork validation rules. |
| Change a node's declared configuration while preserving workflow-as-code review. | Workflow Studio | Edit node maps in `workflow.edn`; re-run lint; review Git diffs. | **Implemented baseline:** Studio writes explicit project-local workflow files and sidecar draft state. **Next:** clearer explicit diff review, copy-as-CLI, and schema-driven editors. | Unsaved drafts are not workflow behavior. Authoring assistance should preserve explicit diffs and linter validation. |
| Manage prompts, scripts, schemas, and policies that belong to a workflow package. | Workflow Studio | Edit package assets such as `prompts/*.md.tmpl`, `scripts/*`, `schemas/*.schema.json`, and `policies.edn`; lint to catch missing references or invalid schemas. | **Implemented baseline:** path-confined prompt-like asset read/write under the workflow package. **Next:** browse referenced assets from node contracts, unused/missing asset highlighting, and broader asset-type support. | Asset ownership stays with the workflow package unless imported as part of a node package. |
| Reuse or share a self-contained node package without confusing node behavior with workflow integration. | Workflow Studio | Run `./bin/tesseraft node export workflow.edn state-id --out /tmp/node`; run `./bin/tesseraft node import /tmp/node/node.edn workflow.edn --as new-state --next done`; lint after import. | **Next:** Catalog cards for node packages with scope, schema-derived resource signatures, import/export actions, and collision/shadowing explanations. | No public repository protocol is implied. Importing workflows own state id, incoming/outgoing edges, bindings, prefixes, and collision handling. |
| Discover and compose from reusable workflows/fragments. | Workflow Studio | Use examples, project/global `.tesseraft/workflows`, and manual copying. Fragment packages are planned. | **Current baseline:** workflow discovery across examples/global/project. **Next:** catalog-as-lens with scope badges, override visibility, and fragment packages in the same scope model. | Project-local names override global/example names; shadowing must be visible in UI and linter diagnostics. |
| Start a run from known workflow content. | Run Console | Run `./bin/tesseraft run start workflow.edn --run-id ...`; select a workflow file/checkout manually and preserve the resulting run state. | **Implemented baseline:** start workflow form calls `POST /api/runs`, records run state through the runtime, then can background-resume. **Next:** schema-driven launch forms, recent inputs, mock mode, and copy-as-CLI. | Existing runs must not silently switch workflow versions. UI history is not workflow behavior. |
| Know what is happening in the current run. | Run Console | Inspect persisted run state, node attempt records, current state, round counters, status, liveness, and failure information in the run directory. | **Implemented baseline:** run list/detail, liveness/staleness indicators, node attempts, and status panels. **Next:** my-runs grouping for running/parked/blocked/stale/failed/recent. | Runtime state describes execution history; UI filters or tabs are not runtime truth. |
| Read the chronological runtime history. | Run Console | Read append-only event logs containing `run.started`, `node.started`, `node.finished`, `transition.selected`, `artifact.written`, `effect.applied`, `approval.requested`, `approval.decided`, and `agent.event`. | **Implemented baseline:** event views plus run SSE snapshot stream. **Next:** paired-event timeline, category filtering, unclosed-span affordances, and raw event access. | Event logs must remain append-only durable records owned by the runner/control plane. |
| Inspect outputs produced by node attempts. | Run Console | Open declared artifact paths in the run directory; compare against output contracts and schemas from `workflow.edn`. | **Implemented baseline:** artifact list and artifact read routes with path confinement. **Next:** richer renderers, schema/status summaries, and links from artifacts to attempts/events. | Artifacts are runtime outputs, not workflow source edits. Required artifact validation belongs to runner/linter contracts. |
| Decide a human approval gate with enough context. | Run Console | Observe an `:approval` node, read its message/context, then record an approval decision that produces durable `approval.requested` and `approval.decided` events. | **Runtime landed (PR #44, merged):** approval request/decision records and events are durable; `POST /api/runs/{run-id}/approvals/{approval-id}` records a decision. **Next:** present a low-ceremony, diff-centric self-checkpoint screen with allowed decisions and consequences text (P3.1). | Decisions must be durable runtime records, not private UI state. Authz is especially important before non-localhost exposure. |
| Resume, step, delete, or abort a run intentionally. | Run Console | Use runner-supported controls; otherwise inspect state and restart or stop processes according to operational practice. | **Implemented baseline:** step, background resume, and delete routes where supported. **Next:** standardize retry/cancel/abort semantics, idempotency, and approval interaction. | Runtime controls must not mutate workflow definitions or repin workflow content. |
| Verify first-run environment and credentials. | Settings / Studio | Manually check GitHub/Jira/Pinga/Pi/git config and discover failures during a run. | **Implemented baseline:** settings, git-user, Pi-session surfaces. **Next:** connections doctor with safe no-op checks and no secret leakage. | The container/runtime-mounted-secrets model should remain the foundation. |

## Cross-cutting open questions

- What exact control-plane semantics should standardize retry, cancel/abort,
  approval decide, and idempotent resume beyond the currently implemented
  start/step/resume/delete paths?
- What authentication and authorization model should protect authoring changes,
  runtime controls, artifact access, and approval decisions before non-localhost
  exposure?
- How should Run Console choose and display immutable workflow versions, such as
  content hashes or Git commits, in all start and rerun flows?
- What approval context is sufficient for a phase-1 self-checkpoint while
  keeping decisions durable and phase-2-routing-ready?
- How can agentic authoring assistance remain useful while preserving explicit
  file diffs and linter-backed validation?
- How should future node/fragment package discovery or repositories work without
  weakening the local package contract?
