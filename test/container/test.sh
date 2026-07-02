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

check version        run --version
check lint-smoke     run lint examples/smoke/workflow.edn
check lint-json      run lint examples/smoke/workflow.edn --format json
check lint-mermaid   run lint examples/smoke/workflow.edn --emit mermaid
check lint-jira      run lint examples/jira-to-pr/workflow.edn
check run-smoke      run run examples/smoke/workflow.edn --run-id container-smoke --format json
check control-plane  run control-plane workflows
check web-server-built runsh 'test -f /opt/tesseraft/web/dist-server/server.js'

echo
echo "==> $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
