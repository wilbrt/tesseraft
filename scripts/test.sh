#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

RUN_DIRS=(".agent-runs/smoke-demo/smoke-test"
          ".agent-runs/review-loop/mock-test"
          ".agent-runs/recovery-fixture/recovery-test"
          ".agent-runs/process-failure-fixture/process-failure-test"
          ".agent-runs/agent-model-provider-fixture/agent-model-provider-test")
TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${RUN_DIRS[@]}" "$TMP_DIR"
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
./bin/tesseraft lint test/fixtures/valid/resource-reusable-read.workflow.edn
./bin/tesseraft lint test/fixtures/valid/resource-ambient-path.workflow.edn

printf '\nChecking agent node model/provider plumbing...\n'
AGENT_MODEL_WORKFLOW="$TMP_DIR/agent-model-provider.workflow.edn"
AGENT_MODEL_PROMPT_DIR="$TMP_DIR/prompts"
AGENT_MODEL_STUB="$TMP_DIR/pi-stub.sh"
AGENT_MODEL_ARGV="$TMP_DIR/pi-argv.txt"
AGENT_MODEL_RUN_ID="agent-model-provider-test"
AGENT_MODEL_RUN_DIR=".agent-runs/agent-model-provider-fixture/$AGENT_MODEL_RUN_ID"
mkdir -p "$AGENT_MODEL_PROMPT_DIR"
cat >"$AGENT_MODEL_PROMPT_DIR/agent.md.tmpl" <<'EOF'
Write the status artifact.
EOF
cat >"$AGENT_MODEL_WORKFLOW" <<EOF
{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "agent-model-provider-fixture"}
 :defaults {:max-rounds 1 :state-timeout "1m"}
 :policies {:require-timeouts true :require-max-rounds true}
 :initial :agent
 :states
 {:agent
  {:type :agent
   :executor :pi-cli
   :provider "openai"
   :model "gpt-4o-mini"
   :prompt-template "prompts/agent.md.tmpl"
   :runtime {:cwd "." :timeout "10s"}
   :outputs {:status {:path "agent/status.json" :required true}}
   :next :done}
  :done {:type :terminal :status :success}}}
EOF
cat >"$AGENT_MODEL_STUB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$AGENT_MODEL_ARGV"
mkdir -p "$AGENT_RUN_DIR/agent"
printf '{"status":"pass","summary":"stubbed pi","issues_file":null}\n' >"$AGENT_RUN_DIR/agent/status.json"
EOF
chmod +x "$AGENT_MODEL_STUB"
rm -rf "$AGENT_MODEL_RUN_DIR"
./bin/tesseraft lint "$AGENT_MODEL_WORKFLOW" --format json >/tmp/tesseraft-agent-model-lint.json
AGENT_MODEL_INVALID_WORKFLOW="$TMP_DIR/agent-model-provider-invalid.workflow.edn"
cp "$AGENT_MODEL_WORKFLOW" "$AGENT_MODEL_INVALID_WORKFLOW"
python3 - <<PY
from pathlib import Path
p = Path('$AGENT_MODEL_INVALID_WORKFLOW')
s = p.read_text().replace(':provider "openai"', ':provider ""').replace(':model "gpt-4o-mini"', ':model 123')
p.write_text(s)
PY
set +e
./bin/tesseraft lint "$AGENT_MODEL_INVALID_WORKFLOW" --format json >/tmp/tesseraft-agent-model-invalid-lint.json 2>&1
agent_model_invalid_status=$?
set -e
if [[ "$agent_model_invalid_status" -eq 0 ]]; then
  cat /tmp/tesseraft-agent-model-invalid-lint.json >&2
  echo "Expected invalid agent model/provider lint to fail" >&2
  exit 1
fi
if ! grep -q "invalid-agent-provider" /tmp/tesseraft-agent-model-invalid-lint.json || ! grep -q "invalid-agent-model" /tmp/tesseraft-agent-model-invalid-lint.json; then
  cat /tmp/tesseraft-agent-model-invalid-lint.json >&2
  echo "Expected invalid agent model/provider diagnostics" >&2
  exit 1
