# Manual script: Studio save/lint + path-confinement visible-error UX

Audits the **visible-error UX** in the Workflow Studio for save/lint and
path-confinement failures. The underlying HTTP behavior is already auto-covered
by `test/web-studio.test.js` (save modes, lint gate, bundled fallback, asset
unsafe-path 400) and `test/web-server.test.js` (browse + artifact unsafe-path
rejection). This script verifies those failures are surfaced **readably in the
browser**.

## Ground truth

- Studio routes (implementation: `web/src-server/routes/api.ts`):
  - `POST /api/studio/workflows` — create draft (~line 770).
  - `GET /api/studio/workflows/:name` — read + bundled fallback (~line 771).
  - `PUT /api/studio/workflows/:name` — `save_mode=draft` (non-blocking lint) /
    `save_mode=completed` (lint gate) (~line 776).
  - `POST /api/studio/workflows/:name/lint` — lint report (~line 781).
  - `GET/PUT /api/studio/workflows/:name/assets/*assetPath` — asset round-trip;
    rejects unsafe paths with 400 (~lines 788/797).
- Workflow package files (source of truth): `.tesseraft/workflows/<name>/`
  (see `docs/SPEC.md`).
- Lint contract: `schemas/lint-result.schema.json`, `docs/LINTER.md`.
- Asset path regex (confinement): `ASSET_PATH_RE` in `web/src-server/routes/api.ts`
  (~line 268): `^[A-Za-z0-9][A-Za-z0-9._/-]*\.(md\.tmpl|md|tmpl|txt)$`.
- Browse confinement: `GET /api/browse` repo-rooted, rejects escapes
  (`test/web-server.test.js`).
- Artifact unsafe-path rejection: control-plane artifact reads reject unsafe
  paths (`test/web-server.test.js`).
- Automated gate: `npm run web:test` → `test/web-studio.test.js`,
  `test/web-server.test.js`.

## Setup

```sh
cd "$(git rev-parse --show-toplevel)"
git rev-parse --short HEAD          # server must serve this HEAD
npm run web:build
node web/dist-server/server.js --host 127.0.0.1 --port 5050 &
SERVER_PID=$!
```

Open `http://127.0.0.1:5050/` in a browser with DevTools → Network and Console
open. Navigate to the Workflow Studio.

## Procedure A — create + draft save (non-blocking lint)

1. Create a new draft workflow in Studio. Confirm the package directory appears:

   ```sh
   ls .tesseraft/workflows/<name>/
   cat .tesseraft/workflows/<name>/workflow.edn
   ```

2. Save with `save_mode=draft`. Confirm the UI persists the draft and shows the
   lint report as **non-blocking** (warnings/errors visible but save succeeds).
   Compare the on-screen lint diagnostics to the linter output:

   ```sh
   bin/tesseraft lint .tesseraft/workflows/<name>/workflow.edn
   ```

## Procedure B — completed save lint gate

1. Edit the workflow to be invalid (e.g. remove a required field).
2. Save with `save_mode=completed`. Confirm the UI **blocks** the save and
   surfaces the lint errors clearly (status 422 + diagnostics). Confirm the
   on-disk file is **not** updated to a completed state.
3. Fix the workflow and save completed again. Confirm it persists and is marked
   completed; compare to `bin/tesseraft lint` (must pass).

## Procedure C — lint route + bundled fallback

1. Trigger the explicit lint action in the UI and confirm the displayed report
   matches `bin/tesseraft lint .tesseraft/workflows/<name>/workflow.edn`.
2. Request a workflow name that has no project package. Confirm the UI falls
   back to the bundled example workflow (GET returns bundled data; ground-truth:
   the examples bundled in the server / `examples/`).

## Procedure D — asset path confinement visible error

1. In Studio, attempt to save an asset with a traversal path such as
   `../../etc/passwd.md` (or any path that fails `ASSET_PATH_RE`). Confirm the
   UI surfaces a clear **400** error and does not write outside the package dir.
2. Verify on disk that nothing was written outside `.tesseraft/workflows/<name>/`:

   ```sh
   find .tesseraft/workflows/<name>/ -type f
   ```

3. Round-trip a valid asset (e.g. `prompts/foo.md`) and confirm the UI reads it
   back identically; ground-truth:
   `cat .tesseraft/workflows/<name>/prompts/foo.md`.

## Pass criteria

- Draft save persists and shows non-blocking lint; completed save blocks on
  lint errors and only persists when valid.
- On-screen lint diagnostics match `bin/tesseraft lint` output.
- Bundled fallback renders for missing project workflows.
- Unsafe asset paths produce a visible 400 error and write nothing outside the
  package directory; valid assets round-trip correctly.

## Fail criteria

- A completed save persists an invalid workflow, or a draft save blocks on lint.
- Lint diagnostics in the UI disagree with `bin/tesseraft lint`.
- An unsafe asset path is accepted or writes outside the package directory.
- Any console error during these flows.

## Teardown

```sh
kill $SERVER_PID
```
