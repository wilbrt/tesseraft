# Manual script: run controls UX (start / step / resume / delete)

Audits the **interactive, browser-only** button flows for run controls. Covers
P0.4 surface #5. HTTP-level start/step/resume/delete behavior (including
delete-refuses-executing-runs) is already auto-covered by
`test/web-server.test.js`; this script verifies the *clickable UI* and the
`StartWorkflowWizard` modal.

## Ground truth

- Run control routes (implementation: `web/src-server/routes/api.ts`):
  - `POST /api/runs` — start a run (~line 807).
  - `POST /api/runs/:runId/:operation` — step / resume / background resume
    (~line 833).
  - `POST /api/runs/:runId/approvals/:approvalId` — approval decide (~line 821).
  - `DELETE /api/runs/:runId` — delete; **refuses executing runs** (~line 813).
- Run records (source of truth): `.agent-runs/<workflow>/<run-id>/`
  (see `docs/WORKFLOW_RUNS.md`).
- Automated gate: `npm run web:test` → `test/web-server.test.js` tests
  "smoke start-and-run, step, and resume", "approval pause, decide, and
  resume", "delete-run ... refuses executing runs", and DELETE route tests.

## Setup

```sh
cd "$(git rev-parse --show-toplevel)"
git rev-parse --short HEAD          # server must serve this HEAD
npm run web:build
node web/dist-server/server.js --host 127.0.0.1 --port 5050 &
SERVER_PID=$!
```

Open `http://127.0.0.1:5050/` in a browser with DevTools → Network and Console
open.

## Procedure

1. **StartWorkflowWizard modal:**
   - On the Workflows or Runs tab, open the start-workflow wizard. Confirm the
     modal opens, lets you select a workflow, and shows any required fields.
   - Submit to start a run. Confirm a new run appears in the Runs tab and on
     disk:

     ```sh
     ls .agent-runs/<workflow>/
     ```

2. **Step / resume:**
   - Select the new run. Use the **Step** control and confirm the run advances
     one node. Compare to `cat .agent-runs/<workflow>/<runId>/state.json`.
   - Use **Resume** (foreground or background) and confirm the run continues
     and the UI updates from the stream (see `run-streaming.md`).

3. **Approval flow (if the workflow has an approval node):**
   - When the run pauses for approval, confirm an approval UI appears. Decide
     approve/reject and confirm the run resumes or ends per the decision.
     Compare to the approval artifact under `.agent-runs/<workflow>/<runId>/`.

4. **Delete refuses executing runs:**
   - Start a second run and, while it is still executing, attempt to delete it
     from the UI. Confirm the UI surfaces a refusal (error message / disabled
     action) rather than removing the run. Ground-truth: the directory
     `.agent-runs/<workflow>/<runId>/` must still exist.
   - After the run reaches a terminal state, delete it again and confirm it is
     removed from both the UI and disk (`ls .agent-runs/<workflow>/`).

## Pass criteria

- The wizard modal opens, submits, and produces a real run directory on disk.
- Step and resume visibly advance the run and match `state.json`.
- Approval decide produces the expected resume/terminal transition and matches
  the approval artifact.
- Delete is refused for an executing run (directory preserved); delete succeeds
  for a terminal run (directory removed).

## Fail criteria

- A control click produces no visible effect or a console error.
- UI state diverges from on-disk records.
- An executing run can be deleted from the UI.

## Teardown

```sh
kill $SERVER_PID
```
