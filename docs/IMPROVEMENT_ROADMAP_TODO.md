# Tesseraft Web UI Roadmap TODO — v3.2 Alignment

Sources:

- `~/Downloads/tesseraft-web-ui-ux-design-v3.md`
- `~/Downloads/tesseraft-web-ui-ux-design-v3.1.md`
- `~/Downloads/tesseraft-web-ui-ux-design-v3.2.md`
- In-repo canon: `docs/WEB_UI.md`, `docs/WEB_UI_USE_CASES.md`,
  `docs/WEB_UI_ARCHITECTURE.md`, `docs/CONTROL_PLANE_API.md`

Decomposition date: 2026-07-08.

This document supersedes the v2 infrastructure-heavy roadmap for Web UI work.
The v3.x design shifts phase 1 to **one technical developer automating their
own daily corporate work**. The Web UI is not a replacement for the terminal;
it is the companion for what terminals do poorly: graph comprehension, rich
artifacts, diffs, notifications, and fast workflow composition.

## Current state snapshot

Reconfirmed from repo files during this rewrite:

- **CI exists** and runs `bb test`, `npm run web:test`, container checks, and
  node lint wiring in `.github/workflows/ci.yml`.
- **Container install exists** (`Dockerfile`, `scripts/install.sh`,
  `test/container`).
- **Web UI implementation exists** under `web/`: React app, local HTTP API,
  Workflow Studio, Run Console, run streaming, settings/git-user/Pi sessions,
  and web tests.
- **Local package discovery exists** for examples, global `~/.tesseraft`, and
  project `.tesseraft` workflows; project-local names override global/example
  names. README documents the same convention for node packages.
- **Node import/export exists** through `bb node` / `tesseraft node` commands.
- **Manual testing harness exists** in `manual-testing/`.
- **Mock executor landed**: PR #8 merged; runner-level mock/dry-run mode
  (`--executor mock`), executor-mode persistence in run state, deterministic
  placeholder artifacts, and mock handlers for Jira/Git/GitHub/Pinga are on main
  (see `src/tesseraft/runtime/core.clj`, `src/tesseraft/executors/mock.clj`,
  `scripts/test.sh` mock dry-run). Remaining work: one-key mock-run UI (P2.2),
  golden UI mock fixtures (P4.1), and re-run delta / downstream diff (P4.2).
- **Approval/manual-input landed**: PR #44 merged; runtime approval/manual-input
  node, approval request/decision records, `approval.requested`/`approval.decided`
  events, and artifact comments are now on main (see `src/tesseraft/runtime/core.clj`,
  `web/src/components/ApprovalPanel.tsx`). Remaining work: the self-checkpoint UX
  surface (P3.1) and needs-you strip + decide affordances (P3.2).

Treat PR state as stale unless rechecked immediately before acting.

## Product principles for every item

1. **Workflow files, normalized data, linter results, run state, event logs,
   artifacts, approvals, and node packages remain the durable contracts.** UI
   state may cache or draft; it must not become authoritative.
2. **Workflow Studio and Run Console stay separate.** Studio authors future
   workflow package files; Run Console starts/observes/controls pinned runs.
3. **Reuse is the product.** Phase 1 succeeds when a developer assembles a
   personalized ticket-to-PR flow from catalog nodes/fragments in under an hour.
4. **The catalog is a lens, not a registry.** Render existing discovery,
   scopes, overrides, schemas, and import/export semantics before inventing a
   hosted repository.
5. **Mock mode is the Studio REPL.** One-key mock-run and clear mock badges are
   central now that #8 has landed (runtime mock mode is implemented; the
   remaining work is the UI surface, P2.2).
6. **Gates are self-checkpoints in phase 1.** Approval UX routes to the same
   developer, is low-ceremony, diff-centric, and records durable decisions.
7. **Local-first control plane.** Build on the existing file-backed local HTTP
   API; keep hosted/multi-user/DB-backed architecture deferred.

## How to use this document

Each item is sized as a review-loop or prompt-to-pr task. Before starting an
item, re-check current repo state and open PR state.

