# Playwright end-to-end testing design

Status: Draft

This document defines an incremental plan for adding Playwright browser tests to
Tesseraft. Each increment is sized for one run of
[`code-review-loop`](../examples/code-review-loop/workflow.edn), one focused
pull request, and an independent regression and code-review decision.

It extends the Web UI boundaries in [WEB_UI.md](WEB_UI.md), the architecture in
[WEB_UI_ARCHITECTURE.md](WEB_UI_ARCHITECTURE.md), and the browser-only gaps in
[`manual-testing/`](../manual-testing/). Workflow files, control-plane data, and
file-backed run records remain authoritative; browser state and test fixtures
must not redefine workflow behavior.

## Decision

Use **Playwright** for functional end-to-end browser tests.

Playwright fits the current React/Vite application and local Express server,
supports real `EventSource` behavior, provides isolated browser contexts and
API fixture setup, and includes traces, screenshots, and video for CI failures.
Cypress is viable, but its interactive runner does not provide enough
project-specific benefit to outweigh Playwright's server lifecycle,
multi-context, tracing, and cross-browser capabilities.

The objective is not to reproduce every server or linter test in a browser. The
objective is a thin browser layer that proves critical user journeys across the
React UI, browser APIs, local HTTP control plane, and file-backed runtime.

## Canon TDD application

The rollout follows the workflow described in Kent Beck's “Canon TDD”:

1. Keep a list of browser scenarios.
2. Turn exactly one scenario into a concrete runnable test.
3. Make it and all previous tests pass.
4. Optionally improve the test or application design.
5. Repeat.

Test order matters. The harness and fixture seams should be learned through one
small test before speculative tests are written for every manual scenario.
Each set below therefore adds one coherent capability or user journey and has
explicit non-goals.

## Existing coverage and browser boundary

The repository already has substantial lower-level coverage:

- `test/web-server.test.js` covers control-plane routes, server behavior, run
  mutations, settings, projects, and confinement.
- `test/web-pi-session.test.js` covers Pi session model resolution and adapter
  behavior.
- `test/web-studio.test.js` covers Studio create, save, lint, and asset routes.
- `test/web-ui.test.js` covers pure helpers and static React rendering.
- `bb test` covers linting, local workflows, mock execution, and broader smoke
  checks.
- The removed legacy screenshot workflow previously provided a bespoke
  geometry gate; new browser coverage belongs in Playwright.

Playwright should cover behavior that requires a real browser:

- user interaction and browser event wiring;
- live `EventSource` rendering;
- overlays, focus, and visible errors;
- project changes without stale UI state;
- responsive geometry and browser console failures;
- a small number of critical UI-to-runtime journeys.

Playwright should not exhaustively retest API validation, linter rules, path
confinement, or runtime state transitions already covered below the browser.

## Constraints

All Playwright sets must preserve these constraints:

- Tests use localhost only and do not navigate to external origins.
- Tests require no Pi, Jira, GitHub, hosted service, external credential, or
  real side-effectful executor.
- Mutable tests use temporary workspaces, Tesseraft homes, run roots, unique
  names, and deterministic local or mock workflows.
- Tests use role, label, and stable test-id locators rather than styling or DOM
  structure where practical.
- Tests do not use fixed sleeps. They wait for visible state, a response, an
  event-driven update, or a bounded API condition.
- Existing Node/API tests remain the primary contract tests.
- Browser versions and the Playwright package are pinned.
- Screenshots, videos, and traces are debugging evidence, not authoritative
  application state.
- Browser regression coverage is added through Playwright rather than a
  workflow-specific screenshot harness.

## Code-review-loop delivery model

`code-review-loop` designs the requested change, creates an isolated worktree,
implements it, independently regression-tests it, reviews the diff, and creates
a pull request. A Playwright set should therefore be submitted as one focused
prompt with:

- one outcome;
- bounded required scope;
- objective acceptance criteria;
- explicit non-goals;
- relevant local validation commands.

Do not submit “add all Playwright e2e tests” as one run. Later sets should be
started from a base branch containing their required predecessors. Because the
sets share package metadata, Playwright configuration, and fixtures, avoid
implementing dependent sets concurrently.

## Dependency graph

```text
PW1 Foundation and smoke
 ├── PW2 Isolated mutable fixture and SSE
 │    ├── PW3 Start, step, and resume
 │    ├── PW4 Mutation errors and deletion
 │    ├── PW5 Workflow Studio
 │    └── PW7 Approval flow
 └── PW6 Responsive geometry
```

