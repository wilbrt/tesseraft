# Tesseraft Code Style

Tesseraft code should make workflow behavior explicit, inspectable, and composable. Prefer a small set of simple parts over convenient shortcuts that couple concerns.

## Core principles

### Functional by default

- Prefer pure functions that transform data into data.
- Keep side effects at the edges: CLI entrypoints, filesystem stores, shell/process adapters, network adapters, and executors.
- Make effectful functions obvious with names such as `write-json!`, `event!`, or `run-handler!`.
- Pass context explicitly. Do not hide workflow state in globals, dynamic vars, singletons, or ambient mutable state.
- Return values that can be inspected, logged, tested, and serialized.

### Declarative over procedural

- The workflow definition is the source of truth.
- Runtime, UI, and adapter code must interpret workflow declarations; they must not silently redefine workflow behavior.
- Prefer data contracts, registries, schemas, and explicit node fields over hard-coded control flow.
- Add capabilities by extending declarations and handlers, not by special-casing individual workflows.

### Simple over easy

Use Rich Hickey's distinction: simple means unentangled; easy means nearby or familiar. Choose simple when they conflict.

- Prefer explicit data flow over implicit convenience.
- Prefer small namespaces with clear responsibilities over large grab-bag modules.
- Prefer stable, boring data structures over clever abstractions.
- Prefer one well-defined mechanism over several overlapping shortcuts.
- Prefer durable contracts over quick local conveniences.

## Design guidelines

### Separate concerns

Keep these boundaries clear:

- `spec` parses, normalizes, renders, and describes workflow data.
- `lint` validates workflow definitions without side effects.
- `runtime` manages run state, transitions, events, and artifact checks.
- `executors` run agent sessions.
- `adapters` bridge deterministic handlers to external systems.
- `bin` scripts are thin entrypoints only.

If a change crosses boundaries, make the data contract between those boundaries explicit.

### Model behavior as data

Prefer adding fields to workflow declarations when behavior should be portable or inspectable. Examples:

- artifact outputs and schemas
- executor names
- handler names
- transition conditions
- retry/round policies
- branch or PR metadata artifact paths

Avoid behavior that exists only in hidden runtime code when it should be visible in the workflow file.

### Keep effects narrow

Effectful code should:

- receive all required inputs explicitly,
- write declared artifacts where practical,
- return structured results,
- log enough context to debug failures,
- avoid modifying workflow definition files during runtime sessions.

Do not let adapters or executors mutate global workflow behavior.

### Make failure explicit

- Prefer structured errors and diagnostics over ambiguous booleans or printed-only failures.
- Include paths, state ids, handler/executor names, and artifact names in errors.
- Let the linter catch static problems before runtime whenever possible.
- Do not swallow process, Git, GitHub, Pi, or filesystem failures.

### Preserve portability

- Keep normalized workflow data JSON-compatible.
- Avoid Clojure-only semantics in portable contracts.
- Keep process-node protocols language-neutral.
- Avoid absolute paths in workflow definitions unless explicitly required by runtime inputs.

## Clojure/Babashka style

- Use small functions with descriptive names.
- Prefer maps, vectors, sets, and pure transformations.
- Prefer `let`, `cond`, `case`, `->`, and `->>` when they clarify data flow.
- Avoid macros unless they remove real incidental complexity.
- Avoid atoms/refs/agents unless there is a clear concurrency or lifecycle reason.
- Keep namespaces focused and dependency direction clear.
- Use kebab-case for public function and data keys.
- Use `!` suffix for functions with side effects.

## Testing expectations

- Add lint coverage for new workflow features.
- Add safe smoke tests before side-effectful integration tests.
- Do not require Pi, Jira, GitHub, browser tools, or external credentials for default tests.
- Prefer fixtures and local-only workflows for regression coverage.

## Review checklist

Before merging a change, ask:

1. Is the workflow contract still the source of truth?
2. Are new side effects isolated and visible?
3. Can the core logic be tested without external services?
4. Does this add a simple concept or an easy shortcut?
5. Are failures inspectable from diagnostics, events, logs, or artifacts?
6. Does this preserve existing workflow portability?
