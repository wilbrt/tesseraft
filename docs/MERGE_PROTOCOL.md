# Merge Protocol

> Rule: **CI green** + **one human approval-node decision** = merge; PRs older
> than 5 days are rebased automatically by a `pr-housekeeping` run (report
> first, mutation gated behind an explicit opt-in).

This document defines the merge protocol for Tesseraft's own pull requests,
how the `pr-housekeeping` workflow enforces the **rebase recommendation
report** half of it, and the status of the **approval node** dogfood. It is
the canonical reference for roadmap item **P0.3**.

## Gates

A pull request may be merged when **all** of the following hold:

1. **CI green.** The CI job defined in `.github/workflows/ci.yml`
   (`bb test`) passes on the PR head. Concretely, the GitHub
   `statusCheckRollup` for the PR reports only `SUCCESS`, `SKIPPED`,
   `NEUTRAL`, or no checks; any pending or failing check blocks merge.
2. **Exactly one human approval decision.** A single human
   `approval.decided` event from a `:approval` node (SPEC §5, §10) authorizes
   the merge. The decision is recorded as a runtime event in the run's
   `events.jsonl` (event category `approval.requested` /
   `approval.decided`).
3. **Freshness / rebase precondition.** If the PR is older than 5 days
   (see age definition below), it is rebased before merge. The pr-housekeeping
   run emits a rebase recommendation report (read-only); the actual rebase is
   performed by the existing `prepare-conflict-worktree` →
   `rebase-conflict-worktree` chain only when that workflow's mutation paths
   are enabled (the report path mutates no GitHub state).

When all gates are satisfied, the PR is mergeable. The `pr-housekeeping`
classifier surfaces such PRs as `ready-to-merge` (or `merge`, when the
`merge-approved` input is set) in `housekeeping/actions.json`.

## Age and rebase recommendation

### Age definition

`age` is computed from the PR's **`updatedAt`** field (already fetched by
`list_prs.py` and `fetch_pr_states.py`), measured against a **snapshot time
taken at workflow start** (`datetime.now(timezone.utc)` inside
`classify_prs.py`).

Why `updatedAt` and not `createdAt`:

- The protocol's intent is "stale activity" — a PR that has had no activity
  for 5+ days is the one worth rebasing or pinging, regardless of when it was
  first opened. A two-week-old PR that was updated yesterday is *not* stale
  by this definition.
- Using the workflow snapshot time (not per-requestwall-clock) keeps the
  report deterministic for one run: every PR in one report is aged against
  the same instant, so the relative ordering is stable and auditable.

`createdAt` is **not** used and is, in fact, not fetched by the current
scripts; adding it would require a schema change and is out of scope.

### Rebase recommendation signal

The rebase recommendation is a **strict, gated, read-only** signal. A PR is
flagged `rebase_recommended` iff:

- `mergeStateStatus == "BEHIND"` (an explicit GitHub merge state), **and**
- `age_days >= 5` (where `age_days` is computed from `updatedAt` as above).

The recommendation **never** fires on:

- `mergeStateStatus == "UNKNOWN"` — treated as `blocked` by the existing
  classifier (see risk below). Rebase recommendations must never be guessed
  from missing data.
- A PR that is merely old but not `BEHIND`. Age alone does not recommend a
  rebase; the PR must also be stale *and* lagging its base branch.
- A PR that is `BEHIND` but recently updated. The two conditions are
  conjoined, not disjoined.

### Why `mergeStateStatus` and not the `mergeable` field?

`fetch_pr_states.py` also fetches the `mergeable` boolean. It is intentionally
**not** the gate for the rebase recommendation:

- `mergeable` can be `null`/`UNKNOWN` while GitHub recomputes, which is
  ambiguous about *why* a PR is not mergeable (conflicts vs. behind vs.
  policy). Treating `UNKNOWN` as "stale-but-behind" would guess.
- `mergeStateStatus == "BEHIND"` is the explicit, unambiguous signal that the
  PR head is behind its base and a rebase would advance it. The rebase
  recommendation keys off that explicit signal only.

`mergeable` remains available in `pr-states.json` for future, more
permissive heuristics; the P0.3 slice deliberately chooses the
strictest explicit gate to avoid false-positive rebases.

## Outputs of the pr-housekeeping rebase report

The read-only report path produces, under `housekeeping/`:

```text
housekeeping/actions.json                                 (extended: +age_days, +rebase_recommended, +snapshot_at)
housekeeping/report.md                                    (adds Age column + rebase-recommendation count line)
housekeeping/planned/rebase-recommendations.json          (NEW: every PR flagged rebase_recommended)
housekeeping/action-plan.md                                (adds ## recommend-rebase (N) section)
```