PW1 is required for every later set. PW2 establishes the mutable fixture used
by PW3, PW4, PW5, and PW7. After PW2, those four user-journey sets are logically
independent, although sequential merges minimize fixture conflicts. PW6 only
requires PW1 but should be delivered late because it overlaps existing quality
gates.

## Shared technical shape

The expected initial file layout is:

```text
playwright.config.ts
test/e2e/
  fixtures.ts
  workflow-inspection.spec.ts
  run-streaming.spec.ts
  run-controls.spec.ts
  run-errors.spec.ts
  studio.spec.ts
  responsive.spec.ts
  approval.spec.ts
```

The final layout may differ when repository evidence supports a simpler design.
Avoid empty abstractions and page objects that merely wrap one locator.

Recommended defaults:

- `webServer` builds and starts `web/dist-server/server.js` on a fixed localhost
  test port.
- CI does not reuse an existing server, preventing the documented stale-worktree
  hazard.
- Chromium is the only required pull-request project initially.
- Traces are retained on retry or failure; screenshots and video are retained
  only on failure.
- Parallelism remains conservative until mutable fixture isolation is proven.
- Firefox and WebKit are deferred until browser portability has demonstrated
  product value.

## PW1 — Playwright foundation and workflow inspection

### Outcome

Establish a stable local Playwright harness and prove that the built application
can inspect a workflow in a real browser.

### Required scope

- Add a pinned `@playwright/test` development dependency and lockfile update.
- Add Playwright configuration and `web:e2e` / `web:e2e:ui` package scripts.
- Build and launch the production Web UI server through `webServer`.
- Add one Chromium test that opens Tesseraft, selects `smoke-demo`, observes its
  graph, and fails for uncaught page errors.
- Add a CI step that installs Chromium, runs the test, and uploads useful
  Playwright failure artifacts.
- Document local installation and execution.

### Acceptance criteria

- `npm run web:test` passes.
- `npm run web:e2e` passes from a clean checkout after browser installation.
- The smoke test waits on user-observable states and uses stable locators.
- CI does not reuse an arbitrary existing server.
- No mutable run or workflow data is created by the test.

### Non-goals

No SSE, run mutation, mobile project, visual snapshot baseline, or
Firefox/WebKit.

### Code-review-loop prompt

```text
Implement PW1 from docs/PLAYWRIGHT_E2E_DESIGN.md: add the pinned Playwright
foundation, production-server webServer setup, Chromium CI gate, and one
read-only browser test that selects smoke-demo and observes its graph without
page errors. Keep the change local-only and focused. Do not add mutable/SSE,
responsive, or cross-browser tests. Validate npm run web:test and npm run
web:e2e.
```

Suggested branch: `test/playwright-foundation`.

## PW2 — Isolated mutable fixture and live run SSE

### Outcome

Prove a visible run-state update arrives through the application's real
`EventSource` path while establishing safe fixture isolation for later tests.

### Required scope

- Add a fixture that provides temporary workspace, Tesseraft home, run storage,
  unique identifiers, and deterministic cleanup.
- Start or seed a local-only run without external executors.
- Open that run in the UI, advance it through a controlled API or CLI fixture
  action, and assert that visible state changes without a page reload.
- Compare the visible result with the API or persisted run record.
- Keep waits event- or condition-based and retain a trace on failure.

PW2 must first verify how the current server and subprocesses resolve workspace,
home, and run-root settings. If isolation requires a small production seam, add
only the minimum explicit seam justified by a test; do not hide writes in the
main repository.

### Acceptance criteria

- The test proves distinct initial and updated visible states.
- The update is delivered while the page remains loaded.
- Ground truth agrees with the visible result.
- Fixture data is isolated and removed even after failure.
- No external service or credential is used.

### Non-goals

No Pi-session stream, run-control button journey, approval, or broad fixture
framework.

### Code-review-loop prompt

```text
Implement PW2 from docs/PLAYWRIGHT_E2E_DESIGN.md: add the smallest isolated
mutable e2e fixture and one local-only run SSE test. Seed or start a controlled
run, keep its page open, advance it outside the UI, and prove EventSource
updates the visible state without reload and agrees with API/runtime ground
truth. Clean up all temporary data and use no fixed sleeps or external
services. Do not add run-control, Pi-session, Studio, or approval tests.
```

Suggested branch: `test/playwright-run-streaming`.

## PW3 — Start wizard, step, and resume

### Outcome

Prove the main successful run-control journey through visible browser controls.

### Required scope

