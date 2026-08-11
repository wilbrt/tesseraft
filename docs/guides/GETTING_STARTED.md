# Getting started

Tesseraft pins the Node.js, Babashka, and Python versions used by CI, tests, and
the reference container in [`.tool-versions`](../../.tool-versions). For local
core and Web use, the dependency doctor accepts a newer Babashka release within
the same major version; Homebrew's current Babashka therefore does not need to
match the CI patch version exactly. Test and E2E profiles remain exact.

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
