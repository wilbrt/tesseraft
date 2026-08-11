# Web UI manual coverage index

Deterministic behavior belongs to the automated task graph in [`docs/testing/TESTING.md`](../docs/testing/TESTING.md). Manual checks add human judgment only.

| Procedure | Human judgment retained |
| --- | --- |
| [`responsive-console.md`](responsive-console.md) | hierarchy, wrapping, readability, and visible keyboard focus |
| [`run-controls-ux.md`](run-controls-ux.md) | destructive-action clarity and recovery affordances |
| [`run-streaming.md`](run-streaming.md) | perceived live-update continuity and comprehensibility |
| [`studio-path-confinement-ux.md`](studio-path-confinement-ux.md) | clarity of lint/save/path refusal messages |
| [`connections-doctor.md`](connections-doctor.md) | remediation quality and secret-safe presentation |

The corresponding API, persistence, reducer, and path-confinement contracts run under `npm run test:web`, `npm run test:node`, `bb test:runtime`, and Playwright. Start a fresh server from the worktree under review; do not reuse another worktree’s process.
