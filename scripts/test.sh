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
./bin/tesseraft lint examples/pr-housekeeping/workflow.edn
./bin/tesseraft lint examples/jira-to-pr/workflow.edn

printf '\nLinting self-contained node fixtures...\n'
./bin/tesseraft node lint test/fixtures/valid/simple-node/node.edn

printf '\nChecking node export/import...\n'
./bin/tesseraft node export examples/smoke/workflow.edn start --out "$TMP_DIR/exported-start"
./bin/tesseraft node lint "$TMP_DIR/exported-start/node.edn"
cat >"$TMP_DIR/import-target.workflow.edn" <<'EOF'
{:api-version "tesseraft.workflow/v1"
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
expect_missing_value "Missing value for --emit" ./bin/tesseraft-lint examples/smoke/workflow.edn --emit
expect_missing_value "Missing value for --run-id" ./bin/tesseraft run examples/smoke/workflow.edn --run-id
expect_missing_value "Missing value for --format" ./bin/tesseraft-run examples/smoke/workflow.edn --format

echo "Running local smoke workflow..."
SMOKE_OUTPUT="$(./bin/tesseraft run examples/smoke/workflow.edn --run-id smoke-test --format json)"
printf '%s\n' "$SMOKE_OUTPUT"
if ! grep -q '"status" : "done"' <<<"$SMOKE_OUTPUT"; then
  echo "Expected smoke workflow run status to be done" >&2
  exit 1
fi

printf '\nChecking read-only control-plane commands...\n'
./bin/tesseraft control-plane workflows >/tmp/tesseraft-cp-workflows.json
python3 - <<'PY'
import json
x=json.load(open('/tmp/tesseraft-cp-workflows.json'))
assert any(w['name'] == 'smoke-demo' for w in x['workflows'])
PY
./bin/tesseraft control-plane graph smoke-demo >/tmp/tesseraft-cp-graph.json
python3 - <<'PY'
import json
x=json.load(open('/tmp/tesseraft-cp-graph.json'))
assert x['workflow_name'] == 'smoke-demo'
assert any(n['id'] == 'start' for n in x['nodes'])
assert any(e['from'] == 'start' and e['to'] == 'done' for e in x['edges'])
PY
./bin/tesseraft control-plane run smoke-test >/tmp/tesseraft-cp-run.json
python3 - <<'PY'
import json
x=json.load(open('/tmp/tesseraft-cp-run.json'))
assert x['run']['run_id'] == 'smoke-test'
assert x['run']['status'] == 'done'
assert x['run']['links']['events'] == '/runs/smoke-test/events'
PY
./bin/tesseraft control-plane events smoke-test >/tmp/tesseraft-cp-events.json
python3 - <<'PY'
import json
x=json.load(open('/tmp/tesseraft-cp-events.json'))
assert x['run_id'] == 'smoke-test'
assert any(e['event'] == 'run.finished' for e in x['events'])
PY
rm -f /tmp/tesseraft-cp-workflows.json /tmp/tesseraft-cp-graph.json /tmp/tesseraft-cp-run.json /tmp/tesseraft-cp-events.json

printf '\nChecking local React/TypeScript web UI...\n'
npm run web:test

printf '\nChecking control-plane edge cases...\n'
bb -e '(require (quote [tesseraft.control-plane.core :as cp]))
       (let [dir (java.nio.file.Files/createTempDirectory "tesseraft-cp-test" (make-array java.nio.file.attribute.FileAttribute 0))
             base (str dir)
             dup-a (str base "/conflict/wf-a/dup")
             dup-b (str base "/conflict/wf-b/dup")
             malformed (str base "/malformed/wf-a/bad-events")]
         (doseq [d [dup-a dup-b malformed]] (.mkdirs (java.io.File. d)))
         (spit (str dup-a "/state.edn") (pr-str {:workflow {:name "wf-a" :version "v1"} :run {:id "dup" :dir dup-a :status "done" :state :done}}))
         (spit (str dup-b "/state.edn") (pr-str {:workflow {:name "wf-b" :version "v1"} :run {:id "dup" :dir dup-b :status "done" :state :done}}))
         (assert (= "conflict" (get-in (cp/get-run {:workspace-root base :runs-root "conflict"} "dup") [:error :code])))
         (spit (str malformed "/state.edn") (pr-str {:workflow {:name "wf-a" :version "v1"} :run {:id "bad-events" :dir malformed :status "done" :state :done}}))
         (spit (str malformed "/events.jsonl") "{bad json}\n")
         (assert (= "parse_error" (get-in (cp/get-run-events {:workspace-root base :runs-root "malformed"} "bad-events") [:error :code]))))'

echo "Checking GitHub PR URL normalization..."
bb -e '(require (quote tesseraft.adapters.builtin))
       (let [u tesseraft.adapters.builtin/github-pr-url]
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
