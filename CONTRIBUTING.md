# Contributing to Tesseraft

Tesseraft is a local-first workflow runtime. Keep workflow packages, schemas,
the Clojure linter/runtime, and durable run records authoritative; browser
state and compatibility shims must not become competing implementations.

## Development setup

1. Install the exact versions declared in `.tool-versions`.
2. Run `npm ci`.
3. Install the Python test package with `python -m pip install .`.
4. Install Chromium for browser tests with `npx playwright install chromium`.

Useful independent checks:

- `bb test:clojure`
- `bb test:python`
- `npm run test:node`
- `npm run build:web`
- `npm run test:web`
- `npm run test:e2e` (after one Web build)
- `bb test:docs`
- `npm run test:container` (requires a running Docker daemon)

`bb test:all` is the authoritative local orchestrator. It runs each suite once
and performs one prepared Web build.

## Change discipline

Prefer one behavior-preserving relocation, contract migration, deliberate
deprecation, or security correction per change. Update
`docs/architecture/AUTHORITIES.md`, `deprecations.edn`, schemas, generated
types, or `STATUS.edn` when ownership or a public contract changes. Durable
writes must use the shared safe-write primitives, and tests must use isolated
temporary workspaces.

Never commit credentials, raw tokens, run output, worktrees, generated browser
diagnostics, or local project-registry data. Use credential references such as
`env:NAME` or `tesseraft:path` in portable project descriptors.