The `recommend-rebase` action bucket is **new and additive**:

- `select_conflict_target.py` selects only `action == "fix-conflicts"`.
- `select_comment_target.py` selects only `needs_response == true`.
- Neither ever selects `recommend-rebase` items for repair — they are
  report-only and never mutated.

This preserves the existing conflict/comment repair semantics: the new bucket
is a parallel, read-only lane that does not perturb the repair loop.

### Report-only, regardless of `dry-run`

The rebase recommendation report runs whether or not `dry-run` is set,
because it never mutates GitHub state. There is no `gh pr merge`, no
`git push`, and no comment posting on the report path. The report is
inspectable at the paths above.

## Approval node: spec vs. runtime (deferred dogfood)

This is the central design risk for P0.3 and is documented here so the
protocol is auditable against the current runtime.

### Spec level (today)

`:approval` is a **valid node type** in `src/tesseraft/spec.clj`; the linter
accepts approval nodes and their `:message` / `:decision` transitions (SPEC
§5, §10). Runtime event categories `approval.requested` and
`approval.decided` are defined (SPEC §202).

### Runtime status (now landed)

The runtime approval/manual-input node landed in PR #44 (merged to main):
`src/tesseraft/runtime/core.clj` now implements approval pause/resume — on
first entry it writes a run-relative approval-request record, appends
`approval.requested`, marks the run `"blocked"`, and parks; a decision via
`tesseraft runtime decide` (exposed through the control plane and
`POST /api/runs/{run-id}/approvals/{approval-id}`) appends `approval.decided`
and advances through the transition whose `:when` matches the decision.
Artifact comments are persisted run-relative. The earlier
`"Approval nodes require a control plane"` placeholder throw has been
replaced by the real implementation.

### P0.3 dogfood scope (deliberately bounded, as scoped at the time)

At the time this slice was authored, a runnable `:approval` node would throw
at runtime, so P0.3 **did not** wire a real `:approval` node into
`workflow.edn`. The dogfood was:

1. **The rebase recommendation report** (Layer A) — runnable now, read-only,
   validated by `bb test` + `./bin/tesseraft lint`.
2. **This document** (Layer B) — the protocol contract, including the exact
   shape of the approval gate (one human `approval.decided` event) so that
   when the control plane lands (roadmap item **P0.1-e**), the approval node
   can be dropped into the merge flow without re-defining the protocol.

Until P0.1-e lands, the "one human approval-node decision" in gate (2) is
**recorded as a documented human action**, not a runtime `:approval` node:
the approving human records the decision (e.g., a GitHub review approval),
and the `merge-approved` pr-housekeeping input is the bridge that lets the
classifier surface `merge` instead of `ready-to-merge`. The protocol
contract is unchanged; only its runtime executor is deferred.

Now that the approval runtime has landed (PR #44), the wiring is available:
replace the human-recorded decision with a real `:approval` node in the merge
path, emitting `approval.requested` / `approval.decided` events into
`events.jsonl`, and gate the merge action on that event. **No change to the
gates in this document is expected.** (Adopting a real `:approval` node in
`examples/pr-housekeeping/workflow.edn` is a follow-up; the protocol gates
are unchanged.)

## Validation

- `./bin/tesseraft lint examples/pr-housekeeping/workflow.edn` — the workflow
  lints with the modified scripts (no new nodes added).
- `bb test` — the suite lints and smoke-runs example workflows; the
  modified scripts are exercised indirectly via the lint step.

The merge-protocol document itself has no automated test; it should be
reviewed against SPEC §5 / §10 (approval node shape) and
`.github/workflows/ci.yml` (CI-green gate).

## Change surface

New:
- `docs/MERGE_PROTOCOL.md` (this file).

Modified:
- `examples/pr-housekeeping/scripts/classify_prs.py` — adds `age_days`,
  `rebase_recommended`, the `recommend-rebase` action bucket, and an Age
  column / rebase-recommendation count in `report.md`.
- `examples/pr-housekeeping/scripts/plan_actions.py` — adds the
  `recommend-rebase` bucket writing `rebase-recommendations.json` and a
  `## recommend-rebase` section in `action-plan.md`.

Not modified (deferred at the time):
- `examples/pr-housekeeping/workflow.edn` — no new node; the runtime stays
  safe. A real `:approval` gate node is documented here but **not wired**
  pending the approval runtime landing. The approval runtime has since landed
  in PR #44; wiring a real `:approval` node into the merge dogfood is now
  follow-up work.
- `src/tesseraft/runtime/core.clj` — no approval runtime work in this slice.
  (Approval runtime support has since landed in PR #44.)