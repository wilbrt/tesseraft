# Getting started

Tesseraft requires the pinned Node.js, Babashka, and Python versions declared in [`.tool-versions`](../../.tool-versions).

```bash
npm ci
./bin/tesseraft doctor --profile core
./bin/tesseraft lint examples/tutorials/smoke/workflow.edn
./bin/tesseraft run examples/tutorials/smoke/workflow.edn --run-id first-run
./bin/tesseraft control-plane run first-run
```

Build and start the local console with:

```bash
npm run build:web
node web/server.js
```

Next, read the [project model](../reference/PROJECTS.md), browse the [tutorial and catalog examples](../../examples/README.md), or inspect the [workflow contract](../../SPEC.md).
