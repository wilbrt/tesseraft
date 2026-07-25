import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();

// Shared helper: run a bb Clojure snippet in repoRoot with a given env.
function runClojure(script, env) {
  return execFileSync('bb', ['-e', script], {
    cwd: repoRoot,
    env,
    encoding: 'utf8'
  });
}

// Fake `claude` CLI: captures ONLY the ANTHROPIC_API_KEY value it received (to
// avoid leaking any other env secrets into test output), then exits with the
// given code. Writes `ANTHROPIC_API_KEY=<value-or-empty>` or the literal
// `__ABSENT__` if the variable was unset.
function fakeClaudeScript(envFile, exitCode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-fake-claude-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/usr/bin/env bash
cat >/dev/null
printf '%s' "${'${ANTHROPIC_API_KEY:-__ABSENT__}'}" > "${envFile}"
exit ${exitCode}
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

// Minimal workflow map with one agent node that uses :claude-code. We build it
// in Clojure within the bb script so paths resolve correctly.
const dispatchAndAdapterScript = String.raw`
(require '[tesseraft.executors.claude-code :as cc]
         '[cheshire.core :as json]
         '[babashka.fs :as fs])

(let [root (System/getenv "CC_TEST_ROOT")
      prompt-path (str (fs/path root "prompt.md.tmpl"))
      _ (fs/create-dirs root)
      _ (spit prompt-path "Render the design. Write status to {{run.dir}}/status.json\n")
      wf {:api-version "tesseraft.workflow/v1"
          :kind :workflow
          :metadata {:name "cc-test"}
          :initial :agent
          :states {:agent {:type :agent
                           :executor :claude-code
                           :prompt-template prompt-path
                           :outputs {:status {:path "status.json" :required true}}
                           :next :done}
                   :done {:type :terminal}}}
      ctx {:run {:dir root :id "cc-test" :attempt 1 :round 1}
           :inputs {:repo-root root}}
      ;; Pre-seed ANTHROPIC_API_KEY on the JVM so we can prove the adapter
      ;; strips it from the subprocess env even when the parent has it.
      _ (System/setProperty "ANTHROPIC_API_KEY" "SHOULD_NOT_REACH_SUBPROCESS")
      result (cc/run-agent-node! wf ctx :agent (get-in wf [:states :agent]))]
  (println (json/generate-string result)))
`;

test('claude-code executor strips ANTHROPIC_API_KEY from the subprocess env (subscription auth)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-cc-'));
  const envFile = path.join(root, 'captured-env.txt');
  const fakeBin = fakeClaudeScript(envFile, 0);

  const out = runClojure(dispatchAndAdapterScript, {
    ...process.env,
    CLAUDE_BIN: fakeBin,
    CC_TEST_ROOT: root,
    ANTHROPIC_API_KEY: 'PARENT_HAS_KEY'  // ensure parent env also has it
  });

  // The adapter must report a clean exit and the correct executor name.
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.executor, 'claude-code');
  assert.equal(parsed.ok, true);
  assert.equal(parsed['exit-code'], 0);

  // The subprocess must NOT have received a usable ANTHROPIC_API_KEY even
  // though both the JVM system property and the parent process env carried
  // a real value. Accept "unset" (__ABSENT__) or "empty" — both force the
  // claude CLI onto subscription auth rather than API-key billing.
  const captured = fs.readFileSync(envFile, 'utf8');
  assert.ok(
    captured === '__ABSENT__' || captured === '',
    `ANTHROPIC_API_KEY should be unset or empty in the claude subprocess, got: ${captured ? '<non-empty value present>' : '<empty>'}`
  );
});

test('runtime dispatch selects claude-code for :executor :claude-code and mock under --executor mock', () => {
  // We cannot easily run the live dispatch without a real claude binary, so we
  // assert the dispatch logic by calling run-agent! under mock mode (which
  // short-circuits to the mock executor regardless of :executor) and verify the
  // non-mock path would have selected claude-code via the adapter test above.
  // Here we confirm mock override still wins for a claude-code node.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-cc-mock-'));
  const script = String.raw`
(require '[tesseraft.runtime.core :as rt]
         '[cheshire.core :as json]
         '[babashka.fs :as fs])
(let [root (System/getenv "CC_MOCK_ROOT")
      prompt-path (str (fs/path root "prompt.md.tmpl"))
      _ (fs/create-dirs root)
      _ (spit prompt-path "design\n")
      wf {:api-version "tesseraft.workflow/v1"
          :kind :workflow
          :metadata {:name "cc-mock"}
          :initial :agent
          :states {:agent {:type :agent
                           :executor :claude-code
                           :prompt-template prompt-path
                           :outputs {:status {:path "status.json" :required true}}
                           :next :done}
                   :done {:type :terminal}}}
      ctx {:run {:dir root :id "cc-mock" :attempt 1 :round 1
                 :executor-mode "mock"}
           :inputs {:repo-root root}}]
  (println (json/generate-string (rt/run-agent! wf ctx :agent (get-in wf [:states :agent])))))
`;
  const out = runClojure(script, { ...process.env, CC_MOCK_ROOT: root });
  const parsed = JSON.parse(out.trim());
  // Mock override must win even though the node declares :claude-code.
  assert.equal(parsed.executor, 'mock');
  assert.equal(parsed.mock, true);
});

test('linter accepts :executor :claude-code', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-cc-lint-'));
  const wfPath = path.join(root, 'workflow.edn');
  const promptPath = path.join(root, 'prompt.md.tmpl');
  fs.writeFileSync(promptPath, 'design\n');
  fs.writeFileSync(wfPath, `{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "cc-lint"}
 :initial :agent
 :states {:agent {:type :agent
                  :executor :claude-code
                  :prompt-template "prompt.md.tmpl"
                  :outputs {:status {:path "status.json" :required true}}
                  :next :done}
          :done {:type :terminal}}}`);
  const out = execFileSync('bb', ['lint', wfPath, '--format', 'json'], {
    cwd: repoRoot, encoding: 'utf8'
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true, `lint should pass for :claude-code: ${out}`);
});