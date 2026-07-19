# Fragment implementation prompts

Status: Planned

Delivery workflow: [`canon-tdd-to-pr`](CANON_TDD_WORKFLOW.md)

Current contract/state: [`FRAGMENTS.md`](FRAGMENTS.md)

This document decomposes executable fragments into focused, dependency-ordered increments. Submit one prompt at a time to `examples/canon-tdd-to-pr/workflow.edn`. Merge each accepted PR before starting a dependent prompt so later test lists are based on the actual preceding contract.

Every increment must preserve these constraints:

- workflow and fragment package files remain the source of truth;
- default tests remain local-only and require no Pi, GitHub, Jira, or credentials;
- the linter remains side-effect free;
- runtime failures remain durable and inspectable;
- existing non-fragment workflows remain behaviorally unchanged;
- update `STATUS.edn` and regenerate README status when capability truth changes;
- update `FRAGMENTS.md` when an implemented limitation changes.

Do not submit “implement fragments” as one run.

## Dependency graph

```text
FI1 Contract invariants
 └── FI2 EDN/JSON normalization
      └── FI3 Inclusion bindings, version, scope, prefix
           ├── FI4 Boundary resource projection
           └── FI5 Complete transactional import
                └──────────────┐
FI4 ───────────────────────────┤
                               v
                    FI6 Deterministic runtime
                               |
                    FI7 Ordinary nodes, artifacts, loops, mock
                               |
                    FI8 Resume, recovery, cancellation, events
                               |
                    FI9 Approval inside fragments
                               |
                    FI10 Public discovery and inspection API
                       ┌───────┴────────┐
                       v                v
              FI11 Runnable gallery  FI12 Studio composition
                       └───────┬────────┘
                               v
                    FI13 Extract/export fragment
```

FI4 and FI5 may be developed in parallel after FI3. All runtime work starts after FI1–FI5 are merged.

## Running a prompt

Start from a clean base branch containing all listed dependencies:

```bash
./bin/tesseraft run start examples/canon-tdd-to-pr/workflow.edn \
  --run-id <id> \
  --input repo-root=. \
  --input base-branch=main \
  --input prompt='<paste one prompt below>' \
  --format json
```

Use bounded `step`/`resume` if you want to review the generated use case before allowing the workflow to continue to test-list and worktree preparation.

---

## FI1 — Enforce fragment outcome and terminal invariants

**Depends on:** P1.4 current baseline

**Suggested branch:** `fix/fragment-contract-invariants`

### Outcome

A fragment package cannot pass lint unless it declares a complete, unambiguous outcome/exit contract tied to reachable internal terminal states.

### Required scope

- Require a non-empty `:interface :outcomes` collection and non-empty `:fragment :exit` collection.
- Define one explicit terminal-to-outcome representation. Prefer `:outcome <keyword>` on internal terminal nodes while retaining workflow-style terminal `:status`; choose a different representation only with stronger repository evidence and document it.
- Require every reachable internal terminal to select exactly one declared outcome.
- Require every declared outcome to have at least one reachable terminal and exactly one exit contract.
- Reject duplicate exits, undeclared terminal outcomes, and missing terminal outcomes.
- Reject nested `:fragment` internal nodes for v1 until nesting semantics exist.
- Update the fixture, schema, linter diagnostics, `FRAGMENTS.md`, and focused invalid fixtures.

### Acceptance criteria

- Removing outcomes or exits fails normal and strict lint.
- Duplicate/unknown/unreachable outcome mappings fail with focused diagnostics.
- The valid fixture passes strict lint.
- Existing workflow and node package lint behavior is unchanged.
- Tests demonstrate red for each contract defect before implementation.

### Non-goals

No JSON normalization, version/prefix behavior, resource projection, import UX, runtime execution, gallery, or UI.

### Canon TDD prompt

```text
Implement FI1 from docs/FRAGMENT_IMPLEMENTATION_PROMPTS.md. Harden the
fragment package contract so outcomes, exits, and reachable internal terminal
states form one complete unambiguous mapping, and reject nested fragments for
v1. Add focused failing fixtures one behavioral case at a time, then update the
valid fixture, schema, diagnostics, and FRAGMENTS.md. Preserve all non-fragment
workflow behavior. Do not add JSON normalization, inclusion version/prefix
semantics, resource projection, runtime execution, import UX, gallery, or UI.
Validate focused fragment lint tests and bb test.
```