fi
AGENT_MODEL_ARGV="$AGENT_MODEL_ARGV" PI_BIN="$AGENT_MODEL_STUB" ./bin/tesseraft run "$AGENT_MODEL_WORKFLOW" --run-id "$AGENT_MODEL_RUN_ID" --format json >/tmp/tesseraft-agent-model-run.json
python3 - <<PY
from pathlib import Path
argv = Path('$AGENT_MODEL_ARGV').read_text().splitlines()
assert '--provider' in argv, argv
assert argv[argv.index('--provider') + 1] == 'openai', argv
assert '--model' in argv, argv
assert argv[argv.index('--model') + 1] == 'gpt-4o-mini', argv
log = Path('$AGENT_MODEL_RUN_DIR/logs/agent-1.log').read_text()
assert 'PROVIDER: openai' in log, log
assert 'MODEL: gpt-4o-mini' in log, log
PY
rm -f /tmp/tesseraft-agent-model-lint.json /tmp/tesseraft-agent-model-invalid-lint.json /tmp/tesseraft-agent-model-run.json

printf '\nLinting self-contained node fixtures...\n'
./bin/tesseraft node lint test/fixtures/valid/simple-node/node.edn
./bin/tesseraft node lint .tesseraft/nodes/manual-input/node.edn

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

printf '\nLinting self-contained fragment fixture...\n'
./bin/tesseraft fragment lint examples/fragments/test-fix-loop/fragment.edn
./bin/tesseraft fragment lint examples/fragments/test-fix-loop/fragment.edn --format json >/tmp/tesseraft-fragment-lint.json
python3 - <<'PY'
import json
x = json.load(open('/tmp/tesseraft-fragment-lint.json'))
assert x['ok'] is True, x
PY
rm -f /tmp/tesseraft-fragment-lint.json

printf '\nLinting fragment-including workflow fixtures...\n'
./bin/tesseraft lint test/fixtures/valid/fragment-import.workflow.edn

check_invalid_fragment () {
  local fixture="$1"
  local expected="$2"
  local output="/tmp/tesseraft-${fixture}-lint.out"
  set +e
  ./bin/tesseraft fragment lint "test/fixtures/invalid/${fixture}/fragment.edn" --format json >"$output" 2>&1
  local status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    cat "$output" >&2
    echo "Expected invalid fragment fixture to fail: $fixture" >&2
    exit 1
  fi
  if ! grep -q "$expected" "$output"; then
    cat "$output" >&2
    echo "Expected $fixture to report $expected" >&2
    exit 1
  fi
  rm -f "$output"
}

check_invalid_fragment fragment-missing-exit-fragment fragment-outcome-mismatch
check_invalid_fragment fragment-unsafe-asset invalid-asset-path
check_invalid_fragment fragment-missing-required-input fragment-missing-interface

check_invalid_fragment_workflow () {
  local fixture="$1"
  local expected="$2"
  local output="/tmp/tesseraft-${fixture}-lint.out"
  set +e
  ./bin/tesseraft lint "test/fixtures/invalid/${fixture}.workflow.edn" --format json >"$output" 2>&1
  local status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    cat "$output" >&2
    echo "Expected invalid fragment workflow fixture to fail: $fixture" >&2
    exit 1
  fi
  if ! grep -q "$expected" "$output"; then
    cat "$output" >&2
    echo "Expected $fixture to report $expected" >&2
    exit 1
  fi
  rm -f "$output"
}

check_invalid_fragment_workflow fragment-missing-input fragment-input-binding-missing
check_invalid_fragment_workflow fragment-unknown-outcome fragment-unknown-outcome