- Reuse the PW2 isolated fixture.
- Open `StartWorkflowWizard`, select a safe local or mock workflow, provide
  required inputs, and start a uniquely named run.
- Confirm the run appears in the Runs surface.
- Step once and verify one visible transition.
- Resume and verify the expected terminal state.
- Verify the result independently through the API or persisted record.

### Acceptance criteria

- Start, step, and resume are initiated through visible controls.
- Setup and final assertions may use fixture APIs.
- The run never invokes a real external executor.
- The test is deterministic and cleans up its run data.

### Non-goals

No deletion refusal, approval, exhaustive wizard validation, or SSE protocol
retesting beyond observing the resulting UI state.

### Code-review-loop prompt

```text
Implement PW3 from docs/PLAYWRIGHT_E2E_DESIGN.md using the existing isolated
e2e fixture. Add one browser journey that opens the start wizard, starts a safe
local/mock workflow, sees the run in Runs, steps it once, resumes it, and
verifies the terminal result against API/runtime ground truth. Use visible
controls and stable locators. Do not add delete, approval, Studio, or broad
validation coverage. Run npm run web:test and npm run web:e2e.
```

Suggested branch: `test/playwright-run-controls`.

## PW4 — Visible mutation errors and deletion

### Outcome

Prove that deletion refusal and success are represented correctly to the user.

### Required scope

- Reuse the isolated run fixture.
- Attempt to delete a controlled executing run through the UI.
- Assert a readable refusal and prove the run still exists.
- Transition or seed a terminal run, delete it through the UI, and prove it
  disappears from both UI and API/runtime ground truth.
- Assert that expected request failures do not become uncaught browser errors.

### Acceptance criteria

- Refused deletion preserves the executing run.
- Successful deletion removes the terminal run.
- Assertions cover visible behavior, not only response status.
- The test cleans up regardless of its outcome.

### Non-goals

No exhaustive API error matrix, cancellation semantics, or approval decisions.

### Code-review-loop prompt

```text
Implement PW4 from docs/PLAYWRIGHT_E2E_DESIGN.md with the isolated run fixture.
Add focused browser coverage proving deletion of an executing run is visibly
refused and preserves it, while deletion of a terminal run succeeds and removes
it from UI and ground truth. Ensure expected request failures do not cause
uncaught browser errors. Do not retest the full API matrix or add cancellation
or approval behavior.
```

Suggested branch: `test/playwright-run-errors`.

## PW5 — Workflow Studio save and lint behavior

### Outcome

Prove the browser-visible distinction between draft saving and completed-save
lint gating.

### Required scope

- Reuse an isolated temporary workspace.
- Create a uniquely named draft workflow through Studio.
- Save a draft and observe success.
- Attempt a completed save with invalid workflow content and assert readable
  lint diagnostics and blocked completion.
- Correct the workflow, save completed, and verify the package through the API
  or filesystem.
- Remove created package files during teardown.

A visible unsafe-asset-path scenario may be a later extension. It should not be
included if it makes this set test multiple unrelated Studio flows.

### Acceptance criteria

- Draft and completed-save behavior are visibly distinct.
- Diagnostics correspond to the server result.
- No write escapes the temporary workspace.
- Existing Studio API tests remain the exhaustive contract coverage.

### Non-goals

No exhaustive editor interaction, linter-rule matrix, screenshot comparison, or
unsafe-path scenario unless it remains a small direct extension.

### Code-review-loop prompt

```text
Implement PW5 from docs/PLAYWRIGHT_E2E_DESIGN.md. In an isolated workspace, add
one Studio browser journey that creates a unique draft, proves draft save
succeeds, proves invalid completed save is visibly blocked with lint
diagnostics, then fixes and completes the workflow and verifies persisted
ground truth. Clean up all files. Do not duplicate the linter/API test matrix or
add visual snapshots and unrelated Studio flows.
```

Suggested branch: `test/playwright-studio`.

## PW6 — Responsive and overlay geometry

### Outcome

Provide deterministic functional geometry checks for the valuable portions of
the existing browser quality gate.

### Required scope

- Add desktop and mobile viewport coverage.
- Assert no document-level horizontal overflow on the selected surfaces.
- Open the project selector and prove its menu is visible, inside the viewport,
  pointer-targetable, and not clipped by an ancestor.
- Open Settings and assert usable width at desktop and mobile sizes.
- Explicitly establish each application state before measuring it.
- Use screenshots as failure artifacts only.

### Acceptance criteria