---

## FI2 — Make EDN and JSON fragment packages equivalent

**Depends on:** FI1

**Suggested branch:** `fix/fragment-json-normalization`

### Outcome

Semantically equivalent EDN and JSON fragment packages normalize to the same internal contract and produce equivalent lint results.

### Required scope

- Add one explicit fragment-package normalization boundary after parsing.
- Normalize kind, ids, node types, handlers, executors, effects, outcomes, exit outcomes, and transition targets consistently.
- Accept JSON arrays for outcomes while preserving a JSON-compatible normalized representation.
- Align `schemas/fragment-package.schema.json` with required FI1 fields and actual accepted values.
- Add paired EDN/JSON valid and invalid fixtures proving diagnostic parity.
- Decide and document whether JSON Schema is descriptive or actively enforced; do not imply enforcement that does not occur.

### Acceptance criteria

- A JSON rendering of the valid EDN fixture passes strict fragment lint.
- Paired malformed EDN/JSON fixtures report the same diagnostic codes.
- Normalized data can be serialized to JSON without EDN-only sets or keywords.
- Existing EDN packages remain compatible.

### Non-goals

No general rewrite of workflow/node normalization, runtime execution, bindings, resources, import UI, or gallery unless a tiny shared helper is required and covered.

### Canon TDD prompt

```text
Implement FI2 from docs/FRAGMENT_IMPLEMENTATION_PROMPTS.md. Add a single
fragment-package normalization boundary so equivalent EDN and JSON packages
lint identically and normalized fragment data is JSON-compatible. Align the
fragment JSON Schema with the FI1 required contract and add paired EDN/JSON
fixtures proving valid and invalid parity. Preserve existing EDN behavior. Do
not broaden this into runtime execution, inclusion bindings/resources, import
UX, gallery, or a wholesale workflow parser rewrite. Validate strict fragment
lint, focused parity tests, and bb test.
```

---

## FI3 — Enforce inclusion bindings, version, scope, and prefix

**Depends on:** FI2

**Suggested branch:** `feature/fragment-inclusion-contract`

### Outcome

A fragment inclusion resolves one intended package and statically validates its complete input/parameter namespace and safe artifact prefix.

### Required scope

- Validate missing and unknown `:inputs` and `:parameters`.
- Apply parameter defaults and require parameters without defaults when marked required.
- Validate simple declared scalar types using the same conventions as workflow inputs where available.
- Make `:version` an exact metadata-version constraint when present; report not-found/version-mismatch distinctly.
- Make keyword/string scope values normalize consistently and prevent a requested scope from silently falling back to another scope.
- Define `:prefix` as a safe relative directory prefix; reject absolute paths and `..`.
- Expose resolved package path, scope, version, and effective parameter values in normalized/linter data without adding hidden workflow behavior.
- Add project/global/example precedence and mismatch fixtures.

### Acceptance criteria

- Missing required and unknown bindings fail with specific paths.
- Defaults satisfy omitted optional parameters.
- Wrong version and wrong explicit scope fail instead of falling back.
- Unsafe prefixes fail lint.
- Omitting optional version/scope/prefix preserves documented default discovery.

### Non-goals

No boundary resource projection, runtime execution, artifact copying under the prefix, public API, or UI.

### Canon TDD prompt

```text
Implement FI3 from docs/FRAGMENT_IMPLEMENTATION_PROMPTS.md. Make fragment
inclusion resolution and bindings explicit: validate input/parameter names,
required values, defaults, and supported scalar types; enforce exact optional
version pins and explicit scope without fallback; and validate a safe relative
prefix. Add focused scope/version/binding/prefix fixtures and document the
normalized effective contract. Do not add resource projection, runtime
execution, prefixed artifact writes, public API, gallery, or UI. Validate
focused inclusion lint tests and bb test.
```

---

## FI4 — Project fragment boundary resources into workflow lint

**Depends on:** FI3

**Suggested branch:** `feature/fragment-boundary-resources`

### Outcome

Workflow resource analysis treats a fragment inclusion as the declared boundary transformation rather than an empty node.

### Required scope

- Derive effective inclusion `requires`, `consumes`, and `produces` from the resolved package boundary contract.
- Apply validated inclusion bindings and prefixing when determining resource identities and paths.
- Keep internal-only resources hidden from the importer.
- Require required package inputs/capabilities on all incoming paths.
- Make exposed outputs available only after the fragment and on every outcome whose exit declares them.
- Handle outcome-dependent optional outputs conservatively; do not claim availability on paths where they are absent.
- Avoid mutating the authored workflow map merely to make lint pass; effective resources should be inspectable derived data.