# Uncovered outcome is a warning, not an error: assert it surfaces but lint passes (non-strict).
./bin/tesseraft lint test/fixtures/invalid/fragment-uncovered-outcome.workflow.edn --format json >/tmp/tesseraft-fragment-uncovered.out
if ! grep -q "fragment-uncovered-outcome" /tmp/tesseraft-fragment-uncovered.out; then
  cat /tmp/tesseraft-fragment-uncovered.out >&2
  echo "Expected fragment-uncovered-outcome warning" >&2
  exit 1
fi
rm -f /tmp/tesseraft-fragment-uncovered.out

printf '\nChecking fragment import into a workflow...\n'
cat >"$TMP_DIR/fragment-import-target.workflow.edn" <<'EOF'
{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "fragment-import-target"}
 :inputs {:repo-root {:type :string :required true}
          :test-cmd {:type :string :required true}}
 :defaults {:max-rounds 3 :state-timeout "10m"}
 :policies {:require-timeouts true :require-max-rounds true}
 :initial :run-tests
 :states {:done {:type :terminal :status :success}}}
EOF
mkdir -p "$TMP_DIR/prompts"
# Copy the fixture fragment into a temp project so import can find assets.
TEMP_HOME="$TMP_DIR/home"
TEMP_PROJECT="$TMP_DIR/project"
mkdir -p "$TEMP_PROJECT/.tesseraft/fragments/test-fix-loop"
cp examples/fragments/test-fix-loop/fragment.edn "$TEMP_PROJECT/.tesseraft/fragments/test-fix-loop/fragment.edn"
mkdir -p "$TEMP_PROJECT/.tesseraft/fragments/test-fix-loop/prompts" "$TEMP_PROJECT/.tesseraft/fragments/test-fix-loop/schemas"
cp examples/fragments/test-fix-loop/prompts/fix.md.tmpl "$TEMP_PROJECT/.tesseraft/fragments/test-fix-loop/prompts/fix.md.tmpl"
cp examples/fragments/test-fix-loop/schemas/status.schema.json "$TEMP_PROJECT/.tesseraft/fragments/test-fix-loop/schemas/status.schema.json"
# Import into a workflow that lives next to the project fragment dir.
cp "$TMP_DIR/fragment-import-target.workflow.edn" "$TEMP_PROJECT/workflow.edn"
TESSERAFT_HOME="$TEMP_HOME" ./bin/tesseraft fragment import "$TEMP_PROJECT/.tesseraft/fragments/test-fix-loop/fragment.edn" "$TEMP_PROJECT/workflow.edn" --as run-tests --next done
# Import inserts a boundary node; the user still binds inputs/transitions next,
# so we assert the node was written rather than requiring a fully green lint.
WORKFLOW_FILE="$TEMP_PROJECT/workflow.edn" python3 - <<'PY'
import os
from pathlib import Path
text = Path(os.environ['WORKFLOW_FILE']).read_text()
assert ':run-tests' in text, text
assert ':type :fragment' in text, text
assert ':fragment "test-fix-loop"' in text, text
PY

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

printf '\nRunning review-loop mock executor dry run...\n'
MOCK_RUN_DIR=".agent-runs/review-loop/mock-test"
MOCK_OUTPUT="$(./bin/tesseraft run examples/review-loop/workflow.edn --executor mock --run-id mock-test --input prompt='Test dry run' --input repo-root=. --format json)"
printf '%s\n' "$MOCK_OUTPUT"
if ! grep -q '"status" : "done"' <<<"$MOCK_OUTPUT"; then
  echo "Expected mock workflow run status to be done" >&2
  exit 1
fi
if [[ ! -f "$MOCK_RUN_DIR/design/status.json" || ! -f "$MOCK_RUN_DIR/execution/status-1.json" || ! -f "$MOCK_RUN_DIR/pr/pr.json" ]]; then
  echo "Expected mock dry run artifacts were not written" >&2
  exit 1
fi
if ! grep -q ':executor-mode "mock"' "$MOCK_RUN_DIR/state.edn"; then
  echo "Expected mock executor mode to be persisted in context" >&2
  exit 1
fi