- Checks are numeric or behavioral, not screenshot interpretation.
- Required UI state is asserted before geometry is captured.
- Tests pass in the required Chromium project without external access.
- The checks remain ordinary Playwright tests rather than a new bespoke
  screenshot harness.

### Non-goals

No pixel snapshots, AI visual verdict, color-scheme review, or bespoke visual
review pipeline.

### Code-review-loop prompt

```text
Implement PW6 from docs/PLAYWRIGHT_E2E_DESIGN.md. Add focused Playwright
geometry tests for desktop/mobile overflow, the open project-selector overlay,
and Settings width. Explicitly drive and assert each required UI state before
measuring it, and use screenshots only on failure. Do not add pixel baselines,
AI visual review, color-scheme coverage, or a new workflow-specific browser
gate.
```

Suggested branch: `test/playwright-responsive-layout`.

## PW7 — Approval decision flow

### Outcome

Prove that a developer can make a durable approval decision through the Run
Console and see the resulting run transition.

### Required scope

- Reuse isolated fixtures to create a deterministic run blocked on approval.
- Open the run and assert its approval context and allowed decision are visible.
- Submit one allowed decision through the UI.
- Assert the approval surface and run state update appropriately.
- Verify the durable decision and resulting state through API/runtime records.

### Acceptance criteria

- The decision is initiated through the UI.
- Durable ground truth independently confirms it.
- The run resumes or terminates according to the fixture contract.
- No external identity, authorization service, or credentials are required.

### Non-goals

No multi-user routing, authentication/authorization design, or exhaustive
approval API validation.

### Code-review-loop prompt

```text
Implement PW7 from docs/PLAYWRIGHT_E2E_DESIGN.md using isolated local fixtures.
Create a deterministic run blocked on approval, prove its context is visible,
submit one allowed decision through the UI, observe the resulting run update,
and verify the durable decision in API/runtime ground truth. Do not add
multi-user auth, external identity, or exhaustive approval API cases.
```

Suggested branch: `test/playwright-approval-flow`.

## Recommended execution order

Run and merge the sets in this order:

1. PW1 — foundation and workflow inspection.
2. PW2 — fixture isolation and SSE.
3. PW3 — successful run controls.
4. PW5 — Workflow Studio.
5. PW4 — mutation errors and deletion.
6. PW7 — approval flow.
7. PW6 — responsive geometry.

PW2 comes early because SSE is a documented browser-only risk and forces the
mutable fixture model to become reliable. PW6 comes last because it overlaps
existing browser infrastructure and must not trigger premature consolidation.
PW3–PW5–PW4–PW7 can be reordered after PW2 when product priorities require it.

## Validation policy

Every set must run the narrow new test and the existing relevant suite. The
normal minimum is:

```sh
npm run web:test
npm run web:e2e
```

Run `bb test` when package scripts, CI, server lifecycle, workflow fixtures, or
other broader project behavior changes. CI remains the final clean-environment
proof, including browser installation.

A browser test is not acceptable merely because it passes once. Before making
it a required gate, verify that it:

- fails for the intended broken behavior;
- passes repeatedly without retries hiding a race;
- cleans up after a forced failure;
- emits enough trace/report evidence to diagnose a CI failure;
- does not depend on execution order or developer machine state.

## Risks and mitigations

### Mutable filesystem state

The local control plane is file-backed, so a shared repository workspace can
make tests order-dependent or destructive. PW2 must establish explicit
workspace/home/run-root isolation before mutation-heavy tests are added.

### Server and subprocess environment

The Web UI server launches Tesseraft subprocesses. Fixture design must verify
that isolation settings reach those subprocesses consistently. If not, add a
small explicit test seam rather than relying on ambient developer state.

### Flaky asynchronous assertions

SSE and background runtime transitions can tempt fixed sleeps. Use Playwright's
retrying assertions, bounded API polling, and explicit expected states instead.
Retries are diagnostic protection, not a substitute for deterministic setup.

### Duplicated test layers

A browser assertion should exist because the browser integration can fail while
the API contract remains correct. Keep exhaustive permutations in existing
server and runtime tests.

## Completion criteria

The initial Playwright adoption is complete when:

- PW1 and PW2 are stable required Chromium checks;
- critical start/resume, Studio, mutation-error, and approval journeys have
  focused browser coverage according to current product priority;
- manual testing documents identify which checks remain intentionally manual;
- browser failures produce actionable traces without external services;
- mutable tests are isolated from the developer repository and each other;
- browser coverage is owned by the Playwright suite rather than duplicated in
  workflow-specific test harnesses.