### Acceptance criteria

- A downstream consumer of a required all-exit fragment output passes resource lint.
- A missing incoming boundary requirement fails.
- An output absent on one possible exit does not become unconditionally available.
- Prefixing prevents collisions between two inclusions of the same package.
- Existing non-fragment resource-flow tests remain unchanged.

### Non-goals

No runtime artifact production, import flags, event model, UI ports, or gallery.

### Canon TDD prompt

```text
Implement FI4 from docs/FRAGMENT_IMPLEMENTATION_PROMPTS.md. Project a
resolved fragment package's boundary requires/consumes/produces into workflow
resource analysis, applying bindings and prefix paths while keeping internal
resources private. Prove all-exit outputs become available, outcome-optional
outputs remain conservative, missing incoming resources fail, and two prefixed
inclusions do not collide. Keep this derived and inspectable; do not mutate the
authored workflow or add runtime execution, import UX, UI, or gallery. Validate
focused resource-flow fixtures and bb test.
```

---

## FI5 — Make fragment import complete and transactional

**Depends on:** FI3; compatible with FI4

**Suggested branch:** `feature/fragment-import-contract`

### Outcome

The CLI either writes a complete lint-passing inclusion requested by the user or leaves the workflow and assets unchanged.

### Required scope

- Add explicit repeatable import arguments for input bindings, parameters, outcome targets, optional version/scope/prefix, and fallback `--next` only when contractually valid.
- Validate all target states and the complete inclusion before writing.
- Stage asset copies and workflow edits so any collision or lint failure rolls back without partial files.
- Refuse to silently ignore missing bindings or uncovered outcomes.
- Print the resulting state id and a concise summary of bindings/outcome routes.
- Keep authored integration fields explicit in `workflow.edn`.

### Acceptance criteria

- A complete command imports `test-fix-loop` into a temporary workflow that passes strict lint.
- Missing required flags fail without changing workflow or assets.
- Asset collision and invalid target tests prove rollback.
- Existing state ids and differing files are never overwritten.

### Non-goals

No interactive prompts, runtime execution, Studio import UI, package export, or broad CLI framework rewrite.

### Canon TDD prompt

```text
Implement FI5 from docs/FRAGMENT_IMPLEMENTATION_PROMPTS.md. Make `tesseraft
fragment import` transactional and capable of writing a complete explicit
lint-passing inclusion using repeatable binding, parameter, outcome-target,
version/scope/prefix arguments. On missing data, invalid targets, lint failure,
or asset collision, leave workflow and assets byte-for-byte unchanged. Do not
add interactivity, runtime execution, Studio UI, export, or broad CLI rewrites.
Validate focused import success/rollback tests, strict lint, and bb test.
```

---

## FI6 — Execute deterministic fragments end to end

**Depends on:** FI1–FI5

**Suggested branch:** `feature/fragment-deterministic-runtime`

### Outcome

A workflow can execute a fragment containing deterministic/router/terminal nodes and route on its declared outcome with durable evidence.

### Required scope

- Resolve and pin fragment package identity/content with the parent run.
- Bind validated inputs and effective parameters into an isolated internal context.
- Execute deterministic and router nodes using existing handlers and transition semantics.
- Stop at a mapped internal terminal outcome and route the parent inclusion through `:fragment/outcome`.
- Persist enough namespaced internal state and events to inspect which internal nodes ran.
- Enforce fragment-local max rounds.
- Fail before partial execution with a clear structured error when an unsupported internal node type is reachable.
- Add a local-only success and declared-failure runtime fixture.

### Acceptance criteria

- A deterministic fragment reaches both success and failure parent routes in tests.
- Parent run state, events, attempts, and package pin survive process reload.
- Missing package/version/binding fails before an internal side effect.
- Existing workflows execute unchanged.
- The old `No matching clause: :fragment` failure is eliminated.

### Non-goals

No agent/process/timer/approval internal nodes, exposed artifact copying, nested fragments, UI, or gallery.

### Canon TDD prompt

