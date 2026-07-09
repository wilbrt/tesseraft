# Manual script: responsive layout + browser console

Audits the **browser-only** responsive/mobile layout wrap and the absence of
JavaScript console errors during interaction. These cannot be asserted by the
`renderToStaticMarkup` structural tests in `test/web-ui.test.js`. This script
preserves the prior UX-simplification checklist that lived in the old
`manual-testing/spec.md`.

## Ground truth

- Component rendering (structural, server-only): `test/web-ui.test.js` covers
  graph, runs, settings, pi, approval, wizard, and studio components via
  `renderToStaticMarkup`. It cannot assert CSS wrap or console behavior.
- UI components: `web/src/` (React/Vite frontend).
- API routes the UI calls: `web/src-server/routes/api.ts` (see
  `docs/CONTROL_PLANE_API.md`).
- Automated gate: `npm run web:test`.

## Setup

```sh
cd "$(git rev-parse --show-toplevel)"
git rev-parse --short HEAD          # server must serve this HEAD
npm run web:build
node web/dist-server/server.js --host 127.0.0.1 --port 5050 &
SERVER_PID=$!
```

Open `http://127.0.0.1:5050/` in a browser with DevTools open (Console + device
toolbar / responsive mode).

## Procedure A — desktop viewport

1. At a standard desktop width, confirm the first viewport shows
   `Tesseraft Console`, the section tabs, and the current context strip.
2. Select a workflow, a graph node, and a run. Confirm workflow/run/node
   placeholders update to the selected values.
3. Confirm run controls appear attached to the selected workflow/run context on
   the Workflows and Runs tabs.
4. Confirm the Pi Sessions tab hides run controls and remains usable.

## Procedure B — narrow/mobile viewport

1. In DevTools device toolbar, resize to a narrow/mobile width (e.g. 375×667).
2. Confirm tabs, context chips, run IDs, workflow names, and control labels
   wrap without clipping or horizontal overflow.
3. Confirm list-selection styling stays visible and navigation between sections
   remains usable.

## Procedure C — run/status behavior (if an active run exists)

1. Select an active run and confirm stream/refresh status is shown near the top
   context.
2. Confirm the selected workflow row and selected run row are visibly marked.

## Procedure D — browser console

1. Navigate across every section tab (Workflows, Runs, Pi Sessions, Settings,
   Studio) and interact with selections and run-control forms.
2. Check the Console for JavaScript errors, failed layout warnings, or uncaught
   promise rejections.

## Pass criteria

- Desktop and mobile layouts render with no clipping or horizontal overflow.
- Run controls correctly attach to / detach from context per tab.
- Selection markers are visible.
- No JavaScript errors or uncaught rejections in the console during the full
  interaction loop.

## Fail criteria

- Content clips or overflows at mobile width.
- Run controls appear on Pi Sessions or vanish from Workflows/Runs context.
- Any console error during navigation/interaction.

## Teardown

```sh
kill $SERVER_PID
```
