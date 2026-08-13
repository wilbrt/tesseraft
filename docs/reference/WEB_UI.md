# Web UI reference

Status: Implemented local console

The Web UI provides five local surfaces:

- **Workflows** — project-scoped discovery, normalized details, graph, scope, and shadowing.
- **Runs** — durable run list/detail, attempts, events, artifacts, comments, start/step/resume/cancel/delete controls, and SSE refresh.
- **Approvals** — a project-wide pending queue and full-page, context-first decision workspace. Review evidence gets the primary area; diffs support line annotations, decisions support an overall message, and the reviewer can resume the run immediately.
- **Studio** — semantic draft editing, capability-driven node forms, lint, confined asset editing, and Clojure-owned completed save.
- **Settings** — portable project configuration, code-host/work-tracker connections, user preferences, Git identity, and Connections Doctor.

Pi Sessions is a separate local chat surface backed by the configured Pi adapter. The fake adapter is enabled only with `TESSERAFT_PI_ADAPTER=fake`.

## Build and start

```bash
npm run build:web
node web/server.js --host 127.0.0.1 --port 7341
```

The server serves production assets and `/api/*` from one process. It is a trusted local tool with mutation and process-launch capabilities; do not expose it remotely without adding an authentication boundary. Non-loopback binds require `--acknowledge-remote-exposure`.

## Project scope

The project selector stores only the selected project ID in browser storage. Every feature request uses `/api/projects/{id}/...`. Portable configuration remains in `.tesseraft/project.json`; user stores and run directories remain authoritative after refresh or browser closure.

An approval is actionable only when its durable request matches the run's
current blocked state and attempt and no decision record exists. Merely finding
an approval node in a workflow, or a stale request from an earlier attempt, is
not enough to place it in the inbox.

## Capabilities and semantic drafts

`GET /api/capabilities` drives handler, executor, provider, availability, and deprecation choices. Browser values use ordinary strings such as `agent`, `success`, and `work-tracker/fetch-item`. The browser never emits EDN; completed Studio saves cross the Clojure workflow service.

## Errors and live updates

The shared `requestJson` client parses the stable error envelope, handles aborts and empty bodies, and propagates request IDs. Run and Pi session streams use SSE snapshots; durable event logs remain the runtime authority.

See the [architecture decision](../architecture/WEB_UI_ARCHITECTURE.md), [use cases](../guides/WEB_UI_USE_CASES.md), and [HTTP API](CONTROL_PLANE_API.md).