printf '\nChecking git-user identity plumbing...\n'
GIT_USER_RUN_ID="git-user-test"
GIT_USER_RUN_DIR=".agent-runs/git-user-fixture/$GIT_USER_RUN_ID"
GIT_USER_WORKFLOW="$TMP_DIR/git-user.workflow.edn"
GIT_USER_PROMPT="$TMP_DIR/git-user-prompt.md.tmpl"
GIT_USER_STUB="$TMP_DIR/pi-git-user-stub.sh"
GIT_USER_ENV="$TMP_DIR/pi-git-user-env.txt"
cat >"$GIT_USER_PROMPT" <<'EOF'
Git user fixture prompt.
EOF
cat >"$GIT_USER_WORKFLOW" <<EOF
{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "git-user-fixture"}
 :defaults {:max-rounds 1 :state-timeout "1m"}
 :policies {:require-timeouts true :require-max-rounds true}
 :initial :agent
 :states
 {:agent
  {:type :agent
   :executor :pi-cli
   :prompt-template "git-user-prompt.md.tmpl"
   :runtime {:timeout "1m"}
   :outputs {:status {:path "agent/status.json" :required true}}
   :next :done}
  :done {:type :terminal :status :success}}}
EOF
cat >"$GIT_USER_STUB" <<EOF
#!/usr/bin/env bash
set -euo pipefail
{
  printf 'GIT_AUTHOR_NAME=%s\n' "\$GIT_AUTHOR_NAME"
  printf 'GIT_AUTHOR_EMAIL=%s\n' "\$GIT_AUTHOR_EMAIL"
  printf 'GIT_COMMITTER_NAME=%s\n' "\$GIT_COMMITTER_NAME"
  printf 'GIT_COMMITTER_EMAIL=%s\n' "\$GIT_COMMITTER_EMAIL"
  printf 'GIT_USER_NAME=%s\n' "\$GIT_USER_NAME"
  printf 'GIT_USER_EMAIL=%s\n' "\$GIT_USER_EMAIL"
} >"$GIT_USER_ENV"
mkdir -p "\$AGENT_RUN_DIR/agent"
printf '{"status":"pass","summary":"stubbed git-user pi","issues_file":null}\n' >"\$AGENT_RUN_DIR/agent/status.json"
EOF
chmod +x "$GIT_USER_STUB"
rm -rf "$GIT_USER_RUN_DIR"
PI_BIN="$GIT_USER_STUB" ./bin/tesseraft run "$GIT_USER_WORKFLOW" --run-id "$GIT_USER_RUN_ID" --git-user-name "Ada Lovelace" --git-user-email "ada@example.com" --format json >/tmp/tesseraft-git-user-run.json
python3 - <<PY
import re
from pathlib import Path
state = Path('$GIT_USER_RUN_DIR/state.edn').read_text()
assert re.search(r':git-user\s*\{[^}]*:name\s*"Ada Lovelace"[^}]*:email\s*"ada@example.com"', state), state
env = Path('$GIT_USER_ENV').read_text()
assert 'GIT_AUTHOR_NAME=Ada Lovelace' in env, env
assert 'GIT_AUTHOR_EMAIL=ada@example.com' in env, env
assert 'GIT_COMMITTER_NAME=Ada Lovelace' in env, env
assert 'GIT_COMMITTER_EMAIL=ada@example.com' in env, env
assert 'GIT_USER_NAME=Ada Lovelace' in env, env
assert 'GIT_USER_EMAIL=ada@example.com' in env, env
PY
rm -rf "$GIT_USER_RUN_DIR"
# Mutual validation: providing only one of name/email must fail.
set +e
./bin/tesseraft run start "$GIT_USER_WORKFLOW" --run-id git-user-partial --git-user-name "Only" --format json >/tmp/tesseraft-git-user-partial.out 2>&1
partial_status=$?
set -e
if [[ "$partial_status" -eq 0 ]]; then
  cat /tmp/tesseraft-git-user-partial.out >&2
  echo "Expected partial git-user start to fail" >&2
  exit 1
