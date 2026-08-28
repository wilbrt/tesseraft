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

On first entry, Tesseraft snapshots bounded tracked changes into
`approval-evidence/<approval-id>/changes.diff`, records its SHA-256 and semantic
line-anchor index on the durable request, and launches a Node adapter on
`127.0.0.1:0`. Exact run/state/attempt, PID, process start instant, endpoint,
and capability hash are stored below
`approval-adapters/<state>/<attempt>/owner.json`. The capability and launch URL
are stored separately in owner-only `capability.json` and are not returned by
ordinary approval APIs.

The adapter accepts no forwarded host, CORS, or remote origin. Mutations require
the 256-bit capability and are limited to 64 KiB. Canonical Clojure validation
rechecks pending run/state/attempt, decision choice, evidence hash, annotation
path, and semantic diff line before writing a decision. A successful decision,
run cancellation, or observed state change closes the listener, removes the
capability, and records terminal owner metadata. Cleanup kills a PID only when
its persisted process start instant still matches.

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
- The current adapter recovers cleanup by exact owner inspection and state
  observation. It does not guarantee delivery of an HTTP response if the
  adapter is killed before response completion.