```text
Implement FI6 from docs/FRAGMENT_IMPLEMENTATION_PROMPTS.md. Add the smallest
end-to-end fragment runtime for deterministic/router/terminal internal graphs:
pin the package, bind inputs/parameters, execute namespaced internal states,
map a terminal outcome to the parent transition, enforce local rounds, and
persist inspectable events/state. Add local success and declared-failure
fixtures. Reject reachable unsupported internal node types clearly before
partial execution. Do not add agents, processes, timers, approvals, nested
fragments, UI, or gallery. Validate focused runtime tests and bb test.
```

---

## FI7 — Support ordinary nodes, artifacts, loops, and mock mode

**Depends on:** FI6

**Suggested branch:** `feature/fragment-runtime-nodes`

### Outcome

Non-approval fragment graphs use the same agent/process/timer execution, artifacts, bounded loops, and mock behavior as equivalent top-level workflow graphs.

### Required scope

- Support internal agent, process, timer, deterministic, router, and terminal nodes through existing executor/handler boundaries.
- Resolve internal prompt, script, and schema assets relative to the pinned package.
- Namespace internal artifacts under the inclusion prefix.
- Validate required outputs and expose exit outputs at their declared prefixed paths.
- Preserve fragment-local attempts/rounds without corrupting parent counters.
- Make runner-level mock mode deterministic and side-effect safe inside fragments.
- Add focused local process and mock-agent fixtures plus a bounded retry loop.

### Acceptance criteria

- Process and mock-agent fragment scenarios execute and route correctly.
- Missing required internal or exit artifacts fail durably.
- Two inclusions cannot overwrite one another's prefixed artifacts.
- A bounded internal loop terminates at its own limit.
- Default tests need no real Pi or credentials.

### Non-goals

No internal approvals, nested fragments, public API/UI, real external integrations, or gallery decomposition.

### Canon TDD prompt

```text
Implement FI7 from docs/FRAGMENT_IMPLEMENTATION_PROMPTS.md. Extend the FI6
runtime so agent/process/timer/deterministic/router/terminal fragment graphs use
existing execution boundaries, package-relative assets, prefixed internal and
exit artifacts, local attempts/rounds, required-output validation, and safe
runner mock mode. Add one local process case, one mock-agent case, one artifact
failure, and one bounded loop incrementally. Do not add approvals, nested
fragments, public API/UI, external credentials, or gallery work. Validate
focused runtime/mock tests and bb test.
```

---

## FI8 — Make fragment execution resumable and observable

**Depends on:** FI7

**Suggested branch:** `feature/fragment-runtime-recovery`

### Outcome

A non-approval fragment interrupted between internal nodes resumes exactly once and exposes a reconstructable nested proof trace.

### Required scope

- Persist parent inclusion attempt plus current internal state/attempt/round.
- Emit namespaced internal node started/finished/failed and transition events while retaining the parent boundary span.
- Resume from the last durable internal boundary without replaying completed effects.
- Apply cancellation, process-tree cleanup, timeout, orphan detection, and completed-agent recovery inside the fragment.
- Make inspection APIs derive nested attempts without hiding raw events/artifacts.
- Add kill/reload/cancel fixtures using local deterministic or process nodes.

### Acceptance criteria

- Forced interruption after one internal node resumes at the next node.
- No duplicated completed handler/process effect occurs.
- Cancellation and timeout terminate owned internal processes and the parent run consistently.
- Orphaned internal work produces explicit durable evidence.
- Existing top-level recovery tests remain green.

### Non-goals

No approval nodes, nested fragments, UI redesign, external services, or gallery.

### Canon TDD prompt

```text
Implement FI8 from docs/FRAGMENT_IMPLEMENTATION_PROMPTS.md. Make non-approval
fragment execution durable across interruption: persist namespaced internal
state, emit reconstructable nested events, resume without replaying completed
effects, and apply existing cancellation, timeout, cleanup, orphan, and agent
recovery semantics inside the boundary. Prove one forced-restart and one
cancellation case with local fixtures. Do not add approvals, nested fragments,
external services, UI redesign, or gallery work. Validate focused recovery
tests and bb test.
```

---

## FI9 — Support durable approval nodes inside fragments

**Depends on:** FI8

**Suggested branch:** `feature/fragment-runtime-approval`

### Outcome

An internal approval parks the parent run, exposes namespaced approval context, and resumes the exact fragment state after one valid decision.

### Required scope