fi
if ! grep -q "requires --git-user-email" /tmp/tesseraft-git-user-partial.out; then
  cat /tmp/tesseraft-git-user-partial.out >&2
  echo "Expected missing-value message for partial git-user" >&2
  exit 1
fi
rm -f /tmp/tesseraft-git-user-run.json /tmp/tesseraft-git-user-partial.out

printf '\nChecking interrupted agent recovery...\n'
RECOVERY_RUN_DIR=".agent-runs/recovery-fixture/recovery-test"
RECOVERY_WORKFLOW="$TMP_DIR/recovery.workflow.edn"
cat >"$TMP_DIR/recovery-prompt.md.tmpl" <<'EOF'
Recovery fixture prompt.
EOF
cat >"$RECOVERY_WORKFLOW" <<'EDN'
{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "recovery-fixture"}
 :defaults {:max-rounds 1 :state-timeout "1m"}
 :policies {:require-timeouts true
            :require-max-rounds true}
 :initial :agent
 :states
 {:agent
  {:type :agent
   :executor :pi-cli
   :prompt-template "recovery-prompt.md.tmpl"
   :runtime {:timeout "1m"}
   :outputs {:status {:path "agent/status.json" :required true}}
   :next :done}

  :done
  {:type :terminal
   :status :success}}}
EDN
rm -rf "$RECOVERY_RUN_DIR"
./bin/tesseraft run start "$RECOVERY_WORKFLOW" --run-id recovery-test --format json >/tmp/tesseraft-recovery-start.json
mkdir -p "$RECOVERY_RUN_DIR/agent"
cat >"$RECOVERY_RUN_DIR/agent/status.json" <<'EOF'
{"status":"ok","summary":"preexisting completed artifact","issues_file":null}
EOF
RECOVERY_OUTPUT="$(./bin/tesseraft run step --run-dir "$RECOVERY_RUN_DIR" --format json)"
printf '%s\n' "$RECOVERY_OUTPUT"
if ! grep -q '"status" : "done"' <<<"$RECOVERY_OUTPUT"; then
  echo "Expected recovered run to reach done" >&2
  exit 1
fi
if ! grep -q '"event":"node.recovered"' "$RECOVERY_RUN_DIR/events.jsonl"; then
  cat "$RECOVERY_RUN_DIR/events.jsonl" >&2
  echo "Expected node.recovered event" >&2
  exit 1
fi

printf '\nChecking external process failure evidence...\n'
FAIL_RUN_ID="process-failure-test"
FAIL_RUN_DIR=".agent-runs/process-failure-fixture/$FAIL_RUN_ID"
FAIL_WORKFLOW="$TMP_DIR/process-failure.workflow.edn"
cat >"$FAIL_WORKFLOW" <<'EDN'
{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "process-failure-fixture"}
 :defaults {:max-rounds 1 :state-timeout "1m"}
 :policies {:require-timeouts true
            :require-max-rounds true}
 :initial :boom
 :states
 {:boom
  {:type :process
   :title "Failing process"
   :command ["bash" "-lc" "echo external failure >&2; exit 7"]
   :runtime {:timeout "10s"}
   :next :done}

  :done
  {:type :terminal
   :title "Done"
   :status :success}}}
EDN
rm -rf "$FAIL_RUN_DIR"
./bin/tesseraft run start "$FAIL_WORKFLOW" --run-id "$FAIL_RUN_ID" --format json >/tmp/tesseraft-process-failure-start.json
set +e
FAIL_OUTPUT="$(./bin/tesseraft run step --run-dir "$FAIL_RUN_DIR" --format json 2>&1)"
FAIL_STATUS=$?
set -e
if [[ "$FAIL_STATUS" -eq 0 ]]; then
  printf '%s\n' "$FAIL_OUTPUT" >&2
  echo "Expected process failure step to exit nonzero" >&2
  exit 1
