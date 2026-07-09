# Web UI test coverage audit — manual testing index

This file is the **coverage-audit index** for roadmap item **P0.4** (CI/manual
testing coverage audit for Web UI surfaces). It maps every named surface to
either:

- an **automated gate** (`npm run web:test`) that already covers it, with an
  explicit skip rationale for manual testing, or
- a **focused, copy-paste-runnable manual script** under `manual-testing/` for
  browser-only behaviors the automated suite cannot assert.

## Ground truth

- Automated gate command: `npm run web:test` (defined in `package.json`; runs
  `web:build` then `node --test` over `test/web-server.test.js`,
  `test/web-pi-session.test.js`, `test/web-ui.test.js`,
  `test/web-studio.test.js`).
- Manual server seed (run from the repo root of the worktree under test):

  ```sh
  npm run web:build
  node web/dist-server/server.js --host 127.0.0.1 --port 5050
  # or: bin/tesseraft web --host 127.0.0.1 --port 5050
  ```

  The server logs `Tesseraft web UI listening on http://127.0.0.1:5050`.

- Authoritative files for behavior comparison:
  - Workflow packages: `.tesseraft/workflows/<name>/` (files are the source of
    truth; see `docs/SPEC.md`).
  - Local HTTP API contract: `docs/CONTROL_PLANE_API.md`.
  - API route implementations: `web/src-server/routes/api.ts`.
  - Server entrypoint/CLI: `web/src-server/server.ts`, `web/src-server/lib/cli.ts`.
  - Run records: `.agent-runs/<workflow>/<run-id>/` (see `docs/WORKFLOW_RUNS.md`).
  - Settings / git-user: `.tesseraft/git-user.json`, settings data referenced in
    `docs/CONTROL_PLANE_API.md`.

> **Stale-server hazard:** always start a fresh server bound to the **current
> worktree** and confirm `git rev-parse --short HEAD` matches before judging
> results. Do not reuse a long-running dev server from another worktree.

## Surface coverage map

| # | Surface | Automated coverage | Manual script |
|---|---|---|---|
| 1 | Local HTTP API: workflow discovery/detail/graph, runs list/detail, events/artifacts | ✅ `test/web-server.test.js` route mapping + control-plane fetches | — skip: HTTP behavior is auto-covered |
| 2 | Studio save/lint behavior (draft, completed lint-gate, lint route, bundled fallback) | ✅ `test/web-studio.test.js` (11 tests) | `studio-path-confinement-ux.md` (UI error surfaces only) |
| 3 | Path confinement: browse repo-rooted, asset traversal rejection, artifact unsafe paths | ✅ `test/web-server.test.js` browse + artifact unsafe-path tests; `test/web-studio.test.js` asset unsafe-path 400 | `studio-path-confinement-ux.md` (visible-error UX only) |
| 4 | Run streaming: SSE `GET /api/runs/:runId/stream` and Pi-session stream | ✅ route + snapshot construction in `test/web-server.test.js` / `test/web-pi-session.test.js` (HTTP-level) | `run-streaming.md` (live `EventSource` rendering in a browser) |
| 5 | Run controls: start / step / resume / delete (delete refuses executing runs) | ✅ `test/web-server.test.js` start/step/resume, approval, delete-run + DELETE route | `run-controls-ux.md` (clickable button flows + wizard modal) |
| 6 | Settings: read/write, masked tokens | ✅ `test/web-server.test.js` settings read/write + masked tokens | — skip: HTTP behavior is auto-covered |
| 7 | git-user: read/write | ✅ `test/web-server.test.js` git-user read and write | — skip: HTTP behavior is auto-covered |
| 8 | Pi sessions: list/create/detail/prompts/events/stream; settings→model resolution + typed errors | ✅ `test/web-server.test.js` fake Pi session routes; `test/web-pi-session.test.js` resolveSettingsModel/createSessionWithModel; `test/web-server.test.js` POST resolution-failure 400 | `run-streaming.md` (Pi-session live stream only) |

**Conclusion:** Every named surface has automated HTTP/structural coverage.
The real gaps are **browser/DOM-only behaviors** that
`renderToStaticMarkup` tests cannot assert: live SSE rendering, responsive
layout wrap, browser console errors, and interactive run-control button flows.
Those are covered by the four focused scripts below.

## Focused manual scripts (browser-only surfaces)

- [`run-streaming.md`](run-streaming.md) — live SSE rendering for a run and a
  Pi session via `EventSource`.
- [`run-controls-ux.md`](run-controls-ux.md) — start/step/resume/delete button
  flows, `StartWorkflowWizard` modal, and delete-refuses-executing UX.
- [`responsive-console.md`](responsive-console.md) — mobile/narrow viewport
  wrap + DevTools console error check (supersedes the prior UX-simplification
  checklist, preserved here).
- [`studio-path-confinement-ux.md`](studio-path-confinement-ux.md) — Studio
  save/lint and asset/path-traversal refusal messages surfaced visibly in the
  UI (HTTP behavior is auto-covered; this is the visible-error UX).

Each script is copy-paste runnable, starts a fresh server, states the
ground-truth command/file to compare against, and lists explicit pass/fail
criteria.
