#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

RUN_DIR=".agent-runs/smoke-demo/smoke-test"
cleanup() {
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT
cleanup

echo "Linting safe example workflows..."
./bin/tesseraft lint examples/smoke/workflow.edn
./bin/tesseraft lint examples/prompt-to-pr/workflow.edn
./bin/tesseraft lint examples/worktree-to-pr/workflow.edn
./bin/tesseraft lint examples/review-loop/workflow.edn
./bin/tesseraft lint examples/pr-housekeeping/workflow.edn
./bin/tesseraft lint examples/jira-to-pr/workflow.edn

echo "Checking CLI ergonomics..."
VERSION_OUTPUT="$(./bin/tesseraft --version)"
if [[ "$VERSION_OUTPUT" != "tesseraft 0.1.0" ]]; then
  echo "Unexpected version output: $VERSION_OUTPUT" >&2
  exit 1
fi

expect_missing_value() {
  local expected="$1"
  shift
  local output
  local status
  set +e
  output="$("$@" 2>&1)"
  status=$?
  set -e
  if [[ "$status" -ne 2 ]]; then
    printf '%s\n' "$output" >&2
    echo "Expected command to exit 2: $*" >&2
    exit 1
  fi
  if ! grep -q "$expected" <<<"$output"; then
    printf '%s\n' "$output" >&2
    echo "Expected missing-value message: $expected" >&2
    exit 1
  fi
  if grep -q "Stack trace\|ExceptionInfo" <<<"$output"; then
    printf '%s\n' "$output" >&2
    echo "Expected clean missing-value error without stack trace" >&2
    exit 1
  fi
}

expect_missing_value "Missing value for --format" ./bin/tesseraft lint examples/smoke/workflow.edn --format
expect_missing_value "Missing value for --emit" ./bin/agent-workflow-lint examples/smoke/workflow.edn --emit
expect_missing_value "Missing value for --run-id" ./bin/tesseraft run examples/smoke/workflow.edn --run-id
expect_missing_value "Missing value for --format" ./bin/agent-workflow-run examples/smoke/workflow.edn --format

echo "Running local smoke workflow..."
SMOKE_OUTPUT="$(./bin/tesseraft run examples/smoke/workflow.edn --run-id smoke-test --format json)"
printf '%s\n' "$SMOKE_OUTPUT"
if ! grep -q '"status" : "done"' <<<"$SMOKE_OUTPUT"; then
  echo "Expected smoke workflow run status to be done" >&2
  exit 1
fi

echo "Checking GitHub PR URL normalization..."
bb -e '(require (quote agent-workflow.adapters.builtin))
       (let [u agent-workflow.adapters.builtin/github-pr-url]
         (assert (= "https://github.com/owner/repo/pull/123"
                    (u "owner/repo" {:url "https://api.github.com/repos/owner/repo/pulls/123" :number 123})))
         (assert (= "https://github.com/owner/repo/pull/123"
                    (u "owner/repo" {:url "https://api.github.com/repos/owner/repo/pulls/123"
                                     :html_url "https://github.com/owner/repo/pull/123"
                                     :number 123})))
         (assert (= "https://github.com/owner/repo/pull/124"
                    (u "owner/repo" {:url "https://github.com/owner/repo/pull/124" :number 124})))
         (assert (= "https://github.com/owner/repo/pull/125"
                    (u "owner/repo" {:number 125}))))'

echo "Checking invalid fixture fails lint..."
set +e
./bin/tesseraft lint test/fixtures/invalid/missing-prompt.workflow.edn >/tmp/tesseraft-invalid-lint.out 2>&1
invalid_status=$?
set -e
if [[ "$invalid_status" -eq 0 ]]; then
  cat /tmp/tesseraft-invalid-lint.out >&2
  echo "Expected invalid fixture lint to fail" >&2
  exit 1
fi
rm -f /tmp/tesseraft-invalid-lint.out

echo "Smoke checks passed."
