# Manual script: run streaming (live SSE)

Audits the **browser-only** behavior of the Server-Sent Events streams that the
automated suite only checks at the HTTP/route level. Covers P0.4 surface #4
(run SSE) and the Pi-session stream portion of surface #8.

## Ground truth

- Streams:
  - `GET /api/runs/:runId/stream` → `text/event-stream; charset=utf-8`
    (implementation: `web/src-server/routes/api.ts`, handler ~line 808).
  - `GET /api/pi-sessions/:sessionId/stream` → `text/event-stream; charset=utf-8`
    (implementation: `web/src-server/routes/api.ts`, handler ~line 755).
- Run records (snapshot source of truth): `.agent-runs/<workflow>/<run-id>/`
  (see `docs/WORKFLOW_RUNS.md`).
- API contract: `docs/CONTROL_PLANE_API.md` (SSE snapshot stream section).
- Automated gate that already covers route/snapshot construction:
  `npm run web:test` → `test/web-server.test.js`, `test/web-pi-session.test.js`.

## Setup

```sh
cd "$(git rev-parse --show-toplevel)"
git rev-parse --short HEAD          # record this; server must serve this HEAD
npm run web:build
node web/dist-server/server.js --host 127.0.0.1 --port 5050 &
SERVER_PID=$!
# confirm banner:
#   Tesseraft web UI listening on http://127.0.0.1:5050
```

Open `http://127.0.0.1:5050/` in a browser. Keep DevTools → Network and Console
open.

## Procedure A — run SSE

1. In the Web UI, pick a workflow that supports `--executor mock` (or any
   workflow you can start). Start a run via the run controls.
2. Capture the `runId` from the UI Runs tab. Ground-truth it on disk:

   ```sh
   ls .agent-runs/<workflow>/
   cat .agent-runs/<workflow>/<runId>/state.json   # compare to what the UI shows
   ```

3. Select the run in the Runs tab and confirm the live stream panel renders. In
   DevTools → Network, find the `stream` request for this runId and confirm:
   - Request URL is `http://127.0.0.1:5050/api/runs/<runId>/stream`.
   - Response type is `text/event-stream; charset=utf-8`.
   - The EventSource connection stays open (no 4xx/5xx, no immediate close).
4. Step the run (or let it advance). Confirm the UI updates from SSE snapshots
   without a full page reload. Compare each visible state transition to
   `.agent-runs/<workflow>/<runId>/state.json`.

## Procedure B — Pi-session stream

1. Open the **Pi Sessions** tab and create a session (model resolution uses
   settings; typed-error behavior is already auto-covered by
   `test/web-pi-session.test.js`).
2. Capture the `sessionId`. Select it and confirm the events/stream panel
   renders. In DevTools → Network confirm an EventSource to
   `/api/pi-sessions/<sessionId>/stream` stays open.
3. Send a prompt to the session and confirm new events appear live in the UI
   without a page reload.

## Pass criteria

- Both `EventSource` connections open with `text/event-stream` and remain open
  through at least one state/event transition.
- UI state transitions match the ground-truth files on disk
  (`.agent-runs/<workflow>/<runId>/state.json` and Pi-session event records).
- No uncaught exceptions or failed-stream errors appear in the browser console.

## Fail criteria

- Stream request returns 4xx/5xx, closes immediately, or has a non-SSE
  content type.
- UI state diverges from the on-disk ground truth.
- Console shows errors during streaming.

## Teardown

```sh
kill $SERVER_PID
```