Governance note: tasks that edit committed workflow definitions or example
workflow packages (`examples/**/workflow.edn`, `.tesseraft/workflows/**`) must
respect the authoring/runtime boundary. Runtime agent runs must not silently
mutate workflow behavior; workflow edits must be explicit file changes reviewed
through normal PR review.

## Dependency graph summary

```
P0.0 docs/current-state reconciliation ─┬─> P1 catalog/reuse docs and UI
                                        ├─> P2 Studio inner-loop refinements
                                        └─> P3 Run Console / gates refinements

P0.1 mock executor (#8) ──────────────✅──┬─> P2.2 one-key mock-run
                                          ├─> P4.1 golden UI mock fixtures
                                          └─> P4.2 re-run delta / downstream diff

P0.2 approval schema feedback (#44) ──✅──┬─> P3.1 self-checkpoint screen
P0.3 approval runtime merge (#44) ────✅──┴─> P3.2 needs-you strip + decide

P1.1 shadowing metadata ────────────────┬─> P1.2 catalog cards
                                        └─> P1.3 linter diagnostics

P1.4 fragment package contract ─────────┬─> P1.5 fragment gallery
                                        └─> P4.3 extract-fragment refactor
```

---

## P0 — Reconcile canon and unblock semantic dependencies

### P0.0 Reconcile Web UI docs with v3.2 and current implementation — ✅ DONE (docs reconciled; #8/#44 runtime landing reflected via PR #62/#63)

