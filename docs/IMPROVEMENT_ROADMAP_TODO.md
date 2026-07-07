# Tesseraft Improvement Roadmap — Review-Loop TODO

Source: `~/Downloads/tesseraft-improvement-design-v2.md` §4 (Revised improvement plan).
Decomposition date: 2026-07-06.

> **Status snapshot: `main` `ffbf06e`, 2026-07-07.** Reconciled against the
> merged history. Items below are marked inline with their current state:
>
> - **P0.1-a — CI (#3, #60): DONE.** GitHub Actions CI on `main` runs `bb
>   test`, `npm run web:test`, the container harness, and node lint
>   (`.github/workflows/ci.yml`).
> - **P0.1-b — Mock executor (#8): OPEN.** PR #8 not merged; not on `main`.
> - **P0.1-c — Container install (#37): DONE.** Merged (`f47df01`);
>   `scripts/install.sh`, `Dockerfile`, `test/container` on `main`.
> - **P0.1-d — Docs/example PRs (#40): DONE (#40 merged); #57 not in recent
>   history — verify if still relevant.**
> - **P0.1-e — Approval/manual-input stack (#44): OPEN.** PR #44 not merged;
>   no approval/`manual-input` code on `main`.
> - **P0.2 — STATUS.edn: OPEN.** PR #59 open; no `STATUS.edn` on `main`.
> - **P0.3 — Merge protocol: PARTIAL.** `docs/MERGE_PROTOCOL.md` authored on
>   `docs/merge-protocol` (PR #58 open, not merged to `main`).
> - **P2.3 — Run index: DEFERRED** (unchanged).
>
> Before running any item as a review-loop, re-check its PR state; several
> P0 items tracked as “todo” above are already merged and would be no-ops.

## How to use this document

Each item below is a **review-loop-implementable prompt**: a self-contained task
description sized to be passed as the `:prompt` input to
`examples/review-loop/workflow.edn` (or `prompt-to-pr` for items without a
review-fix loop). The review-loop workflow will then produce a design doc,
isolated worktree, implementation, explicit pass/fail review artifact, retry
loop, and PR.

Run a single item:

```bash
./bin/tesseraft run start examples/review-loop/workflow.edn \
  --run-id <item-id> \
  --input prompt='<paste the Prompt block>' \
  --input repo-root=. \
  --input base-branch=main \
  --format json
```

### Conventions

- **ID** — stable slug used as `--run-id` and branch prefix.
- **Depends on** — items that must merge before this one can start.
- **Parallelizable with** — items that can run concurrently in separate
  worktrees without merge conflicts. "Group N" marks a parallel set.
- **Workflow** — `review-loop` (default) or `prompt-to-pr` (no review loop) or
  `pr-housekeeping` (read-only report).
- **Side effects** — notes on GitHub/branch/web-server impact.
- **Governance note** — flags items that touch committed workflow definition
  files (`.tesseraft/workflows/**`, `examples/**/workflow.edn`), which the
  `:runtime-cannot-edit-workflow` policy forbids agent runs from editing. These
  require a human-authored (or human-approved authoring-session) change.

### Dependency graph (summary)

```
P0.1-a CI (#3) ──┬──> P0.1-b mock executor (#8) ──> P1.3 golden conformance
                  ├──> P0.1-c container (#37) ─────> P3.1 container quickstart
                  └──> P0.1-e approval stack (#44) ─┬──> P1.4 concurrency test
                                                  └──> P2.1 wire N2 (governance)

Parallel groups (no shared files):
  Group A (infra/config, mutually parallel): P0.1-a, P0.2, P0.3, P1.1, P1.2
  Group B (after #8): P1.3
  Group C (after #44): P1.4, P2.1(governance), P2.2
  Group D (outward, mostly parallel after #37): P3.1, P3.2, P3.3, P3.4
```

---

## P0 — Convert the queue into trust (≈1 week, mostly merges)

### P0.1-a  Land CI on main (PR #3)
- **Workflow:** review-loop
- **Depends on:** —
- **Parallelizable with:** P0.2, P0.3, P1.1, P1.2 (Group A) — different file
  sets; CI config vs docs vs web routing vs lint config.
- **Side effects:** adds `.github/workflows/*`; no runtime change.
- **Prompt:**
  > Add a GitHub Actions CI workflow on `main` for the Tesseraft repo. The job
  > must run `bb test`, `npm run web:test`, the container harness from PR #37
  > (if present, else skip with a TODO), and `./bin/tesseraft node lint
  > .tesseraft/nodes/*`. Gate all merges on CI green. Rebase PR #3 onto current
  > `main`, resolve drift, and ensure the workflow triggers on push to main and
  > on pull_request. Emit a `design/status.json` with status pass/fail.

### P0.1-b  Rebase and merge mock executor (PR #8)
- **Workflow:** review-loop
- **Depends on:** P0.1-a (CI must exist to validate the rebase).
- **Parallelizable with:** P0.2, P0.3, P1.1, P1.2 (Group A) — touches runtime
  executor code, disjoint from docs/web/lint-config.
- **Side effects:** adds `--executor mock` / `--mode mock` flags, mock handlers;
  no GitHub side effects.
- **Prompt:**
  > Rebase PR #8 (mock executor) onto current `main`. Preserve the existing
  > `--executor mock` / `--mode mock` flags, executor-mode persistence in run
  > state, the mock agent executor that renders prompts and writes declared
  > artifacts with deterministic placeholder content, and mock handlers for
  > Jira, Git, GitHub, Pinga, and noop. Add a CI job that runs every example
  > workflow under `examples/**/workflow.edn` in mock mode to `state=done`, so
  > the examples become executable conformance tests. Resolve any merge
  > conflicts with the 10 days of drift since Jun 27. Keep `bb test` green.

### P0.1-c  Land container install + Dockerfile (PR #37)
- **Workflow:** review-loop
- **Depends on:** P0.1-a (CI to run the harness as a job).
- **Parallelizable with:** P0.2, P0.3, P1.1, P1.2 (Group A) — touches
  `scripts/install.sh`, `Dockerfile`, `.dockerignore`, `docs/CONTAINER_INSTALL.md`,
  `test/container`; disjoint from runtime/web/lint-config.
- **Side effects:** none (build-only).
- **Prompt:**
  > Rebase and merge PR #37. Preserve `scripts/install.sh` (sha256-verified
  > Babashka binary, amd64/aarch64, idempotent, `--core-only`/`--install-node`
  > tiers), the canonical `Dockerfile`
  > (`node:22-bookworm-slim` + `openjdk-17-jre-headless` + pre-warmed bb
  > classpath), `.dockerignore`, `docs/CONTAINER_INSTALL.md`, and the tracked
  > container test harness (8 checks). Wire the container harness as a nightly
  > CI job. Confirm agent credentials are excluded from the image and mounted
  > at `docker run`.

### P0.1-d  Merge docs/example PRs (#40, #57)
- **Workflow:** prompt-to-pr (no review loop needed; trivial)
- **Depends on:** P0.1-a.
- **Parallelizable with:** everything in Group A and the #8/#37 rebases.
- **Side effects:** docs only.
- **Prompt:**
  > Rebase and merge PRs #40 and #57 (documentation and example additions).
  > Resolve any drift against current `main`. No runtime changes. Ensure `bb
  > test` and `npm run web:test` remain green.

### P0.1-e  Land approval/annotation stack (PR #44)
- **Workflow:** review-loop
- **Depends on:** P0.1-a (CI must gate this large PR), and review after
  P0.1-b/P0.1-c to avoid rebase collisions on runtime + control plane + web.
- **Parallelizable with:** P0.2, P0.3, P1.1, P1.2 (Group A) conceptually, but
  recommended sequenced after b/c due to broad file overlap. Not parallel with
  P1.1 (both touch `web/server.js` routing).
- **Side effects:** runtime + control plane + web changes; no GitHub mutations.
- **Prompt:**
  > Rebase and merge PR #44 (approval node + annotation/comment loop). Preserve
  > `step-approval!`/`decide!`/`run-until-done!` semantics, the `blocked` run
  > state, approval-request records, `approval.requested`/`approval.decided`
  > events, run-relative JSON approval/comment artifacts, and the Express
  > routes `POST /runs/:id/approvals/:approval-id` and `POST .../comments`
  > registered before the `/:operation` wildcard. Keep the regression tests
  > (two-comment path, 409-on-replay, traversal-safe path normalization).
  > Do NOT wire the `:manual-input` node into `examples/review-loop/workflow.edn`
  > in this PR — that is a governance-gated change tracked as P2.1.

### P0.2  Status truthfulness via STATUS.edn
- **Workflow:** review-loop
- **Depends on:** —
- **Parallelizable with:** all of Group A.
- **Side effects:** docs/scripts only.
- **Prompt:**
  > Make the README status section truthful and generated. Add a
  > CI-checked `STATUS.edn` at repo root describing actual capabilities
  > (node-packaging system, Pinga handler, `blocked` run state, recovery tests,
  > routeApi architecture, mock executor, container install). Update the PR
  > packet template so agent-authored PRs emit a `STATUS.edn` diff in the same
  > commit. Regenerate the README status section from `STATUS.edn`. Document
  > the generation step in `docs/`.

### P0.3  Define and dogfood the merge protocol
- **Workflow:** pr-housekeeping (read-only report) → human merge decision
- **Depends on:** —
- **Parallelizable with:** all of Group A.
- **Side effects:** none (report only).
- **Prompt:**
  > Author `docs/MERGE_PROTOCOL.md` defining the merge rule: "CI green + one
  > human approval-node decision = merge; PRs older than 5 days are rebased
  > automatically by a pr-housekeeping run." Add a `pr-housekeeping` workflow
  > variant (or input) that classifies open PRs by age and mergeability and
  > emits a rebase recommendation report without mutating GitHub state. This
  > dogfoods the approval node on Tesseraft's own PR queue.

---

## P1 — Structural defenses against observed bug classes (1–3 weeks)

### P1.1  Kill the route-ordering hazard (operation table)
- **Workflow:** review-loop
- **Depends on:** — (independent); do not run concurrently with P0.1-e (shared
  `web/server.js` routing).
- **Parallelizable with:** P0.2, P0.3, P1.2, P1.3(after #8), P1.4(after #44).
- **Side effects:** web server routing refactor; no GitHub mutations.
- **Prompt:**
  > Replace the implicit "specific-before-wildcard" Express route registration
  > in `web/server.js` with a single declarative operation table: a map of
  > `{method, path, control-plane-op, mutating?}` from which Express routes are
  > generated in guaranteed order. Generate the matching CLI subcommands from
  > the same table so CLI ↔ HTTP endpoints stay one-to-one. Add a test
  > asserting every declared endpoint resolves to its own handler (not the
  > `/:operation` wildcard) and that unknown operations return 404. Emit an
  > OpenAPI contract from the table. Keep `npm run web:test` green.

### P1.2  Mechanical lint for silent-failure classes
- **Workflow:** review-loop
- **Depends on:** —
- **Parallelizable with:** all of Group A.
- **Side effects:** lint config + CI; no runtime change.
- **Prompt:**
  > Add mechanical defenses targeted at this codebase's observed bug classes.
  > Clojure side: add `clj-kondo` to CI with warnings-as-errors (it flags the
  > `(when cond a b)` misuse from PR #44 bug 1), plus a convention or kondo
  > hook that option maps are threaded whole rather than reconstructed (bug 2:
  > `resolve-run` dropping `:runs-root`/`:workflow-roots`/`:tesseraft-home`).
  > TypeScript side: set `strict: true`, `noUncheckedIndexedAccess`, and
  > enforce exhaustive deps. Wire all of the above into the CI job from P0.1-a.

### P1.3  Golden event-log conformance suite
- **Workflow:** review-loop
- **Depends on:** P0.1-b (mock executor must be merged to capture mock runs).
- **Parallelizable with:** P1.1, P1.2, P2.2 — disjoint file sets.
- **Side effects:** test fixtures only.
- **Prompt:**
  > Capture the JSONL event log (`events.jsonl`) of each example workflow run
  > in mock mode to `state=done` as golden files under
  > `test/fixtures/golden/<workflow>.events.jsonl`. Add a CI job that runs each
  > example in mock mode and diffs the resulting event log against the golden
  > file, normalizing timestamps and ids. The suite must pin `blocked`,
  > `approval.requested`/`approval.decided`, and pass/fail-vs-error transitions
  > against SPEC §13/§17. Add at least one deliberately-mutated log fixture
  > that fails the diff to prove the suite catches regressions.

### P1.4  Concurrency test for decide + resume
- **Workflow:** review-loop
- **Depends on:** P0.1-e (approval/`decide!` machinery must be merged).
- **Parallelizable with:** P1.1, P1.2, P1.3, P2.2 — disjoint.
- **Side effects:** test only.
- **Prompt:**
  > Add a stress test for concurrent `decide!` + `resume` against one blocked
  > run. Spawn N concurrent decides plus a concurrent resume on a single
  > `blocked` run and assert exactly one `approval.decided` event lands in the
  > event log; all other callers receive 409-on-replay. If the invariant does
  > not hold, add file locking or a per-run single-writer lock in
  > `src/tesseraft/runtime/core.clj`. Document the invariant in
  > `docs/CONTROL_PLANE_API.md`.

---

## P2 — Close the loop (2–6 weeks)

### P2.1  Land #44 wiring and resolve N2 (governance-gated)
- **Workflow:** human-authored authoring session (NOT an agent review-loop run,
  due to `:runtime-cannot-edit-workflow`).
- **Depends on:** P0.1-e (approval node merged), P0.1-a (CI).
- **Parallelizable with:** P2.2, P2.3.
- **Governance note:** This item edits a committed workflow definition file
  (`examples/review-loop/workflow.edn`). It MUST be authored by a human or a
  human-approved authoring session, then reviewed via an approval node. An
  agent runtime run must not perform this edit.
- **Side effects:** workflow definition change.
- **Prompt (for the human authoring session, not an agent runtime run):**
  > Insert the `:manual-input` approval node into
  > `examples/review-loop/workflow.edn` between `review` (pass) and `pr-draft`,
  > wiring the approval decision as the gate before PR drafting. Use the
  > `.tesseraft/nodes/manual-input/node.edn` package. Document this change in
  > `docs/WORKFLOW_RUNS.md` as the canonical example of the
  > authoring/runtime boundary: the workflow edit is human-authored and
  > reviewed via an approval node, while the runtime that enforces the boundary
  > is itself agent-built.

### P2.2  Minimal auth before non-localhost exposure
- **Workflow:** review-loop
- **Depends on:** P1.1 (auth checked at the operation table so it cannot be
  forgotten per-route).
- **Parallelizable with:** P1.3, P1.4, P2.1, P3.* — disjoint.
- **Side effects:** control-plane + web auth; no GitHub mutations.
- **Prompt:**
  > Add bearer-token capability auth per SPEC's capability model, scoped to
  > `{run-id, approval-id}`, checked at the operation table from P1.1 so it
  > cannot be forgotten per-route. Cover all mutating operations
  > (`approvals/:id/decide`, `comments add`, `resume`). Keep the current
  > `.tesseraft/git-user.json` identity as the localhost-default fallback but
  > require a bearer token for any non-localhost bind. Add tests for
  > unauthenticated-mutating-write rejection and for capability-scope
  > overflow. Document the auth model in `docs/CONTROL_PLANE_API.md`.

### P2.3  Run index (DEFERRED)
- **Workflow:** —
- **Depends on:** —
- **Parallelizable with:** —
- **Status:** Deferred per v2 §4. The file-backed run-relative-artifact model
  is coherent, tested, and philosophically central. Do NOT build a SQLite index
  until list/query latency across many runs actually hurts; when it does, build
  it strictly as a rebuildable cache over the files.
- **Prompt (only when latency evidence exists):**
  > Add a rebuildable SQLite run index as a cache over the file-backed run
  > state under `.agent-runs/`. The index must be fully reconstructable from
  > the files and must not become a source of truth. Add a rebuild command to
  > `bin/tesseraft control-plane`. Include a test that deletes the index and
  > rebuilds it, asserting equivalence.

---

## P3 — Outward-facing (reordered, mostly parallel)

### P3.1  Container quickstart as the front door
- **Workflow:** prompt-to-pr
- **Depends on:** P0.1-c (container PR merged).
- **Parallelizable with:** P3.2, P3.3, P3.4.
- **Side effects:** docs only.
- **Prompt:**
  > Promote the container quickstart from PR #37 to the front-door install
  > path in `README.md`. Replace the local `check_deps.sh`-centric quick start
  > with a `docker run` quick start as the primary path, keeping the local
  > path as a fallback. Add a `docs/QUICKSTART_CONTAINER.md` with copy-paste
  > commands. Ensure the container harness from P0.1-c is the CI job that
  > keeps this path honest.

### P3.2  JSON authoring converter
- **Workflow:** review-loop
- **Depends on:** —
- **Parallelizable with:** P3.1, P3.3, P3.4.
- **Side effects:** new tooling; no GitHub mutations.
- **Prompt:**
  > Add a `bin/tesseraft convert` subcommand that converts JSON workflow
  > definitions to the EDN format used by the linter/runner, and vice versa,
  > preserving the SPEC §contracts. The converter must round-trip losslessly
  > for the existing example workflows. Add lint-after-convert round-trip
  > tests for every `examples/**/workflow.edn`.

### P3.3  Second agent executor (de-Pi-ify §18 protocol)
- **Workflow:** review-loop
- **Depends on:** P0.1-b (mock executor provides the executor-mode plumbing).
- **Parallelizable with:** P3.1, P3.2, P3.4.
- **Side effects:** new executor; no GitHub mutations.
- **Prompt:**
  > Add a second agent executor alongside `:pi-cli` in
  > `src/tesseraft/executors/` that implements the SPEC §18 agent protocol
  > without depending on the Pi CLI (e.g., a plain subprocess or HTTP-based
  > executor). Wire it as `:executor <name>` with the same
  > status/artifact contract. Add a CI job running the review-loop workflow
  > end-to-end with the new executor in mock-prompt mode.

### P3.4  Positioning write-up (the repo is the case study)
- **Workflow:** prompt-to-pr
- **Depends on:** —
- **Parallelizable with:** P3.1, P3.2, P3.3.
- **Side effects:** docs only.
- **Prompt:**
  > Author `docs/POSITIONING.md` (and a top-level `README.md` section) framing
  > Tesseraft's differentiator as: the tool's own repository is the case study
  > — 45+ agent-built PRs, every workflow-definition edit blocked by policy,
  > every artifact reconstructable from files, CI as the trust boundary for
  > bot-authored commits. Use §1 of `tesseraft-improvement-design-v2.md` as
  > the strongest source material. Keep claims verifiable against the repo.

---

## Parallelism summary

| Group | Items | Can run concurrently? | Reason |
|---|---|---|---|
| A | P0.1-a, P0.2, P0.3, P1.1, P1.2 | Yes (mind P0.1-e vs P1.1 web overlap) | Disjoint file domains: CI config / docs / merge-protocol / web routing / lint config |
| A+b | + P0.1-b | Yes within group A; touches runtime executor code | Disjoint from docs/web/lint-config |
| A+c | + P0.1-c | Yes within group A | Disjoint: scripts/Dockerfile/container tests |
| — | P0.1-d | Yes with all of A | Docs only |
| — | P0.1-e | Sequence after b,c; NOT parallel with P1.1 | Broad overlap: runtime + control plane + web routing |
| B | P1.3 | After P0.1-b; parallel with P1.1, P1.2, P2.2 | Test fixtures only |
| C | P1.4, P2.2 | After P0.1-e / P1.1; parallel with each other | Disjoint: test vs auth code |
| C-gov | P2.1 | After P0.1-e; governance-gated, not an agent run | Edits workflow definition |
| D | P3.1, P3.2, P3.3, P3.4 | Mostly yes; P3.1 after P0.1-c, P3.3 after P0.1-b | Disjoint outward-facing tracks |
| — | P2.3 | Deferred | No work until latency evidence |

### Hard ordering constraints (do not violate)
1. CI (P0.1-a) before any other code merge — it is the trust boundary.
2. Mock executor (P0.1-b) before P1.3 (golden suite) and P3.3 (second executor).
3. Container (P0.1-c) before P3.1 (container quickstart).
4. Approval stack (P0.1-e) before P1.4 (concurrency test) and P2.1 (N2 wiring).
5. Operation table (P1.1) before P2.2 (auth checked at the table).
6. P2.1 is governance-gated: a human/authored session, not an agent runtime run.

### Soft ordering (recommended to avoid rebase pain)
- Land P0.1-b and P0.1-c before P0.1-e (less drift to resolve on the big PR).
- Run P1.1 after P0.1-e merges, or carefully coordinate the shared
  `web/server.js` routing region.
