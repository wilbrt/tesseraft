#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

RUN_DIR=".agent-runs/smoke-demo/smoke-test"
TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$RUN_DIR" "$TMP_DIR"
}
trap cleanup EXIT
cleanup
mkdir -p "$TMP_DIR"

echo "Linting safe example workflows..."
./bin/tesseraft lint examples/smoke/workflow.edn
./bin/tesseraft lint examples/prompt-to-pr/workflow.edn
./bin/tesseraft lint examples/worktree-to-pr/workflow.edn
./bin/tesseraft lint examples/review-loop/workflow.edn
./bin/tesseraft lint examples/jira-to-pr/workflow.edn

printf '\nLinting self-contained node fixtures...\n'
./bin/tesseraft node lint test/fixtures/valid/simple-node/node.edn

printf '\nChecking node export/import...\n'
./bin/tesseraft node export examples/smoke/workflow.edn start --out "$TMP_DIR/exported-start"
./bin/tesseraft node lint "$TMP_DIR/exported-start/node.edn"
cat >"$TMP_DIR/import-target.workflow.edn" <<'EOF'
{:api-version "agent.workflow/v1"
 :kind :workflow
 :metadata {:name "import-target"}
 :inputs {:prompt {:type :string :required true}}
 :defaults {:max-rounds 1 :state-timeout "1m"}
 :policies {:require-timeouts true :require-max-rounds true}
 :initial :imported-design
 :states {:done {:type :terminal :status :success}}}
EOF
./bin/tesseraft node import test/fixtures/valid/simple-node/node.edn "$TMP_DIR/import-target.workflow.edn" --as imported-design --next done
./bin/tesseraft lint "$TMP_DIR/import-target.workflow.edn"

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

set +e
./bin/tesseraft node lint test/fixtures/invalid/missing-node-asset/node.edn >/tmp/tesseraft-invalid-node-lint.out 2>&1
invalid_node_status=$?
set -e
if [[ "$invalid_node_status" -eq 0 ]]; then
  cat /tmp/tesseraft-invalid-node-lint.out >&2
  echo "Expected invalid node fixture lint to fail" >&2
  exit 1
fi
if ! grep -q "asset-missing\|prompt-template-missing" /tmp/tesseraft-invalid-node-lint.out; then
  cat /tmp/tesseraft-invalid-node-lint.out >&2
  echo "Expected invalid node fixture to report missing asset or prompt" >&2
  exit 1
fi
rm -f /tmp/tesseraft-invalid-node-lint.out

echo "Smoke checks passed."