- **Workflow:** prompt-to-pr
- **Depends on:** —
- **Parallelizable with:** P0.1, P0.2
- **Side effects:** docs only
- **Prompt:**
  > Update `docs/WEB_UI.md`, `docs/WEB_UI_USE_CASES.md`,
  > `docs/WEB_UI_ARCHITECTURE.md`, and `docs/CONTROL_PLANE_API.md` to reflect
  > the current implemented Web UI rather than describing every surface as
  > future work. Preserve their source-of-truth rules and Studio/Run Console
  > separation. Add a short v3.2 alignment section: phase-1 user is one
  > developer, composition/reuse is the adoption gate, catalog is a lens over
  > existing discovery, mock mode is the Studio REPL (runtime landed via #8; UI
  > surface P2.2 is remaining), and approval
  > UX (runtime landed via #44) is a self-checkpoint surfaced in the Run
  > Console (P3.1). Where implementation has outrun the
  > docs (SSE, start/step/resume/delete, Studio writes, settings/Pi sessions),
  > document the implemented contract and remaining gaps.

### P0.1 Rebase/merge the runner-level mock executor (#8) — ✅ DONE (PR #8 merged)

- **Workflow:** review-loop
- **Depends on:** CI green
- **Parallelizable with:** P0.0, P0.2, P1.1
- **Side effects:** runtime/executor semantics; no external service mutations
- **Status:** ✅ Done — PR #8 (`agent/add-dry-run-mode`) merged to main
  (merge commit 6cb3858). Runner-level mock/dry-run mode, executor-mode
  persistence in run state, deterministic placeholder artifact generation,
  and mock handlers for external integrations are preserved and exercised by
  `scripts/test.sh` (mock dry-run of the review-loop workflow).
- **Prompt:**
  > Re-check PR #8 and either rebase/merge it or write down the design
  > reservation blocking it. Preserve runner-level mock/dry-run mode,
  > executor-mode persistence in run state, deterministic placeholder artifact
  > generation, and mock handlers for external integrations. Add tests proving
  > every example workflow can execute in mock mode without credentials or
  > external services. The Web UI depends on this for one-key mock-run, launch
  > form rehearsal, mock-mode badges, and future golden event-log fixtures.

### P0.2 Shape the approval presentation contract before #44 merges — ✅ DONE (PR #44 merged)

- **Workflow:** prompt-to-pr / PR review feedback
- **Depends on:** open #44 state (now satisfied — PR #44 merged)
- **Parallelizable with:** P0.0, P0.1
- **Side effects:** schema/API feedback only unless #44 is edited
- **Status:** ✅ Done — PR #44 (`feature/manual-input-node`) merged to main
  (merge commit 7952d5b). Approval request/decision records and
  `approval.requested`/`approval.decided` events are durable runtime records;
  artifact comments implemented as run-relative files.
- **Prompt:**
  > Review PR #44 and propose the phase-1/phase-2-ready approval presentation
  > contract before merge: authored question, curated artifact list with render
  > hints, decision schema keyed by outgoing transition, consequences text per
  > option, and routing field defaulting to self. Require approval requests and
  > decisions to be durable runtime records with `approval.requested` and
  > `approval.decided` events. Do not build multi-user reviewer routing yet.

### P0.3 Merge approval/manual-input runtime support (#44) after schema review — ✅ DONE

- **Workflow:** review-loop
- **Depends on:** P0.2, CI green
- **Parallelizable with:** P1 catalog work; not with Run Console approval UI
- **Side effects:** runtime + control-plane + web write surface
- **Status:** ✅ Done — PR #44 merged to main. Blocked run state, approval
  request/decision records, comment/annotation artifacts, replay-safe decision
  semantics, and path-safe artifact/comment handling are preserved. Tests for
  duplicate-decision 409s, path traversal rejection, and event-log evidence
  are retained (`test/web-server.test.js`, `scripts/test.sh`).
- **Prompt:**
  > Rebase and merge #44 after P0.2 feedback is resolved. Preserve blocked run
  > state, approval request/decision records, comment/annotation artifacts,
  > replay-safe decision semantics, and path-safe artifact/comment handling.
  > Keep workflow-definition edits out of this runtime PR unless explicitly
  > human-authored and reviewed. Add/retain tests for duplicate decision 409s,
  > path traversal rejection, and event-log evidence.

### P0.4 CI/manual-testing coverage audit for Web UI surfaces

- **Workflow:** review-loop
- **Depends on:** P0.0
- **Parallelizable with:** P1.1, P1.4
- **Side effects:** tests/docs only
- **Prompt:**
  > Audit Web UI test coverage against the reconciled docs. Ensure `npm run
  > web:test` covers the implemented local HTTP API, Studio save/lint behavior,
  > path confinement, run streaming, start/step/resume/delete controls, settings,
  > git-user, and Pi sessions. Extend `manual-testing/spec.md` or split it into
  > focused scripts for every surface that lacks automated browser coverage.
  > Manual specs must be copy-paste runnable and must state the ground truth
  > command/file to compare against.

---

## P1 — Composition and reuse: make the package system visible

### P1.1 Expose scope and shadowing metadata in workflow discovery

- **Workflow:** review-loop
- **Depends on:** P0.0
- **Parallelizable with:** P0.1, P0.2, P1.4
- **Side effects:** control-plane/API + tests
- **Prompt:**
  > Extend workflow discovery/control-plane responses to expose scope metadata
  > for examples, global `~/.tesseraft`, and project `.tesseraft` packages.
  > Include enough duplicate/shadowing metadata for the UI to show when a
  > project workflow overrides a global or example workflow. Do not change
  > precedence semantics; make them inspectable. Add tests for example/global/
  > project ordering, same-name conflicts at equal precedence, and project
  > override visibility.

### P1.2 Build the catalog-as-lens UI

- **Workflow:** review-loop
- **Depends on:** P1.1
- **Parallelizable with:** P1.4, P2.1
- **Side effects:** Web UI only
- **Prompt:**
  > Add a Catalog surface to Workflow Studio that renders discovered workflows
  > and node packages as cards. Each card must show scope (example/global/project),
  > path, one-line purpose when available, lint status, and override/shadowing
  > status. For example/global packages, editing must be presented as "copy to
  > project" rather than mutating the source. For shadowed packages, provide a
  > "view diff / inspect both" affordance. Preserve files-as-truth: every action
  > maps to explicit file changes or existing CLI import/export commands.

### P1.3 Add linter info diagnostics for cross-scope shadowing

- **Workflow:** review-loop
- **Depends on:** P1.1
- **Parallelizable with:** P1.2 after API shape settles
- **Side effects:** linter/control-plane diagnostics
- **Prompt:**
  > Add a low-severity linter/control-plane diagnostic when a workflow or node
  > package name is shadowed across discovery scopes. The diagnostic should not
  > fail valid workflows; it should explain which package wins and where the
  > shadowed package lives. Surface the same diagnostic in CLI JSON and Web UI
  > catalog/detail views so terminal and UI tell the same story.

### P1.4 Define first-class fragment packages in the same scope system — ✅ DONE (spec/linter/docs + fixture + `bb fragment lint|import`; boundary inclusion lints without duplicating internal proof)

- **Workflow:** design-doc-first review-loop
- **Depends on:** P0.0
- **Parallelizable with:** P1.1, P2.1
- **Side effects:** spec/linter/docs; defer broad example rewrites unless approved
- **Prompt:**
  > Design and implement a minimal fragment package contract for reusable
  > subgraphs with declared boundary inputs, outputs, outcomes, parameters, and
  > resource consumption/production. Fragments must use the same scope model as
  > workflows and nodes (`.tesseraft/fragments/<name>/`,
  > `~/.tesseraft/fragments/<name>/`, examples), and inclusion must lint the
  > boundary contract without duplicating internal proof obligations. Start with
  > docs and linter support plus one small fixture fragment; do not mass-edit
  > examples until the contract is reviewed.

### P1.5 Seed a fragment gallery from examples

- **Workflow:** human-approved authoring session + review-loop validation
- **Depends on:** P1.4
- **Parallelizable with:** P2.2
- **Governance note:** edits example/package definitions; keep changes explicit
- **Prompt:**
  > Decompose the existing example workflows into a small starter fragment
  > gallery: env setup, test-fix loop, worktree-to-PR, PR review round-trip, and
  > housekeeping. Keep original examples runnable. Add catalog cards and docs for
  > each fragment, including parameters such as repo root, test command, base
  > branch, reviewers, and retry budget. Add lint tests proving fragment
  > boundary contracts catch missing resources and invalid exposed outcomes.

### P1.6 Add connections doctor for first-run setup

- **Workflow:** review-loop
- **Depends on:** P0.0
- **Parallelizable with:** P1.2, P2.1
- **Side effects:** Web UI + safe no-op handler checks
- **Prompt:**
  > Add a local-first Connections Doctor in Settings/Studio for GitHub, Jira,
  > Pinga, Pi, git user, and repo root. Each check must use the existing runtime
  > secrets/config model and perform either a no-op real handler verification or
  > a clearly labeled static configuration check. Do not print or persist secret
  > values in UI state, logs, screenshots, or artifacts. Add manual-testing steps
  > and unit tests with fake adapters.

---

## P2 — Studio inner loop: edit → lint → mock-run → run

### P2.1 Continuous lint in context

- **Workflow:** review-loop
- **Depends on:** P0.0
- **Parallelizable with:** P1.1, P1.4
- **Side effects:** Web UI + linter integration
- **Prompt:**
  > Improve Workflow Studio so linter diagnostics appear continuously and in
  > context on the graph, node editor, asset references, and EDN/source view.
  > Missing required resources should render as visible unfilled ports or
  > equivalent graph affordances. The standalone linter remains authoritative;
  > the UI must not fork validation rules. Add tests for diagnostic mapping and
  > path confinement.

### P2.2 One-key mock-run from Studio

- **Workflow:** review-loop
- **Depends on:** P0.1
- **Parallelizable with:** P1.5
- **Side effects:** Web UI run creation; mock mode only by default
- **Prompt:**
  > Add a one-key "Mock run" action in Workflow Studio. It must lint first,
  > start the selected workflow in runner-level mock mode, persist/display mock
  > mode from run state, open the Run Console on the new run, and show a loud
  > mock badge everywhere artifacts/events are displayed. It must never require
  > Jira/GitHub/Pinga credentials or perform external effects. Add web tests and
  > a manual-testing script.

### P2.3 Resolved prompt preview

- **Workflow:** review-loop
- **Depends on:** P2.1
- **Parallelizable with:** P2.2
- **Side effects:** Web UI + template resolution endpoint if needed
- **Prompt:**
  > For every agent node in Studio, show the prompt after template resolution
  > against sample inputs, recent inputs, or a selected run's real inputs. The
  > preview must identify unresolved variables, source template path, and which
  > artifacts/resources supplied each value. Do not spend tokens or start agents
  > from preview. Add tests with prompt templates under package assets.

### P2.4 Schema-driven launch forms and recent inputs

- **Workflow:** review-loop
- **Depends on:** P0.0, P2.1
- **Parallelizable with:** P1.6
- **Side effects:** Web UI + local config/history
- **Prompt:**
  > Drive Run Console/Studio launch forms from workflow input schemas and node
  > package contracts. Prefer parameters over editing example graphs: Jira
  > project, repo root, test command, base branch, reviewers, retry budget.
  > Store recent inputs locally in a non-authoritative history file or browser
  > cache that never changes workflow behavior. Provide copy-as-CLI for every
  > launch form submission.

### P2.5 CLI ↔ UI deep links

- **Workflow:** review-loop
- **Depends on:** P0.0
- **Parallelizable with:** P2.1, P3.1
- **Side effects:** CLI + Web UI
- **Prompt:**
  > Make CLI and Web UI feel like one surface. CLI commands that create or touch
  > runs should print local console deep links when the server is available or
  > when `--open` is passed. Web UI views should offer copy-as-CLI for workflow
  > selection, run start, step/resume, artifact inspection, and lint. Keep all
  > links local-first and safe if the server is not running.

---

## P3 — Gates and Run Console for one developer's daily loop

### P3.1 Diff-centric self-checkpoint decision screen

- **Workflow:** review-loop
- **Depends on:** P0.3
- **Parallelizable with:** P2.3
- **Side effects:** Web UI + approval control-plane route
- **Prompt:**
  > Build the phase-1 approval decision screen for a developer approving their
  > own automation. It should show the authored question, curated artifacts,
  > diff-centric rendering where available, allowed decisions, consequences text
  > per option, and one-key decide. The decision must be submitted through the
  > control plane and recorded as durable runtime evidence, never browser-only
  > state. Add tests for accepted decisions, invalid decisions, replay 409s, and
  > artifact path safety.

### P3.2 Needs-you strip and notification deep links

- **Workflow:** review-loop
- **Depends on:** P0.3, P3.1
- **Parallelizable with:** P3.3
- **Side effects:** Web UI + optional Pinga notification wiring
- **Prompt:**
  > Add a "needs you" strip for blocked runs assigned to the local developer.
  > Blocked runs should be visually distinct from declared failures and runtime
  > errors. Add Pinga/desktop notification deep links where configured, but keep
  > notification failures non-fatal and inspectable. The common path should be a
  > ten-second decision; detailed evidence remains one click away.

### P3.3 My-runs console refinement

- **Workflow:** review-loop
- **Depends on:** P0.0
- **Parallelizable with:** P3.1
- **Side effects:** Web UI only
- **Prompt:**
  > Refine Run Console around "my runs": running, parked, blocked-on-me,
  > stale/orphaned, failed, and recent. Preserve the existing liveness/staleness
  > fixes. Use one saturated accent for blocked/needs-you, amber for declared
  > fail transitions, and broken outline/error treatment for runtime failures
  > outside the workflow logic. Keep raw event/state/artifact access available.

### P3.4 Paired-event timeline and artifact validation drill-down

- **Workflow:** review-loop
- **Depends on:** P3.3
- **Parallelizable with:** P2.5
- **Side effects:** Web UI only
- **Prompt:**
  > Improve run inspection with a paired-event timeline: started/finished spans,
  > unclosed spans with resume/orphan affordances, transition choices, artifact
  > writes, approval events, and agent events. For node attempts, show per-schema
  > artifact validation status and clear links to raw files. Keep the proof trace
  > reconstructable from event logs, attempts, artifacts, and run state.

---

## P4 — Library growth and debugging polish

### P4.1 Golden event-log fixtures for UI-visible behavior

- **Workflow:** review-loop
- **Depends on:** P0.1, P2.2
- **Parallelizable with:** P3.3
- **Side effects:** tests/fixtures only
- **Prompt:**
  > Capture golden mock-mode event logs for representative workflows and UI
  > states: successful run, declared fail transition, runtime error, blocked
  > approval, stale/orphaned liveness if representable. Normalize timestamps and
  > ids. Web UI tests should use these fixtures to prove graph states, badges,
  > timelines, artifacts, and mock labels do not regress.

### P4.2 Re-run with delta and downstream diff

- **Workflow:** review-loop
- **Depends on:** P0.1, P2.2, P2.3
- **Parallelizable with:** P4.3
- **Side effects:** Web UI + run metadata
- **Prompt:**
  > Add "re-run last run with my edited prompt/node" from Studio/Run Console.
  > The new run must pin the edited workflow version and preserve input history.
  > Show a downstream diff between old and new runs: changed prompt, changed
  > node output, changed transition, changed artifact. Start with mock mode;
  > real reruns can follow once safety is clear.

### P4.3 Extract-fragment refactor

- **Workflow:** review-loop with human approval for package edits
- **Depends on:** P1.4
- **Parallelizable with:** P4.2
- **Side effects:** Workflow Studio package authoring
- **Prompt:**
  > In Workflow Studio, allow selecting a connected subgraph and extracting it
  > as a fragment package. Infer the boundary contract from cut edges and
  > resources, show the inferred inputs/outputs/outcomes for confirmation, and
  > write explicit package files only after lint passes. Add tests for contract
  > inference and rollback on lint failure.

### P4.4 Budget and cost readouts

- **Workflow:** review-loop
- **Depends on:** P3.3
- **Parallelizable with:** P4.2
- **Side effects:** Web UI only unless runtime accounting is missing
- **Prompt:**
  > Add per-run budget/cost/time readouts where runtime evidence exists. Do not
  > invent authoritative accounting in browser state. If token/cost data is
  > unavailable, show elapsed time and node attempt counts, and document the
  > runtime evidence needed for richer accounting later.

### P4.5 Personal-library polish

- **Workflow:** prompt-to-pr / review-loop depending on scope
- **Depends on:** P1.2
- **Parallelizable with:** P4.4
- **Side effects:** UI/docs; no hosted sync
- **Prompt:**
  > Polish the global `~/.tesseraft` library story as "yours, everywhere".
  > Make save-to-global and add-to-project affordances clear, reviewable, and
  > reversible. Do not build hosted sync or a public registry. Document how a
  > developer carries personal nodes/fragments/workflows across corporate repos
  > while preserving project-local overrides.

---

## Parked for phase 2+

Do not build these until phase-1 adoption is proven by real non-mock runs:

- reviewer register and per-person inboxes;
- multi-user identity/routing beyond local self-checkpoints;
- org/fleet dashboards and team budget views;
- compliance-grade run comparison as evidence;
- hosted public node/fragment registry;
- DB-backed or hosted control plane, except behind the local API contract once
  file-backed limits are measured.

## Success criteria

1. A developer with the container and tokens can assemble a personalized
   ticket-to-PR workflow from catalog nodes/fragments, without authoring a new
   node, and mock-run it green in under one hour.
2. Inner loop latency: edit → lint verdict under 1s; edit → mock-run started
   under 5s from Studio.
3. At least 70% of nodes in user-authored workflows come from catalog
   nodes/fragments rather than bespoke definitions.
4. Every cross-scope name shadowing is visible in both catalog and CLI/linter
   diagnostics; no developer unknowingly runs a shadowed workflow.
5. A gated real run can be answered from a notification/deep link in under 30s,
   with durable `approval.decided` evidence.
6. North star: real non-mock runs per week per developer increases after the
   catalog + mock-run + self-checkpoint loop ships.
