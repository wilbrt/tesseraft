# Container install

On Linux containers and Debian/Ubuntu hosts, `scripts/install.sh` installs the
**whole stack** by default: the Babashka CLI
(`lint`/`run`/`node`/`control-plane`) **and** the Node.js/npm tier for the Web UI
(Workflow Studio / Run Console). Use `--core-only` to skip the Node.js requirement.

| Tier | Commands | Install-time deps |
|------|----------|-------------------|
| **Whole stack** (default) | `lint`, `run`, `node`, `control-plane`, `web` | Babashka static binary + Node.js + npm |
| **Core only** (`--core-only`) | `lint`, `run`, `node`, `control-plane` | Babashka static binary only |
| **Agent** | running `:executor :pi-cli` workflows | `pi` CLI + provider keys — a **run-time** concern, mounted at `docker run`, not installed here |

Babashka publishes [static Linux binaries](https://github.com/babashka/babashka/releases)
(amd64 + aarch64) with sha256 sidecar files, so there's no JDK build step. The
binary itself is self-contained, including the libraries Tesseraft uses. The
installer downloads, verifies, and installs the Babashka binary; no external JRE
or Maven dependency resolution is required.

The supported Node.js, npm, Babashka, and Python versions live in the repository's
single `.tool-versions` declaration. CI reads it directly, the installer consumes
it, and the container smoke test verifies the image against it.

## From your own Dockerfile

After cloning this repo (e.g. as `tesseraft/`) alongside your Dockerfile:

```dockerfile
# Whole stack (CLI + Web UI):
COPY tesseraft /opt/tesseraft
RUN /opt/tesseraft/scripts/install.sh && \
    cd /opt/tesseraft && npm ci && npm run web:build
ENV PATH="/opt/tesseraft/bin:${PATH}"

# Or, CLI/lint only:
# RUN /opt/tesseraft/scripts/install.sh --core-only
```

`scripts/install.sh` flags:

- `--core-only` — do not require Node.js/npm (CLI tier only).
- `--install-node` — on Debian/Ubuntu, install the declared Node.js release via NodeSource first (whole-stack).
- `--prefix DIR` — where to place `bb` (default `/usr/local`).
- `--bb-version TAG` — explicitly override the Babashka release declared in `.tool-versions`.

The installer is idempotent: it skips downloading if a matching `bb --version`
is already present, so re-running layers is cheap.

## Canonical reference image

A ready-to-build image covering the whole stack lives at the repo root:

```bash
docker build -t tesseraft .
docker run --rm tesseraft --version
docker run --rm tesseraft lint /opt/tesseraft/examples/tutorials/smoke/workflow.edn
docker run --rm -p 127.0.0.1:8787:8787 tesseraft web --host 0.0.0.0 --port 8787 --acknowledge-remote-exposure
```

For a smaller core-only image, base on `debian:bookworm-slim` instead of the
declared Node image, run `scripts/install.sh --core-only`, and drop the
`npm ci && npm run web:build` lines.

## Container tests

The container test harness `test/container/test.sh` is version-controlled; its
scratch output (`test/container/logs/`, `test/container/build/`) is git-ignored
so build logs and scratch contexts stay out of version control:

```bash
test/container/test.sh            # build image + smoke checks
test/container/test.sh --no-build # reuse an existing tesseraft image
```

It builds the image and runs: `--version`, `lint` (smoke/work-item, JSON,
Mermaid), `run` on the local smoke workflow, `control-plane workflows`, and
confirms the Web UI server was built. It also verifies non-root writes to the
declared workspace/data volumes, loopback Web health, graceful shutdown, and
the pinned toolchain without downloading dependencies during startup.

## Running agent workflows

Agent workflows (`:executor :pi-cli`) are intentionally **not** part of the
install. They need the `pi` CLI and provider API keys, which are secrets. Mount
them at run time:

```bash
docker run --rm \
  -v "$PWD:/workspace" -w /workspace \
  -e OPENAI_API_KEY \
  -v ~/.local/bin/pi:/usr/local/bin/pi:ro \
  tesseraft run examples/catalog/prompt-to-pr/workflow.edn --run-id local
```

This keeps the build reproducible and secrets out of the image layer cache.
