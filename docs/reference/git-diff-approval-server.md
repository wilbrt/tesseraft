# Git-diff approval server

A top-level approval may opt into a transient, focused local review endpoint:

```edn
{:type :approval
 :message "Review tracked changes"
 :timeout "24h"
 :review-server {:kind :git-diff :max-diff-bytes 2097152}
 :presentation
 {:question "Are these changes ready?"
  :decisions [{:decision "pass" :label "Pass"}
              {:decision "reject" :label "Reject" :requires-message true}]}
 :transitions
 [{:when {:decision "pass"} :next :done}
  {:when {:decision "reject"} :effects [:merge-issues] :next :implement}]}
```

`reject` must target a resumable agent. Its overall message and line annotations
are written to the immutable approval decision and to a deterministic
`approval-feedback/<approval-id>.json` issue artifact, then merged into the
run's canonical `issues.json`. The implementation node therefore receives the
same durable feedback after a restart; browser state is never authoritative.

## Lifecycle and ownership

On first entry, Tesseraft snapshots bounded tracked changes using fixed
non-converting Git plumbing (`rev-parse`, `ls-tree`, `ls-files`, `cat-file`) and
an owner-trusted helper that reads native worktree files through directory file
descriptors with `O_NOFOLLOW`. It records and rechecks inode/size/mtime/ctime
for every opened ancestor and file plus HEAD/index fingerprints before
publishing `approval-evidence/<approval-id>/changes.diff`. Configured diff,
textconv, clean, and process helpers are never invoked. The immutable SHA-256
and semantic line-anchor index are recorded on the durable request, then a Node
adapter launches on
`127.0.0.1:0`. Exact run/state/attempt, PID, process start instant, endpoint,
and capability hash are stored below
`approval-adapters/<state>/<attempt>/owner.json`. The capability and launch URL
are stored separately in owner-only `capability.json` and are not returned by
ordinary approval APIs.

The adapter accepts no forwarded host, CORS, or remote origin. Mutations require
the 256-bit capability and are limited to 64 KiB. Canonical Clojure validation
rechecks pending run/state/attempt, decision choice, evidence hash, annotation
path, and semantic diff line before writing a decision. Before publishing the
decision, it writes `approval-finalizations/<approval-id>.json` with an immutable
selection hash and pinned transition/effects. Stable event IDs and a state
receipt let a later mutating resume complete a crash after decision publication
without accepting another choice or duplicating logical events/effects.

A successful decision, run cancellation, or observed state change closes the
listener, removes the capability, and records terminal owner metadata. Cleanup
kills a PID only when its persisted process start instant still matches. A
mutating resume adopts one exact live blocked adapter or, after proving the old
PID/start tuple absent, removes stale capability data and launches one
replacement. Focused submissions durably distinguish complete response
`finish` from premature request/socket/response abort; disconnect never cancels
the canonical decision child. Either transport outcome starts two detached
drain candidates before listener drain, but a run-locked submission record
permits only one authoritative worker generation. The other candidate waits;
if the exact claimed worker dies it CAS-claims the next generation, while a
completed generation makes it exit without mutation. After exact adapter
PID/start absence, the winning worker serializes behind canonical decision
completion, removes only the matching capability, writes a lifecycle receipt,
and binds transport/lifecycle/submission/generation fields into the approval
finalization record. If the approval is still pending it autonomously launches
one replacement even when both generation 1 and the adapter were SIGKILLed. A
committed nonterminal decision records `resume_handoff_status=requested`; it is
not stepped until the shared generation-based launcher exists.

The durable request, evidence, decision, feedback, `issues.json`, state, and
events are authority. The listener and browser are transient adapters.

## Limitations

- Top-level approvals only; fragment-internal approvals are unsupported.
- Tracked textual changes against `HEAD` only. Untracked, unborn, binary,
  sparse/conflicted, rename-specific, and arbitrary-range review are not
  supported.
- Review is rejected when autocrlf, attributes, or custom Git conversion
  filters are detected. A conversion-free review worktree is required.
- The endpoint is local-only and single-reviewer. There is no remote sharing,
  TLS, authored port, or long-lived service.
- Diff size defaults to 2 MiB and may be authored from 1 byte through 10 MiB.
- Filesystem providers must support directory-FD relative opens and
  `O_NOFOLLOW`; unsupported platforms fail before evidence publication.
  Namespace stability uses retained inode/time receipts and secure re-traversal,
  not a kernel watch-overflow receipt.
- A stale blocked adapter is relaunched by a mutating resume. Additionally,
  detached per-submission candidates use one durable monotonic drain claim to
  recover a killed worker and autonomously relaunch a still-pending endpoint
  after finished/aborted cleanup. Pure inspection remains side-effect free;
  recovery is bounded to the two launched candidates, not a general always-on
  reconciler.
- The runtime publishes an exclusive PID/start/execution claim plus cancellation
  generation in `state.edn`, crosses a compare-exact `claimed → executing`
  barrier before workflow steps and external effects, and rejects stale saves
  after cancellation advances the fence. It does not yet use a pre-spawn intent
  generation, launcher lease, or child bootstrap claim. Committed nonterminal
  cleanup therefore writes a durable resume request but does not autonomously
  consume it.
- HTTP delivery cannot be guaranteed if the adapter is killed before response
  completion; the durable decision remains the authority.