- Reuse the existing durable approval request/decision contract.
- Namespace approval ids to the inclusion and internal state so multiple inclusions cannot collide.
- Render package-relative approval artifacts through the inclusion prefix.
- Make control-plane decide validate the parent run, inclusion attempt, and internal approval attempt.
- Resume inside the fragment, then continue to its eventual parent outcome.
- Preserve idempotent decision and stale-decision rejection.

### Acceptance criteria

- A local fragment run parks as blocked on an internal approval.
- Approve and reject decisions route through distinct internal paths and parent outcomes.
- Replayed/stale/wrong-inclusion decisions return structured conflicts.
- Restart while blocked preserves the pending request.

### Non-goals

No nested fragments, multi-user authorization, new approval UI, gallery, or hosted behavior.

### Canon TDD prompt

```text
Implement FI9 from docs/FRAGMENT_IMPLEMENTATION_PROMPTS.md. Support an approval
node inside a fragment by reusing the durable approval contract with namespaced
ids and prefixed artifacts. The parent run must park, survive restart, accept
one valid decision, resume the exact internal state, and eventually route the
fragment outcome; stale/replayed/wrong-inclusion decisions must conflict. Do
not add nested fragments, auth redesign, new approval UI, gallery, or hosted
behavior. Validate focused runtime/control-plane approval tests and bb test.
```

---

## FI10 — Expose public fragment discovery and inspection

**Depends on:** FI9

**Suggested branch:** `feature/fragment-control-plane-api`

### Outcome

CLI and local control-plane clients can list and inspect resolved fragment packages, contracts, lint state, scope, precedence, and shadowing without executing them.

### Required scope

- Promote existing discovery helpers into public list/detail/graph control-plane commands and HTTP routes.
- Return normalized metadata, interface, requirements, assets, internal graph, lint summary, scope, precedence, and shadowing/conflict information.
- Never return raw secrets or read unsafe asset paths.
- Keep package files and linter output authoritative.
- Add project/global/example precedence, conflict, malformed package, and path-confinement tests.

### Acceptance criteria

- List and detail show the visible package and shadowed candidates deterministically.
- Graph reflects package states and boundary ports from normalized/linter data.
- Equal-precedence conflicts and malformed packages are inspectable, not silently dropped.
- APIs remain read-only and local-testable.

### Non-goals

No Studio composition UI, package mutation, registry, gallery expansion, or export.

### Canon TDD prompt

```text
Implement FI10 from docs/FRAGMENT_IMPLEMENTATION_PROMPTS.md. Expose read-only
fragment list/detail/graph surfaces through the control-plane CLI and local HTTP
API using existing discovery and linter authority. Include normalized boundary,
internal graph, scope/precedence/shadowing, conflicts, and lint summaries; keep
secrets and unsafe assets out. Add project/global/example and malformed/conflict
fixtures. Do not add Studio mutation/composition, registry, gallery expansion,
or export. Validate focused control-plane/server tests and bb test.
```

---

## FI11 — Seed one genuinely runnable gallery fragment

**Depends on:** FI9; FI10 recommended

**Suggested branch:** `feature/fragment-gallery-test-fix`

### Outcome

The existing `test-fix-loop` becomes a meaningful, documented, local/mock-runnable fragment demonstrating the complete executable contract.

### Required scope

- Replace placeholder `:noop/succeed` lint/test behavior with explicit parameterized local process commands or a safe equivalent supported by the runtime.
- Make pass, test-failure→mock-fix→pass, and exhausted-failure outcomes demonstrable without real Pi.
- Use complete interface inputs/parameters/resources/outputs/version/prefix semantics.
- Add a small runnable parent workflow fixture and end-to-end mock tests.
- Document invocation, artifacts, outcomes, and cleanup.

### Acceptance criteria

- The parent fixture executes the fragment to each declared outcome deterministically.
- Boundary resources and artifacts agree with actual runtime evidence.
- Mock mode needs no credentials or external services.
- The original non-fragment examples remain runnable and unchanged.

### Non-goals

Do not decompose worktree-to-PR, review, or housekeeping in this PR. Do not add Studio UI or registry behavior.

### Canon TDD prompt

```text
Implement FI11 from docs/FRAGMENT_IMPLEMENTATION_PROMPTS.md. Turn the
`test-fix-loop` fixture into the first genuinely runnable gallery fragment with
parameterized local behavior, complete boundary resources/artifacts, and
deterministic pass, fix-then-pass, and exhausted-failure scenarios under safe
mock/local execution. Add one runnable parent workflow and end-to-end tests and
docs. Do not decompose other examples or add Studio/registry work. Validate
fragment strict lint, focused runtime/mock tests, and bb test.
```

