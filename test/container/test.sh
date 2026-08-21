#!/usr/bin/env bash
# Container test harness for the Tesseraft whole-stack image.
#
# This script is version-controlled. Its scratch output (logs/, build/) under
# test/container/ is git-ignored, so build logs and scratch contexts stay out
# of version control while the harness itself is tracked.
#
# Prereqs: a working Docker daemon.
#
#   test/container/test.sh            build + smoke
#   test/container/test.sh --no-build reuse an existing tesseraft image
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
IMAGE="${TESSERAFT_IMAGE:-tesseraft:container-test}"
LOG_DIR="$HERE/logs"
mkdir -p "$LOG_DIR"

BUILD=1
[[ "${1:-}" == "--no-build" ]] && BUILD=0

if [[ "$BUILD" -eq 1 ]]; then
  echo "==> Building $IMAGE from $ROOT"
  docker build -t "$IMAGE" "$ROOT" 2>&1 | tee "$LOG_DIR/build.log"
fi

pass=0; fail=0
check() {
  local name="$1"; shift
  echo "==> $name"
  if "$@" >"$LOG_DIR/$name.log" 2>&1; then
    echo "    PASS"; pass=$((pass+1))
  else
    echo "    FAIL (see $LOG_DIR/$name.log)"; fail=$((fail+1))
  fi
}

run() { docker run --rm "$IMAGE" "$@"; }
# Bypass the `tesseraft` entrypoint to run a shell command in the image.
runsh() { docker run --rm --entrypoint sh "$IMAGE" -c "$1"; }

web_lifecycle() (
  local container="tesseraft-container-test-$$"
  local cid="" mapped="" port="" code=""
  cleanup_web_container() {
    if [[ -n "$cid" ]]; then
      docker rm -f "$cid" >/dev/null 2>&1 || true
    fi
  }
  trap cleanup_web_container EXIT

  cid="$(docker run -d --name "$container" -p 127.0.0.1::8787 "$IMAGE" \
    web --host 0.0.0.0 --port 8787 --acknowledge-remote-exposure)"
  mapped="$(docker port "$cid" 8787/tcp)"
  port="${mapped##*:}"
  for _ in $(seq 1 50); do
    if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null; then
      break
    fi
    sleep 0.1
  done
  curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null
  docker stop --time 10 "$cid" >/dev/null
  code="$(docker inspect --format '{{.State.ExitCode}}' "$cid")"
  [[ "$code" == "0" ]]
  docker rm "$cid" >/dev/null
  cid=""
)

check version        runsh 'expected=$(node -p "require(\"/opt/tesseraft/package.json\").version"); test "$(tesseraft --version)" = "tesseraft $expected"'
check lint-smoke     run lint /opt/tesseraft/examples/tutorials/smoke/workflow.edn
check lint-json      run lint /opt/tesseraft/examples/tutorials/smoke/workflow.edn --format json
check lint-mermaid   run lint /opt/tesseraft/examples/tutorials/smoke/workflow.edn --emit mermaid
check lint-work-item run lint /opt/tesseraft/examples/catalog/work-item-to-pr/workflow.edn
check run-smoke      run run /opt/tesseraft/examples/tutorials/smoke/workflow.edn --run-id container-smoke --format json
check control-plane  runsh 'tesseraft control-plane --workflow-root /opt/tesseraft/examples workflows | grep -q smoke-demo'
check web-server-built runsh 'test -f /opt/tesseraft/web/dist-server/server.js'
check agent-clis runsh '/opt/tesseraft/node_modules/.bin/pi --version && /opt/tesseraft/node_modules/.bin/opencode --version'
check non-root-writes runsh 'test "$(id -u)" != 0 && touch /workspace/.write-probe && touch /data/.tesseraft/.write-probe && touch /data/runs/.write-probe'
check web-lifecycle web_lifecycle
check toolchain runsh 'tesseraft doctor --profile test'

echo
echo "==> $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
