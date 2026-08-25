# syntax=docker/dockerfile:1
FROM node:26.6.0-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/tesseraft

COPY .tool-versions ./
COPY scripts/install.sh scripts/toolchain.sh scripts/check_deps.sh ./scripts/
RUN ./scripts/install.sh

COPY package.json package-lock.json ./
RUN npm ci
COPY bb.edn tsconfig.server.json tsconfig.web.json ./
COPY bin/ ./bin/
COPY src/ ./src/
COPY schemas/ ./schemas/
COPY examples/ ./examples/
COPY web/ ./web/
RUN npm run web:build \
    && npm prune --omit=dev \
    && bb --config /opt/tesseraft/bb.edn lint examples/tutorials/smoke/workflow.edn --format json >/dev/null

FROM node:26.6.0-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git python3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/bin/bb /usr/local/bin/bb
COPY --from=builder /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=builder /usr/local/bin/npm /usr/local/bin/npm
COPY --from=builder /usr/local/bin/npx /usr/local/bin/npx
COPY --from=builder --chown=node:node /opt/tesseraft /opt/tesseraft

RUN mkdir -p /workspace /data/.tesseraft /data/runs \
    && chown -R node:node /workspace /data
USER node
WORKDIR /workspace

ENV PATH="/opt/tesseraft/bin:${PATH}" \
    TESSERAFT_HOME="/data/.tesseraft" \
    TESSERAFT_WORKSPACE_ROOT="/workspace"
VOLUME ["/workspace", "/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/api/health >/dev/null || exit 1
ENTRYPOINT ["/opt/tesseraft/bin/tesseraft"]
CMD ["--help"]