After FI11 is stable, create separate Canon runs for each additional gallery member—environment setup, worktree-to-PR, review round-trip, and housekeeping—rather than grouping them into one PR.

---

## FI12 — Add fragment catalog and composition to Studio

**Depends on:** FI10 and at least one FI11-quality runnable fragment

**Suggested branch:** `feature/fragment-studio-composition`

### Outcome

A developer can inspect a fragment contract and add a complete explicit inclusion to a project workflow through Studio without hidden behavior.

### Required scope

- Render fragment cards from the public control-plane contract with scope, version, lint status, inputs, parameters, outputs, outcomes, and requirements.
- Show shadowing/conflicts visibly.
- Add a composition form for bindings, prefix, and outcome targets.
- Save an explicit workflow diff and copied package assets through existing path-confined authoring APIs.
- Run authoritative lint before completed save and show boundary diagnostics in context.
- Keep draft behavior distinct from runnable completed behavior.

### Acceptance criteria

- A local browser test composes the FI11 fragment into an isolated project workflow and verifies the persisted explicit EDN.
- Missing bindings, unsafe prefix, conflicts, and lint failures are visible and block completed save.
- No fragment runs or external effects occur during browsing/composition.

### Non-goals

No registry, drag-selection extraction, automatic boundary inference, or hosted collaboration.

### Canon TDD prompt

```text
Implement FI12 from docs/FRAGMENT_IMPLEMENTATION_PROMPTS.md. Add a Studio
fragment catalog and explicit composition flow backed by FI10 APIs: show
scope/version/lint/boundary data and shadowing, collect bindings/prefix/outcome
targets, write an inspectable project workflow diff with safe assets, and gate
completed save on authoritative lint. Add one isolated browser journey using
the FI11 fragment. Do not run fragments during composition or add registry,
extraction/inference, or hosted collaboration. Validate web tests, focused e2e,
and bb test.
```

---

## FI13 — Extract and export a selected subgraph

**Depends on:** FI12 and stable executable contract

**Suggested branch:** `feature/fragment-extract-export`

### Outcome

A connected workflow subgraph can be extracted into a self-contained fragment package with a reviewed inferred boundary and atomic source-workflow replacement.

### Required scope

- Implement pure boundary inference from cut edges, resources, templates, outputs, and outgoing outcomes.
- Expose inference through CLI first; Studio may use the same result.
- Present inferred inputs, parameters, outputs, outcomes, resources, assets, version, and prefix for explicit confirmation.
- Copy the complete asset closure with collision checks.
- Lint the package and replaced workflow before atomically writing either.
- Roll back both package and workflow on any failure.

### Acceptance criteria

- Extracting a focused fixture produces a strict-linting package and parent workflow.
- Running before and after extraction yields equivalent observable outcomes/artifacts.
- Ambiguous boundaries are reported rather than guessed.
- Collision and lint failures leave all source files unchanged.

### Non-goals

No public registry publishing, arbitrary disconnected selections, automatic semantic parameter invention, or mass extraction of existing examples.

### Canon TDD prompt

```text
Implement FI13 from docs/FRAGMENT_IMPLEMENTATION_PROMPTS.md. Add pure,
inspectable fragment boundary inference and transactional CLI extraction for one
connected workflow subgraph. Infer cut-edge inputs/outputs/outcomes/resources
and asset closure, require explicit confirmation data, strict-lint both the
package and replaced workflow, and atomically write or roll back. Prove before/
after runtime equivalence on one local fixture and rejection of ambiguity and
collisions. Do not add registry publishing, disconnected selection, speculative
parameter invention, or mass example extraction. Validate focused extraction,
lint, runtime-equivalence tests, and bb test.
```

## Completion criteria

The fragment capability is ready to leave Draft only when:

- EDN and JSON package contracts normalize consistently;
- package and inclusion lint enforce complete boundary semantics;
- boundary resources are projected correctly;
- imports are complete and transactional;
- all documented ordinary internal node types execute with durable recovery;
- approvals work or are explicitly excluded from a new version;
- at least one non-placeholder fragment runs end to end in local/mock tests;
- public inspection accurately presents scope, contracts, lint, and graph;
- `FRAGMENTS.md`, schema, linter, runtime, STATUS, and README agree.
