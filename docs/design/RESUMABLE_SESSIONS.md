# Resumable sessions

Status: Accepted
Decision date: 2026-08-27
Supersedes: —
Superseded by: —

This document defines a contract-first plan for letting a Tesseraft agent node
continue one durable conversation across multiple, separately bounded workflow
activations. The motivating case is an implementation session that yields to
deterministic checks and an independent review session, then receives the
review issues as its next user message and continues with its prior context.

The objective is trajectory continuity without weakening Tesseraft's state
machine, proof trace, portability, or recovery guarantees.

This design extends the [workflow specification](../../SPEC.md), the
[durable authority map](../architecture/AUTHORITIES.md), the
[contract responsibility boundaries](../reference/CONTRACT_RESPONSIBILITIES.md),
and the [code-style principles](../architecture/CODE_STYLE.md). It borrows the
trajectory-continuity insight from
[Stencil's prewalk write-up](https://stencil.so/blog/prewalk), but does not add
model switching in version one.

Suggested branch: `feature/resumable-agent-sessions`.

Implementation status: the portable contract, durable binding lifecycle,
restart recovery, mock executor, explicit Pi CLI start/resume adapter, and
maintained review-loop example are implemented on the feature branch. OpenCode,
Claude Code, and UI authoring/inspection remain the explicitly deferred RS5–RS7
increments; their executors continue to advertise no resume capability.

## Decision summary

Add an explicit, optional `:session` policy to `:agent` nodes rather than a
second agent-like node type.

```edn
:implement
{:type :agent
 :executor :pi-cli
 :prompt-template "prompts/implement.md.tmpl"
 :prompt-output "prompts/generated/implement-{{run.attempt}}.md"
 :session
 {:mode :resumable
  :continuation-prompt-template "prompts/implementation-feedback.md.tmpl"
  :continuation-prompt-output "prompts/generated/implementation-feedback-{{run.attempt}}.md"}
 :tools [:read :bash :edit :write :grep :find :ls]
 :runtime {:cwd "{{run.worktree-dir}}" :timeout "90m"}
 :outputs
 {:status {:path "execution/status-{{run.attempt}}.json"
           :schema "../../../schemas/status.schema.json"
           :required true}
  :summary {:path "execution/summary-{{run.attempt}}.md" :required true}}
 :transitions
 [{:when {:status "pass"} :next :test}
  {:when {:status "fail"} :effects [:merge-issues :inc-round] :next :implement}]}
```

The node's first activation renders `:prompt-template` and starts a session.
Every later activation of the same state renders only
`:continuation-prompt-template` and resumes that session. A typical
continuation prompt points the implementation session at the durable merged
issues artifact:

```md
An independent review found actionable issues.

Read {{run.issues-file}}, address every current issue, and run the relevant
validation. Continue from your existing implementation context. Do not redo
completed discovery unless the feedback invalidates it.
```

The workflow graph remains ordinary and explicit:

```text
implement ──pass──> test ──pass──> review ──pass──> done
    ^                  │                 │
    └──────fail────────┘                 │
    └────────────────fail───────────────┘
```

While `test` or `review` is current, the implementation *session* is
suspended. The `implement` node is not still executing.

## Why this fits Tesseraft

Tesseraft nodes are controlled resource transformations, and every runtime
activation belongs to a unique `(state, attempt)` proof boundary. Resumability
must preserve that model:

- Every activation appends `node.started` and exactly one closing
  `node.finished` or `node.failed` event before the graph advances.
- The external CLI process exits at the end of each activation. Tesseraft does
  not keep a hidden process, thread, socket, or in-memory agent alive.
- The persisted session binding is a run-owned reusable resource. Re-entering
  the state performs another bounded transformation using that resource.
- The workflow declares continuation behavior. A repeated display name or an
  executor's ambient "last session" must never change runtime semantics.
- Review feedback remains a declared run artifact, and the exact continuation
  prompt derived from it is persisted before delivery.
- Static errors belong in schema/lint, runtime safety checks remain defensive,
  and executor-specific flags stay at the executor edge.

This requires changing the specification's description of `:agent` from a
"bounded agent session" to a "bounded agent activation". An ordinary agent has
one activation and one executor session. An agent with
`:session {:mode :resumable}` may have several activations attached to one
executor session.

## Why this is not a new node type

A separate `:agent-session` or `:resumable-agent` type would repeat the same
executor, model, prompt, tool, timeout, output, transition, resource, and
security contracts as `:agent`. It would create parallel schema, linter,
fragment, Studio, mock, and runtime paths for one lifecycle difference.

The nested `:session` policy keeps the difference explicit as data without
introducing a second dispatch mechanism. Code that handles common agent
behavior remains common; session lifecycle code is activated only when the
declaration requests it.

The following alternatives are rejected:

- **Infer resumption from `:session-name`.** A display label is not a stable
  identity or behavioral contract. Silent inference would make workflows hard
  to inspect and could resume an unintended conversation.
- **Treat the node as literally paused.** That would violate bounded node
  execution, complicate process ownership, and make recovery depend on live
  in-memory state.
- **Always resume every `:agent` on re-entry.** Existing workflows intentionally
  create fresh agents on loops. Their behavior must remain unchanged.
- **Let unsupported executors start a fresh session.** This hides lost context
  and contradicts the authored workflow. Unsupported or missing resume state
  is a durable runtime failure.

## Public workflow contract

The optional `:session` map is valid only on `:agent` nodes.

```edn
:session
{:mode :resumable
 :continuation-prompt-template "prompts/feedback.md.tmpl"
 :continuation-prompt-output "prompts/generated/feedback-{{run.attempt}}.md"}
```

Fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `:mode` | yes | `:resumable` is the only initial value. |
| `:continuation-prompt-template` | yes | Package-relative template rendered on every activation after the first. |
| `:continuation-prompt-output` | no | Run-relative persisted prompt path. The default is `prompts/generated/<state>-continuation-<attempt>.md`. |

The logical session identity is the pair `(run id, state id)`. Version one does
not permit two nodes to share a session and does not need a user-authored
session key. This prevents hidden graph edges and ambiguous ownership.

`:session-name` remains an optional executor display label. It is not the
logical identity and cannot select which session to resume.

The linter exposes an effective `:session` resource derived from the explicit
policy and owning state id. Authors do not repeat that derived resource in
`:resources`. The first activation allocates it and later activations require
it; this activation-sensitive lifecycle is checked by session lint/runtime
rather than pretending that every graph visit is the same resource-flow step.

Resumable nodes must use activation-stamped required outputs. Each required
output path must contain `{{run.attempt}}`; `{{run.round}}` alone is
insufficient because not every transition increments the round. This prevents
a prior activation's artifact from being mistaken for evidence from the
current activation during recovery.

The initial and continuation templates use the existing template namespaces.
The runtime does not implicitly inject issues, read arbitrary files into a
prompt, or invent a feedback format. Workflows make that data flow visible in
the continuation template and, where applicable, `:resources` declarations.

## Durable session authority

Each resumable state owns one binding record:

```text
<run-dir>/sessions/<state-id>/binding.json
```

The record is a new run-local authority written only by a focused runtime
session store through the shared safe-write primitives. Executor transcripts
and raw event streams remain evidence owned by their executor-specific
directories; they are not competing binding authorities.

Proposed version-one binding:

```json
{
  "version": 1,
  "run_id": "run-123",
  "state": "implement",
  "executor": "pi-cli",
  "status": "suspended",
  "session_ref": {"kind": "id", "value": "8c2d..."},
  "configuration_hash": "sha256:...",
  "activation_sequence": 2,
  "last_activation": {
    "attempt": 7,
    "operation": "resume",
    "delivery_id": "implement-7",
    "prompt_file": "prompts/generated/implementation-feedback-7.md",
    "prompt_sha256": "sha256:...",
    "status": "finished"
  },
  "created_at": "...",
  "updated_at": "..."
}
```

Binding statuses are:

- `allocated` — the binding and delivery identity are durable but the first
  activation has not completed; `session_ref` may still be absent when an
  executor cannot preallocate it;
- `active` — an executor activation may currently be in flight;
- `suspended` — the last activation closed and the session can be resumed;
- `orphaned` — an activation ended ambiguously and requires recovery;
- `closed` — the owning run finished successfully and no later activation is
  allowed.

The configuration hash covers the executor, provider, model, thinking level,
sorted effective tool set, resolved working directory, state id, and the
session-policy fields. It never contains credentials. A pinned workflow
normally keeps these fields stable; the hash also protects recovery after an
explicit repin or environmental path drift. A mismatch fails rather than
silently resuming with broadened permissions or different semantics.

The [durable authority map](../architecture/AUTHORITIES.md) must add this
binding authority in the same change that introduces it.
`schemas/session-binding.schema.json` owns its portable shape. Existing
`state.edn` records need no migration because old runs do not contain
resumable bindings.

## Activation protocol

Session orchestration belongs in a new focused runtime namespace, not in graph
transition code and not independently in each executor.

For a first activation:

1. Resolve and render the initial prompt to an attempt-stamped run path.
2. Compute the configuration hash and a unique delivery id derived from the
   state and attempt.
3. Allocate and safely persist the binding before invoking the executor,
   including the session reference when the executor supports preallocation.
4. Append `session.allocated`, then mark the activation `active` and append
   `session.activation.started`.
5. Invoke the executor in `start` mode with an explicit normalized session
   request. If its reference cannot be preallocated, bind the first reliable
   emitted reference as soon as the adapter can durably expose it.
6. Validate the bound or returned session reference, status artifact, and all
   required outputs.
7. Mark the binding `suspended`, append `session.activation.finished` and
   `session.suspended`, then close the node attempt normally.

For a later activation:

1. Load the binding by run id and state id; require `suspended` status.
2. Verify the executor supports resume and the configuration hash still
   matches.
3. Render and persist only the continuation prompt.
4. Persist the new delivery id, prompt path, and prompt hash before invoking
   the executor.
5. Mark the binding `active`, append `session.activation.started`, and invoke
   the executor in `resume` mode with the exact stored reference.
6. Validate new attempt-stamped outputs.
7. Mark the binding `suspended`, append closing session events, and close the
   node attempt normally.

The executor request should make the operation explicit rather than hiding it
inside ambient context:

```clojure
{:operation :start                    ; or :resume
 :prompt-file "/absolute/run/path/..."
 :delivery-id "implement-7"
 :session-ref nil                     ; required for :resume
 :configuration {...}}
```

The exact internal function signature may evolve while the executor façade is
being extracted, but the data must remain inspectable and JSON-compatible.
Ordinary agents continue to use one-shot mode and retain their current
behavior.

## Events and proof trace

Add these session event categories:

- `session.allocated`
- `session.activation.started`
- `session.activation.finished`
- `session.suspended`
- `session.orphaned`
- `session.closed`

Every event includes `state`, `attempt`, `executor`, `activation_sequence`, and
`delivery_id` where available. Events may contain the run-relative prompt path,
prompt hash, configuration hash, and redacted session reference. They must not
contain prompt bodies, credentials, or raw external transcripts.

Session events complement rather than replace node events. A successful
continuation has this ordering:

```text
node.started
session.activation.started
session.activation.finished
session.suspended
node.finished
transition.selected
```

If session orchestration fails after `node.started`, the runtime writes
`session.orphaned` when delivery is uncertain and always closes the attempt
with `node.failed` or the existing orphan-recovery evidence.

## Failure and recovery semantics

Resuming a session is an external side effect: a process can die after a prompt
was accepted but before Tesseraft records completion. The implementation must
not claim exactly-once delivery unless an executor can prove it.

| Durable state | Interpretation | Automatic action |
| --- | --- | --- |
| `suspended` with no current `node.started` | Safe continuation boundary | Resume normally. |
| Required attempt-stamped outputs exist after interruption | Activation completed far enough to prove its declared result | Reuse existing completed-agent recovery, finish the activation, and suspend the binding. |
| `active`, and adapter proves the delivery id is absent | Prompt was not delivered | A new audited retry may deliver it. |
| `active`, and adapter proves the delivery and completed response are present | Executor work completed | Recover outputs/session evidence without sending the prompt again. |
| `active`, and delivery cannot be proven present or absent | Ambiguous side effect | Mark `orphaned`; fail durably and require explicit recovery. Never resend automatically. |
| Session reference missing, malformed, or unavailable | Authored continuity cannot be honored | Fail durably; never start fresh. |
| Configuration hash mismatch | Workflow/runtime contract changed | Fail durably; a future explicit fork/reset operation may create a new session. |

Each supported executor must define how it reconciles a `delivery_id`. A
delivery marker may be included in the persisted user message when the
executor's local transcript provides no separate idempotency key. That marker
must be stable, harmless to the model, and covered by fixture tests.

Version one does not add an unsafe generic `--force-resend` shortcut. If a
supported executor cannot provide reliable reconciliation for interrupted
resumes, its adapter may support normal resumption while classifying ambiguous
interruptions as explicitly unrecoverable. This limitation must appear in its
capability metadata and documentation.

Cancellation reaps only live owned processes; it never deletes session files.
If cancellation interrupts an active activation, the binding becomes
`orphaned`; already suspended bindings remain suspended. A successfully
finished run marks its suspended bindings `closed` before `run.finished`.
Failed or cancelled runs retain bindings and evidence for explicit retry and
inspection.

## Executor capability boundary

The executor catalog remains the sole source of resume capability metadata.
`:session {:mode :resumable}` is a lint error unless the selected executor is
dispatchable and declares resumable-session support.

Initial support order:

1. **Mock executor** — deterministic stable references and activation
   sequences, enabling default tests without credentials or network access.
2. **Pi CLI** — first live adapter. Pi exposes explicit `--session-id`,
   `--session`, and `--session-dir` options, and the current catalog already
   declares session-resume support. Start and resume must never use ambient
   `--continue` lookup.
3. **OpenCode CLI** — follow-up after capturing and durably binding the emitted
   session id. Resume uses explicit `--session`; never `--continue`.
4. **Claude Code** — follow-up after switching the adapter to a structured
   output mode that reliably captures its session id. Resume uses explicit
   `--resume <id>`.

An installed CLI exposing a resume flag is not sufficient. Tesseraft support
requires a tested stable reference, explicit selection, prompt delivery, and
documented interruption behavior.

Model switching within one session, as in prewalk-style frontier-to-cheaper
handoff, is deliberately deferred. Version one requires the configuration hash
to remain stable. A later explicit contract may allow selected model fields to
change without weakening tool or working-directory constraints.

## Schema, lint, and package responsibilities

JSON Schema owns:

- the optional closed `session` object on agent nodes;
- the `resumable` mode enum;
- required continuation-template field and primitive types;
- the versioned session-binding record;
- generated TypeScript contract updates.

The linter owns contextual checks:

- the selected executor advertises resumable-session support;
- continuation template and optional output path are safe and exist;
- continuation template variables are valid;
- all required resumable-node output paths contain `{{run.attempt}}`;
- cycles containing resumable nodes still have the existing bounded
  retry/exit policy;
- node and fragment packages declare/copy the continuation template asset;
- tools remain within workflow policy.

The runtime repeats safety checks for:

- run confinement and safe writes;
- binding version and ownership;
- exact state-to-session identity;
- pinned configuration hash;
- session status transitions;
- attempt-stamped required outputs;
- executor resume support and returned reference shape.

Fragment-internal resumable agents use the nested run's own session directory
and mirrored event mechanism. They do not bind directly to the parent run.
This keeps fragment recovery and resource ownership namespaced.

## Security and portability invariants

- Resumption can never broaden the node's tool allowlist.
- Runtime sessions remain forbidden from modifying workflow definitions except
  on an explicitly supported workflow-authoring surface.
- No session record contains credential values, provider tokens, full prompt
  bodies, or unrestricted environment snapshots.
- Session paths stored as references are run-relative. Machine-local absolute
  paths may be resolved at runtime but are not portable workflow data.
- Session selection always uses the exact bound reference. Ambient recent
  session lookup is forbidden.
- External plugins/configuration remain subject to each executor's existing
  isolation contract.
- All normalized workflow and session-binding data remains JSON-compatible.
- Browser state may display session state but never owns or repairs it.

## Compatibility

The optional `:session` policy is additive to `tesseraft.workflow/v1` while the
specification remains draft. Existing `:agent` declarations, session names,
prompts, executor commands, mock behavior, and run records remain unchanged.

No old run requires migration because only newly authored resumable nodes
create binding records. Once a binding is introduced, its `version` field is
decoded at the session-store boundary. Unsupported binding versions produce an
actionable error rather than fallback probing.

The change updates:

- `SPEC.md` and workflow/node schemas;
- contract normalization and generated wire types;
- linter rules and diagnostics;
- the executor catalog contract;
- runtime session authority, lifecycle, and events;
- mock and supported live executors;
- reference docs, authority map, and maintained examples;
- Run Console/Studio only after the file-backed contract is stable.

## Delivery plan

Each increment should be independently reviewable, preserve green existing
tests, and avoid requiring external credentials in the default suite.

### RS0 — Contract and executor evidence

Outcome: accept this design and record fixture-backed evidence for the exact Pi,
OpenCode, and Claude Code start/resume command and session-id surfaces.

Required work:

- Confirm the public `:session` shape and binding lifecycle.
- Capture sanitized CLI help/version evidence and fake-CLI transcripts.
- Verify whether each executor can preallocate or reliably extract an id.
- Verify which adapters can reconcile a delivery marker after interruption.
- Mark unsupported/uncertain capabilities accurately; do not overclaim.

Acceptance:

- Review agrees that a bounded activation and suspended durable session are
  distinct concepts.
- Pi has enough evidence to be the first live implementation.
- OpenCode and Claude Code remain disabled for the feature until their binding
  and recovery evidence is adequate.

### RS1 — Portable contract and static proof

Outcome: workflows can declare resumable sessions and receive complete static
diagnostics, but runtime execution is still rejected until RS2.

Required work:

- Extend workflow and node-package contracts and normalization.
- Generate TypeScript wire types.
- Add executor capability and template-asset lint rules.
- Require attempt-stamped outputs.
- Add a fail-closed runtime guard so an RS1 declaration cannot be accidentally
  executed as a fresh ordinary agent before lifecycle support lands.
- Update `SPEC.md`, node reference, contract responsibilities, and fixtures.

Acceptance:

- Valid EDN and normalized JSON forms lint identically.
- Missing templates, unsafe paths, unsupported executors, invalid mode, and
  unstamped outputs have focused diagnostics.
- Attempting to execute the new policy before RS2 fails explicitly and never
  invokes an executor.
- Existing workflows and node/fragment packages lint unchanged.

### RS2 — Durable lifecycle and mock execution

Outcome: a local mock workflow can visit one resumable state twice, with an
independent node between visits, and produce a reconstructable proof trace.

Required work:

- Add the session-binding schema, focused store namespace, safe writes, and
  authority-map row.
- Add pure activation planning and explicit lifecycle transitions.
- Add session events and integrate node-attempt recovery.
- Implement deterministic mock start/resume behavior.
- Ensure nested fragment runs own their own session bindings.

Acceptance:

- The first visit uses the initial prompt; the second uses only the
  continuation prompt.
- Both visits have distinct `(state, attempt)` node evidence and one stable
  session reference.
- Restarting the runner between the intervening node and resumption works.
- Old workflows have byte-for-byte equivalent semantic execution evidence
  apart from unrelated timestamps.

### RS3 — Pi CLI start and resume

Outcome: Pi continues one exact run-local session across review feedback.

Required work:

- Use an exact allocated Pi session id for the first invocation.
- Resume that id explicitly from the run-local session directory.
- Send only the persisted continuation prompt on later activations.
- Persist structured executor results without using display names as identity.
- Add fake-Pi integration tests for arguments, prompts, refs, failures, and
  configuration mismatch.
- Add interruption/reconciliation tests based on RS0 evidence.

Acceptance:

- Two implementation activations use the same exact Pi session reference.
- An independent review agent uses a different session.
- The second Pi invocation receives the review continuation and not the
  original task prompt.
- Missing or ambiguous session state fails without starting a replacement.

### RS4 — Maintained review-loop example

Outcome: a catalog workflow demonstrates implementation → checks → independent
review → same implementation session.

Required work:

- Add a focused resumable code-review-loop example rather than silently
  changing every existing catalog workflow.
- Keep deterministic gates and independent review authority unchanged.
- Add contract tests and safe mock execution covering one failed review and a
  later pass.
- Document run files, events, session binding, and bounded operation.

Acceptance:

- Review issues are durable before continuation.
- The implementation trajectory is continuous; reviewer context is isolated.
- Maximum rounds still stop a non-converging loop.

### RS5 — OpenCode support

Outcome: OpenCode implements the same contract with an explicitly captured
session id and `--session` resumption.

Required work:

- Promote catalog capability only after adapter and recovery tests pass.
- Keep pure configuration and permission ceiling identical on resume.
- Persist per-activation raw event streams without treating them as binding
  authority.

### RS6 — Claude Code support

Outcome: Claude Code implements the same contract with structured session-id
capture and explicit `--resume`.

Required work:

- Capture a reliable session id in non-interactive mode.
- Preserve subscription authentication and API-key stripping.
- Promote catalog capability only after adapter and recovery tests pass.

### RS7 — Inspection and authoring UI

Outcome: Run Console displays authoritative session state and Studio can author
the portable policy without owning either.

Required work:

- Expose session bindings through the project-scoped run query service.
- Show state, executor, activation count, last prompt artifact, and any
  orphaned diagnostic in Run Console.
- Add Studio controls for resumable mode and continuation-template fields.
- Save explicit workflow EDN through the existing confined authoring service.

Acceptance:

- Refreshing the browser reconstructs the same view from run files.
- UI state cannot resume, repair, or replace a session without a future
  explicit control-plane operation.

## End-to-end acceptance criteria

The feature is complete when all of the following are true:

1. A workflow declaration alone determines whether an agent starts fresh or
   resumes.
2. The implementation-review loop resumes one exact session and sends only the
   continuation message on re-entry.
3. Every activation remains bounded, timeout-controlled, attempt-stamped, and
   closed in the event log.
4. Session bindings, prompts, outputs, failures, and recovery decisions are
   run-local and inspectable after process restart.
5. Unsupported executors and missing/mismatched session state never degrade to
   a fresh agent.
6. Tool permissions and workflow pinning remain effective on every resume.
7. Mock and default tests require no network, credentials, or live model.
8. Existing workflows retain their fresh-session behavior and public outputs.
9. Lint, schema, runtime, executor catalog, fragments, generated types,
   documentation, and UI agree on one contract.

## Explicit non-goals

- Keeping an executor subprocess alive while other workflow nodes run.
- Sharing one session across different state ids.
- Automatically switching models inside a session.
- Replacing review artifacts with hidden in-memory messages.
- Letting a reviewer inherit the implementation conversation.
- Inferring session identity from title, cwd, "most recent", or transcript
  scanning across the user's global session store.
- Deleting external or local CLI session history when a run completes.
- Claiming exactly-once prompt delivery where an executor cannot prove it.
- Adding generic force-resend, reset, fork, or cross-run continuation controls
  before their authority and recovery semantics are separately designed.
