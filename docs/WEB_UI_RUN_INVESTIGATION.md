# Web UI run-control investigation — findings

> **Status: RESOLVED (as of `main` `ffbf06e`, 2026-07-07).** All five
> reported bugs (Findings 1–5) have been fixed on `main`; the positive
> (Finding 6) remains. This document is retained as a historical record of
> the investigation and the fixes it prompted. See the per-finding
> "Resolved" notes below for code references.
>
> Summary of resolutions:
> - F1 (max_steps orphans next node) → `run-until-done!` now parks before
>   starting a node when `(>= n max-steps)` (`src/tesseraft/runtime/core.clj`).
> - F2 (step re-runs orphaned node) → `step!` calls
>   `orphaned-current-attempt?` → `orphan-run!` (fail-fast `node.orphaned`)
>   instead of re-running (`src/tesseraft/runtime/core.clj`).
> - F3 (Web UI never surfaces orphans) → control-plane `derive-liveness`
>   (`src/tesseraft/control_plane/core.clj`) + Web UI liveness/staleness
>   pills and `FailureSummary` (`web/src/components/Run{ListTable,Inspection,Panels}.tsx`).
> - F4 (dead running runs never reconciled) → `derive-liveness` marks
>   stale/orphaned on every read; Runs list surfaces and offers deletion.
> - F5 (running status overloaded) → `derive-liveness` splits
>   `parked` / `executing` / `orphaned` / `stale`.
>
> The original findings follow unchanged, for history.

Investigation goal: surface issues in the Tesseraft Web UI when actually using it
to **run/observe** the system (not to ship a feature). Method: drove a real
`review-loop` run through the Web UI with `agent-browser`, stepping node-by-node
and comparing the Web UI's presentation against the CLI control-plane ground truth.

Run: `wui-node-insp-1` (review-loop), branch `feature/webui-run-investigation`.
Ground truth via `bin/tesseraft control-plane run <id>` + `.agent-runs/.../events.jsonl`.

## Findings

### 1. "Start and run" with `max_steps` orphans the next node  (HIGH)

`POST /api/runs` (the "Start and run" button) runs `start` then a background
`resume --max-steps N`. With `max_steps=1`, the resume executed `collect-prompt`
(1 step, finished), **then started `design` and immediately exited on its step
budget**, killing the launched `pi` child. Result: `design` had `node.started`
but **no `node.finished`**, no live `pi` process, and the node was left
permanently "running".

Evidence (`events.jsonl`):
```
node.started  design  attempt 2  06:20:11.397   ← from "Start and run"
(no node.finished)
node.started  design  attempt 2  06:22:35.132   ← only after a manual `step`
node.finished design  attempt 2  06:24:54.184   status pass
```
The `pi --approve` process was gone within seconds of the 06:20:11 start, yet
the node stayed "running" for 2+ minutes until a human re-stepped.

Likely cause: the resume process exits on step budget after *starting* the next
node, and process-group teardown kills the spawned agent child. The budget
should be checked before launching a node, not after.

### 2. `step` on an orphaned "running" node re-runs it from scratch  (MEDIUM)

Stepping a node stuck in "running" does **not** detect the orphan, fail fast,
or resume. It re-runs the node, producing a **duplicate `node.started` for the
same attempt** (06:22:35, same attempt 2 as the orphan). This time the `pi`
child survived the parent `step` process being killed and completed, so it
"recovered" — but by silently re-doing the work and duplicating events, which
corrupts the proof trace (two starts, one finish for one attempt).

### 3. The Web UI never surfaces an orphaned node  (HIGH)

While `design` was orphaned (06:20 → 06:22), the Web UI showed the run as
healthy: header `Run wui-node-insp-1 · running`, `Streaming · 09:20:11`
(frozen timestamp, no updates), no error/warning badge. A user cannot tell that
the run is stuck — it looks identical to a run that is actively executing a
long node. There is no liveness/staleness signal (e.g. "no events for Ns",
"node process not found", "stream heartbeat stale").

### 4. Stale "running" runs accumulate and are never reconciled  (MEDIUM)

The Runs list shows many runs from past sessions marked `running` that are
actually dead, e.g. `prompt-collect-test`, `local-web-ui-react-graph`,
`manual-testing-resource-contracts`, `mock-step`. The Web UI/control plane never
detects that a run's node process is gone and never marks such runs
`failed`/`stale`. They persist indefinitely as `running`, polluting the list
and misleading the user.

### 5. `running` status is overloaded  (LOW/MEDIUM)

A run **parked awaiting the next step** (no live process, node not started)
shows `status: running`, indistinguishable from a run **actively executing a
node**. After `design` finished and the run transitioned to `ensure-worktree`
(parked, no process), the Run detail still showed `Status: running`. A distinct
state (e.g. `parked` / `awaiting-step`) would disambiguate.

### 6. "Issues to inspect → Issues artifact present" is a good signal  (POSITIVE)

The Run detail surfaces `Issues artifact present` as a clickable inspection
prompt. This is a useful, contract-backed nudge. (Minor: the issues artifact
was empty `[]` in this run, yet the prompt still appeared — consider showing
the issue count.)

## What works

- "Start and run" **does** create the run and execute the first safe node.
- The Web UI **"Step one node" button** works: it advanced `ensure-worktree`
  → `execute` and the Run detail auto-refreshed (09:26:48) to show the new
  state/attempt. The run-control surface is genuinely functional.
- The **Attempt timeline** in Run detail is informative: per-attempt status,
  start/finish timestamps, `Next:` transition, and the full result JSON. This
  is the strongest part of the Run Console.
- **Auto-refresh** is active and updates the detail on step completion.

## Tooling note (not a Web UI bug)

`agent-browser` does not support Playwright-style pseudo-selectors
(`button:has-text('review-loop')` → "Element not found"). Use `@ref` from
`snapshot -i`. Documented here so future browser-driven tests use refs.

## Suggested follow-ups (not implemented)

1. Runner: check step budget **before** launching a node so `max_steps` never
   orphans an in-flight node; if a node is already running on budget exit,
   let it finish or record an explicit `node.orphaned` event.
2. Runner: `step` on a node already in `running` should detect the orphan
   (no live child / stale started_at) and either resume-with-proof or fail
   fast — not silently re-run and duplicate `node.started`.
3. Web UI: add a liveness/staleness signal — "no events for Ns", "stream
   heartbeat stale", or "node process not found" — and surface orphaned runs.
4. Web UI/control plane: reconcile dead `running` runs to `failed`/`stale`
   on load (e.g. node `started_at` with no `finished_at` and no live process).
5. Web UI: distinguish `parked`/`awaiting-step` from `executing` in run status.
