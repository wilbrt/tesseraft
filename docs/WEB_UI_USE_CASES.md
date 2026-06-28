# Tesseraft Web UI Use Cases

Status: Draft

This document is design documentation only. It records user objectives for the future Tesseraft Web UI before choosing screens, frameworks, APIs, or implementation details.

## Framing

The Web UI has two separate surfaces:

- **Workflow Studio** helps users author, inspect, and validate workflow packages.
- **Run Console** helps users start, observe, and control pinned workflow runs.

User intention comes first; implementation comes later. Workflow files, normalized workflow data, linter results, run state, event logs, artifacts, and node packages remain the durable contracts. UI state may cache, arrange, filter, or draft information, but it must not become the source of truth for workflow behavior or runtime history.

## Use-case matrix

| User objective / intention | Surface | Current CLI/file-based way | Possible UI support | Notes / open questions |
| --- | --- | --- | --- | --- |
| Understand the workflow shape before changing or running it. | Workflow Studio | Read `workflow.edn`; run `./bin/tesseraft lint workflow.edn --emit graph` or `--emit mermaid`; inspect normalized states, transitions, terminal nodes, and artifact declarations. | Render a graph from normalized workflow data with node details, transitions, terminal outcomes, and artifact/contract summaries. | Graph presentation must be reconstructable from workflow files and linter output, not saved as hidden behavior. |
| Validate whether a workflow package is acceptable. | Workflow Studio | Run `./bin/tesseraft lint workflow.edn`, `--format json`, or `--strict`; use linter output in CI or local checks. | Show linter diagnostics next to workflow paths, affected nodes, missing assets, invalid transitions, template-variable problems, and policy violations. | The standalone linter remains the validation authority; UI should not fork validation rules. |
| Change a node's declared configuration while preserving workflow-as-code review. | Workflow Studio | Edit node maps in `workflow.edn`; re-run lint; review Git diffs. | Provide structured editing for node type, inputs, runtime, outputs, transitions, and UI metadata, then show explicit file diffs before saving. | Unsaved drafts are not workflow behavior. Authoring assistance should preserve explicit diffs and linter validation. |
| Manage prompts, scripts, schemas, and policies that belong to a workflow package. | Workflow Studio | Edit package assets such as `prompts/*.md.tmpl`, `scripts/*`, `schemas/*.schema.json`, and `policies.edn`; lint to catch missing references or invalid schemas. | Browse referenced assets from node contracts, edit package files, highlight unused or missing assets, and validate references through lint results. | Asset ownership stays with the workflow package unless imported as part of a node package. |
| Reuse or share a self-contained node package without confusing node behavior with workflow integration. | Workflow Studio | Run `./bin/tesseraft node export workflow.edn state-id --out /tmp/node`; run `./bin/tesseraft node import /tmp/node/node.edn workflow.edn --as new-state --next done`; lint after import. | Guide export/import, show intrinsic package behavior and asset closure, preview destination names and workflow-owned routing before writing files. | No public repository protocol is implied. Importing workflows own state id, incoming/outgoing edges, bindings, prefixes, and collision handling. |
| Start a run from known workflow content. | Run Console | Run `./bin/tesseraft run workflow.edn --run-id ...`; select a workflow file/checkout manually and preserve the resulting run state. | Let users select an immutable workflow version, provide required inputs, create a run through the control plane, and display the pinned version. | Control-plane API shape and authz/authn are open. Existing runs must not silently switch workflow versions. |
| Know what is happening in the current run. | Run Console | Inspect persisted run state JSON, node attempt records, current state, round counters, status, and failure information in the run directory. | Display current run status, active state, node attempts, transition decisions, retries/rounds, failures, and the workflow version used by the run. | Runtime state describes execution history; UI filters or tabs are not runtime truth. |
| Read the chronological runtime history. | Run Console | Read append-only event logs containing `run.started`, `node.started`, `node.finished`, `transition.selected`, `artifact.written`, `effect.applied`, `approval.requested`, `approval.decided`, and `agent.event`. | Stream and filter event logs by category, node, severity, or time while retaining access to raw event details. | Event logs must remain append-only durable records owned by the runner/control plane. |
| Inspect outputs produced by node attempts. | Run Console | Open declared artifact paths in the run directory; compare against output contracts and schemas from `workflow.edn`. | Show artifact lists by node attempt, render common file types, surface schema/status summaries, and link artifacts to event log entries. | Artifacts are runtime outputs, not workflow source edits. Required artifact validation belongs to runner/linter contracts. |
| Decide a human approval gate with enough context. | Run Console | Observe an `:approval` node, read its message/context, then record an approval decision that produces durable `approval.requested` and `approval.decided` events. | Present approval request context, allowed decisions, relevant artifacts/events, and submit the decision through the control plane. | Approval UX is open; decisions must be durable runtime records, not private UI state. Authz is especially important. |
| Resume or abort a run intentionally. | Run Console | Use runner-supported controls when available; otherwise inspect state and restart or stop external processes manually according to operational practice. | Expose safe resume, abort/cancel, retry, or other controls only when the runner/control-plane contract supports them, and record resulting events/state changes. | Exact control-plane semantics are open. Runtime controls must not mutate workflow definitions or repin workflow content. |

## Cross-cutting open questions

- What control-plane API shape should create, observe, approve, resume, retry, cancel, or abort runs?
- What authentication and authorization model should protect authoring changes, runtime controls, artifact access, and approval decisions?
- How should Run Console choose and display immutable workflow versions, such as content hashes or Git commits?
- What approval context is sufficient for a human decision while keeping decisions durable and auditable?
- How can agentic authoring assistance remain useful while preserving explicit file diffs and linter-backed validation?
- How should future node package discovery or repositories work without weakening the local node package contract?
