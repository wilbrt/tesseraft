# Web UI architecture

Status: Accepted
Decision date: 2026-08-10
Supersedes: Draft architecture matrix and manual API mapper
Superseded by: —

## Decision

Tesseraft’s browser is a local console over the canonical control plane and runtime. It is not a workflow, project, or execution authority.

```text
React features
  -> typed requestJson client
  -> Express domain routers
  -> structured Clojure application operations
  -> descriptors, user stores, workflow packages, run directories
```

## Boundaries

- `web/src/App.tsx` owns layout and feature composition.
- Feature hooks own selection, reads, SSE lifecycles, and presentation state.
- The Studio reducer owns a semantic TypeScript draft. It contains no EDN keywords or serialization rules.
- Clojure validates and serializes completed workflow packages.
- Capability choices are loaded from `/api/capabilities`; the browser does not maintain handler, executor, or provider registries.
- Express routers own HTTP validation and response mapping. Application services own domain validation and durable writes.
- All feature requests use `/api/projects/{id}/...`; unscoped routes exist only as marked compatibility delegates.

## Local trust model

The Web server defaults to `127.0.0.1`. It may execute configured local tools and mutate project/run state, so it is not suitable for unauthenticated remote exposure. Non-loopback binding requires an explicit acknowledgement flag. Filesystem browsing and browser project registration are confined to configured canonical roots.

## Structure

```text
web/src/features/       feature state, composition, and styles
web/src/components/     shared focused UI components
web/src/lib/            transport and pure shared helpers
web/src-server/routes/  Express domain routers
web/src-server/lib/     process, HTTP, path, and persistence edges
```

See the [Web UI reference](../reference/WEB_UI.md), [use cases](../guides/WEB_UI_USE_CASES.md), and [control-plane API](../reference/CONTROL_PLANE_API.md).
