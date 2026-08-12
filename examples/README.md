# Examples

Examples are maintained product material, not regression fixtures.

## Tutorials

[`tutorials/`](tutorials/) contains small learning workflows:

- `smoke` — minimal deterministic workflow and local run.
- `mock-run-workflow` — credential-free agent execution with the mock executor.

## Catalog

[`catalog/`](catalog/) contains realistic maintained workflows: prompt/worktree/work-item to PR, focused and design-interrogated TDD, review loops, design-in-practice, housekeeping, Playwright review, and reusable fragments. `work-item-to-pr` is provider-neutral; Jira is one project connection configuration, not a separate workflow runtime.

Invalid or regression-only variants belong under [`test/fixtures/`](../test/fixtures/).