fi
python3 - <<'PY'
import json, os, re
from pathlib import Path
run_dir = Path('.agent-runs/process-failure-fixture/process-failure-test')
state = run_dir / 'state.edn'
events = run_dir / 'events.jsonl'
assert state.exists(), 'state.edn missing'
text = state.read_text()
assert ':status "failed"' in text, text
rows = [json.loads(line) for line in events.read_text().splitlines() if line.strip()]
assert any(e.get('event') == 'node.started' for e in rows), rows
failed = [e for e in rows if e.get('event') == 'node.failed']
assert len(failed) == 1, rows
result = failed[0]['result']
assert result['status'] == 'error', result
assert result['ok'] is False, result
assert result.get('exit-code') == 7 or result.get('exit_code') == 7, result
log_file = result.get('log-file') or result.get('log_file')
assert log_file and Path(log_file).exists(), result
PY
./bin/tesseraft control-plane run "$FAIL_RUN_ID" >/tmp/tesseraft-process-failure-run.json
python3 - <<'PY'
import json
x=json.load(open('/tmp/tesseraft-process-failure-run.json'))
assert x['run']['status'] == 'failed'
assert any(a['status'] == 'error' and a['node_id'] == 'boom' for a in x['run']['attempts']), x
assert any(f['source'] == 'attempt' and f.get('node_id') == 'boom' for f in x['run']['failures']), x
PY
rm -f /tmp/tesseraft-process-failure-start.json /tmp/tesseraft-process-failure-run.json

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

printf '\nChecking issues.json spurious-failure suppression and heart-aware liveness...\n'
bb -e '(require (quote [tesseraft.control-plane.core :as cp]))
       (let [dir (java.nio.file.Files/createTempDirectory "tesseraft-issues-liveness" (make-array java.nio.file.attribute.FileAttribute 0))
             base (str dir)
             run-dir (str base "/wf/issues-run")]
         (.mkdirs (java.io.File. run-dir))
         (spit (str run-dir "/issues.json") "[]")
         (assert (false? (cp/issues-artifact-has-issues? run-dir "issues.json")) "empty issues.json should not be a failure")
         (spit (str run-dir "/issues-real.json") "[{\"title\":\"x\"}]")
         (assert (true? (cp/issues-artifact-has-issues? run-dir "issues-real.json")) "non-empty issues.json should be a failure")
         (spit (str run-dir "/issues-map.json") "{\"issues\":[{\"title\":\"x\"}]}")
         (assert (true? (cp/issues-artifact-has-issues? run-dir "issues-map.json")) "non-empty issues map should be a failure")
         (let [old "2000-01-01T00:00:00Z"
               recent (str (java.time.Instant/now))
               summary {:status "running" :state :work :updated_at old}
               attempts [{:state "work" :status "running" :attempt 1}]]
           (assert (= "orphaned" (:liveness (cp/derive-liveness summary attempts {:last-activity-at old}))) "old heartbeat => orphaned")
           (assert (= "executing" (:liveness (cp/derive-liveness summary attempts {:last-activity-at recent}))) "recent heartbeat => executing"))
         (let [summary {:status "running" :state :work :updated_at "2999-01-01T00:00:00Z"}
               attempts [{:state "work" :status "running" :attempt 1}]]
           (assert (= "executing" (:liveness (cp/derive-liveness summary attempts))) "future updated_at => executing")))'

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
./bin/tesseraft lint test/fixtures/invalid/malformed-resources.workflow.edn >/tmp/tesseraft-invalid-resources-lint.out 2>&1
invalid_resources_status=$?
set -e
if [[ "$invalid_resources_status" -eq 0 ]]; then
  cat /tmp/tesseraft-invalid-resources-lint.out >&2
  echo "Expected invalid resource fixture lint to fail" >&2
  exit 1
fi
if ! grep -q "resource-group-not-vector\|resource-missing-name\|resource-unknown-field\|invalid-resource-path" /tmp/tesseraft-invalid-resources-lint.out; then
  cat /tmp/tesseraft-invalid-resources-lint.out >&2
  echo "Expected invalid resource fixture to report resource diagnostics" >&2
  exit 1
