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
descriptors with `O_NOFOLLOW`. Worktree and HEAD sides each have an 8 MiB
per-file bound and both count toward the 64 MiB aggregate scan bound. HEAD blob
size metadata is checked before a bounded exact-length content read, including
modified and deleted paths. It records and rechecks inode/size/mtime/ctime
for every opened ancestor and file plus HEAD/index fingerprints. Supported
Darwin and Linux hosts also retain no-follow `kqueue` or `inotify` watches over
the tracked namespace and Git conversion metadata. The helper emits a prepared
candidate, remains alive while Clojure atomically publishes
`approval-evidence/<approval-id>/changes.diff`, and confirms the installed hash
only after final fingerprint and watch-queue checks. Mutation, queue overflow,
timeout, malformed acknowledgement, or transformed installed bytes remove the
candidate evidence before approval request/adapter creation. The request binds
the watch provider/count/overflow receipt. Configured diff, textconv, clean,
and process helpers are never invoked. The immutable SHA-256
and semantic line-anchor index are recorded on the durable request, then a Node
adapter launches on `127.0.0.1:0`. Workflow state identity uses the complete
namespace-preserving wire form (`team/review`, not only `review`). Approval IDs
and adapter path segments use its collision-free UTF-8 percent encoding, so two
accepted states with the same local name cannot share records or ownership
paths. Exact run/state/attempt, PID, process start instant, endpoint, and
capability hash are stored below
`approval-adapters/<encoded-state>/<attempt>/owner.json`. The capability and
launch URL are stored separately in owner-only `capability.json` and are not
returned by ordinary approval APIs.

The adapter accepts no forwarded host, CORS, or remote origin. Mutations require
the 256-bit capability and are limited to 64 KiB. Decision bodies accept only
`decision`, `message`, and `annotations`; ownership and attribution keys are
rejected, and trusted run/approval fields are assigned by the adapter. The
spawned apply process independently canonicalizes and compares its run and
approval environment binding before dispatch. Canonical Clojure validation
always reloads the bounded durable request and requires its exact pending
run/state/attempt/approval tuple, focused-review metadata, canonical evidence
path, byte size, and SHA-256 before accepting pass or reject, even when no
annotations were submitted. Per-annotation validation additionally checks the
reviewed artifact path and semantic diff line against that same validated
evidence view. Missing, malformed, symlinked, oversized, unstable, or changed
request/evidence authority rejects the decision before feedback, finalization,
decision, event, effect, or state mutation. Before publishing the decision, it writes `approval-finalizations/<approval-id>.json` with an immutable
selection hash and pinned transition/effects. Stable event IDs and a state
receipt let a later mutating resume complete a crash after decision publication
without accepting another choice or duplicating logical events/effects.

The adapter never parses or substring-matches `state.edn`. Its confined
`approval.adapter.status` operation uses the same request/evidence validator and
returns a structured exact run/state/attempt/status/approval projection,
decision-presence bit, authority-valid bit, and pending bit. Any tuple,
authority, or inspection failure reports non-pending and fails closed. The first
exact pending check is recorded in transient owner metadata. Invalid authority
closes a live listener and removes its capability; blocked reconciliation marks
the exact owner invalid and never relaunches it. A successful decision, run
cancellation, or observed state change likewise closes the listener, removes the
capability, and records terminal owner metadata. Cleanup
kills a PID only when its persisted process start instant still matches. A
mutating resume adopts one exact live blocked adapter or, after proving the old
PID/start tuple absent, removes stale capability data and launches one
replacement. Focused submissions durably distinguish complete response
`finish` from premature request/socket/response abort; disconnect never cancels
the canonical decision child. Either transport outcome starts two detached
drain candidates before listener drain, but a run-locked submission record
permits only one authoritative worker generation. The other candidate waits;
if the exact claimed worker dies it CAS-claims the next generation, while a
completed generation makes it exit without mutation. If both initial candidates
die, the bounded external `approval.adapter.reconcile` operation scans durable
incomplete receipts, skips exact live workers, and invokes the same CAS protocol
for a later generation. After exact adapter
PID/start absence, the winning worker serializes behind canonical decision
completion, removes only the matching capability, writes a lifecycle receipt,
and binds transport/lifecycle/submission/generation fields into the approval
finalization record. If the approval is still pending it autonomously launches
one replacement even when both generation 1 and the adapter were SIGKILLed. A
committed nonterminal decision records `resume_handoff_status=requested` and,
in the same run-locked lifecycle completion, creates one deterministic
`:approval-resume` execution intent. The detached worker leases that exact
generation and a bootstrap child claims it before loading workflow state; no
destination step can run before exact lifecycle completion. The focused
Playwright fault scenario drives a server-observed browser transport abort,
kills both initial candidates and the adapter, repeatedly invokes the idempotent
external reconciler until exact liveness permits generation-2 takeover, and
verifies lifecycle completion plus endpoint replacement.

The durable request, evidence, decision, feedback, `issues.json`, state, and
events are authority. The listener and browser are transient adapters.

## Limitations

- Top-level approvals only; fragment-internal approvals are unsupported.
- Tracked textual changes against `HEAD` only. Untracked, unborn, binary,
  sparse/conflicted, rename-specific, and arbitrary-range review are not
  supported.
- Review is rejected when autocrlf, core.eol, or any effective Git attributes
  source is detected. Configured conversion drivers without attributes are
  inert and accepted; the fixed plumbing and direct worktree reads never invoke
  them. A conversion-free review worktree is required.
- The endpoint is local-only and single-reviewer. There is no remote sharing,
  TLS, authored port, or long-lived service.
- Diff size defaults to 2 MiB and may be authored from 1 byte through 10 MiB.
- Filesystem providers must support directory-FD relative opens, `O_NOFOLLOW`,
  and retained `kqueue` (Darwin) or `inotify` (Linux) mutation watches;
  unsupported platforms and watch overflow fail closed. Deterministic tests
  mutate and restore tracked bytes, an intermediate directory through an
  outside-sentinel symlink, the index, and Git config while atomic evidence
  publication is blocked; every case removes evidence without creating an
  approval request or adapter.
- A stale blocked adapter is relaunched by a mutating resume. Additionally,
  detached per-submission candidates use one durable monotonic drain claim to
  recover a killed worker and autonomously relaunch a still-pending endpoint
  after finished/aborted cleanup. Pure inspection remains side-effect free;
  an explicit external reconciliation pass can recover after both initial
  candidates die without making browser, adapter, or query state authoritative.
- Every CLI, Web, structured apply, retry, approval-resume, and detached
  handoff execution passes through the state-authoritative execution-intent
  gateway. A parent durably leases `requested → launching` before spawn; the
  child claims the exact intent/generation/PID/start tuple before loading the
  workflow, crosses `claimed → executing` immediately before the first step,
  and records finished/abandoned/cancel-requested receipts. Expired or dead
  pre-step generations are reissued; post-`node.started` death uses the
  existing fail-closed orphan policy and never replays an ambiguous effect.
- HTTP delivery cannot be guaranteed if the adapter is killed before response
  completion; the durable decision remains the authority.
