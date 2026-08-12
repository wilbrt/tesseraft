# Getting started

Tesseraft's default local stack includes Node.js, npm, Babashka, and Python.
Their CI and container baselines are declared in
[`.tool-versions`](../../.tool-versions). For local core and Web use, the
dependency doctor accepts a newer Babashka release within the same major
version, and the Web/workflow profiles accept Python versions at or above the
declared baseline. Test and E2E profiles remain exact.

Windows users should start with the supported
[Windows/WSL 2 quickstart](WINDOWS_QUICKSTART.md). Linux container and host
install details are in the [container install guide](../operations/CONTAINER_INSTALL.md).

```bash
npm ci
./bin/tesseraft doctor --profile web
./bin/tesseraft lint examples/tutorials/smoke/workflow.edn
./bin/tesseraft run examples/tutorials/smoke/workflow.edn --run-id first-run
./bin/tesseraft control-plane run first-run
```

Build and start the local console with:

```bash
npm run build:web
node web/server.js
```

`npm ci` installs the repository-pinned Pi CLI under `node_modules/.bin`; the
Tesseraft launcher adds that directory to `PATH`. Use `doctor --profile workflow`
when preparing to run agent workflows; it additionally checks for Git, `gh`,
and Pi.

Next, read the [project model](../reference/PROJECTS.md), browse the [tutorial and catalog examples](../../examples/README.md), or inspect the [workflow contract](../../SPEC.md).