fi
rm -f /tmp/tesseraft-invalid-resources-lint.out

check_invalid_resource_flow() {
  local fixture="$1"
  local expected="$2"
  local output="/tmp/tesseraft-${fixture}-lint.out"
  set +e
  ./bin/tesseraft lint "test/fixtures/invalid/${fixture}.workflow.edn" --format json >"$output" 2>&1
  local status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    cat "$output" >&2
    echo "Expected invalid resource-flow fixture to fail: $fixture" >&2
    exit 1
  fi
  if ! grep -q "$expected" "$output"; then
    cat "$output" >&2
    echo "Expected $fixture to report $expected" >&2
    exit 1
  fi
  rm -f "$output"
}

check_invalid_resource_flow resource-missing-producer resource-missing-producer
check_invalid_resource_flow resource-read-consume-missing-producer resource-missing-producer
check_invalid_resource_flow resource-branch-missing-producer resource-missing-producer
check_invalid_resource_flow resource-double-consume resource-double-consume
check_invalid_resource_flow resource-undeclared-input resource-missing-producer
check_invalid_resource_flow resource-ambient-path-mismatch resource-missing-producer
check_invalid_resource_flow resource-cycle-conservative resource-cycle-conservative

set +e
./bin/tesseraft lint test/fixtures/invalid/resource-warnings.workflow.edn --strict >/tmp/tesseraft-resource-warnings-lint.out 2>&1
resource_warnings_status=$?
set -e
if [[ "$resource_warnings_status" -eq 0 ]]; then
  cat /tmp/tesseraft-resource-warnings-lint.out >&2
  echo "Expected strict resource warning fixture lint to fail" >&2
  exit 1
fi
if ! grep -q "resource-unknown-mode" /tmp/tesseraft-resource-warnings-lint.out || ! grep -q "duplicate-resource-declaration" /tmp/tesseraft-resource-warnings-lint.out; then
  cat /tmp/tesseraft-resource-warnings-lint.out >&2
  echo "Expected resource warning fixture to report unknown mode and duplicate declaration" >&2
  exit 1
fi
rm -f /tmp/tesseraft-resource-warnings-lint.out

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

set +e
./bin/tesseraft node lint test/fixtures/invalid/malformed-resource-node/node.edn >/tmp/tesseraft-invalid-resource-node-lint.out 2>&1
invalid_resource_node_status=$?
set -e
if [[ "$invalid_resource_node_status" -eq 0 ]]; then
  cat /tmp/tesseraft-invalid-resource-node-lint.out >&2
  echo "Expected invalid resource node fixture lint to fail" >&2
  exit 1
fi
if ! grep -q "resource-not-map" /tmp/tesseraft-invalid-resource-node-lint.out; then
  cat /tmp/tesseraft-invalid-resource-node-lint.out >&2
  echo "Expected invalid resource node fixture to report resource-not-map" >&2
  exit 1
fi
rm -f /tmp/tesseraft-invalid-resource-node-lint.out

set +e
./bin/tesseraft node lint test/fixtures/invalid/resource-warning-node/node.edn --strict >/tmp/tesseraft-resource-warning-node-lint.out 2>&1
resource_warning_node_status=$?
set -e
if [[ "$resource_warning_node_status" -eq 0 ]]; then
  cat /tmp/tesseraft-resource-warning-node-lint.out >&2
  echo "Expected strict resource warning node fixture lint to fail" >&2
  exit 1
fi
if ! grep -q "resource-unknown-mode" /tmp/tesseraft-resource-warning-node-lint.out || ! grep -q "duplicate-resource-declaration" /tmp/tesseraft-resource-warning-node-lint.out; then
  cat /tmp/tesseraft-resource-warning-node-lint.out >&2
  echo "Expected resource warning node fixture to report unknown mode and duplicate declaration" >&2
  exit 1
fi
rm -f /tmp/tesseraft-resource-warning-node-lint.out

printf '\nChecking STATUS.edn ↔ README sync...\n'
bb status --check

echo "Smoke checks passed."
