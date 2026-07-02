# Tesseraft canonical reference image.
#
# Installs the whole stack: the Babashka CLI (lint/run/node/control-plane) and
# the Web UI (Workflow Studio / Run Console). For a core-only (lint) image, pass
# `--core-only` to the installer and switch the base to debian:bookworm-slim.
#
#   docker build -t tesseraft .
#   docker run --rm tesseraft --version
#   docker run --rm tesseraft lint examples/smoke/workflow.edn
#   docker run --rm -p 8787:8787 tesseraft web --port 8787
#
# To use Tesseraft from *your own* Dockerfile without building this image,
# just copy the repo in and run the installer (see docs/CONTAINER_INSTALL.md):
#
#   COPY tesseraft /opt/tesseraft
#   RUN /opt/tesseraft/scripts/install.sh && \
#       cd /opt/tesseraft && npm ci && npm run web:build
#   ENV PATH="/opt/tesseraft/bin:${PATH}"

FROM node:22-bookworm-slim

# Minimal runtime utilities: ca-certificates/curl for the static-bb download,
# git for git/worktree nodes, and a JRE because Babashka shells out to `java`
# to resolve the Maven dep declared in bb.edn (a JRE is enough, no full JDK).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/tesseraft

# Install deps first for better layer caching. Copy the install script and
# run it (Babashka static binary), then bring in the rest of the source.
COPY scripts/install.sh ./scripts/install.sh
RUN ./scripts/install.sh

# Package metadata + source. node_modules is excluded via .dockerignore.
COPY package.json package-lock.json ./
COPY bb.edn ./
COPY bin/ ./bin/
COPY src/ ./src/
COPY schemas/ ./schemas/
COPY examples/ ./examples/
COPY web/ ./web/
COPY tsconfig.server.json tsconfig.web.json ./

# Build the Web UI server + static assets.
RUN npm ci && npm run web:build && npm cache clean --force

# Pre-warm Babashka deps (cheshire) so offline `tesseraft lint` works.
RUN bb --config /opt/tesseraft/bb.edn lint examples/smoke/workflow.edn --format json >/dev/null

ENV PATH="/opt/tesseraft/bin:${PATH}"
ENTRYPOINT ["tesseraft"]
CMD ["--help"]
