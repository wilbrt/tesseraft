import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();

function fakeOpenCodeScript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-fake-opencode-'));
  const bin = path.join(dir, 'opencode');
  fs.writeFileSync(bin, `#!/usr/bin/env bash
printf '%s\n' "$@" > "$OC_ARGS_FILE"
cat > "$OC_STDIN_FILE"
printf '%s' "\${XDG_CONFIG_HOME:-}" > "$OC_CONFIG_HOME_FILE"
printf '%s' "\${OPENCODE_CONFIG_CONTENT:-}" > "$OC_CONFIG_FILE"
printf '%s\n' "\${OPENCODE_DISABLE_PROJECT_CONFIG:-}" "\${OPENCODE_DISABLE_CLAUDE_CODE:-}" "\${OPENCODE_DISABLE_AUTOUPDATE:-}" > "$OC_FLAGS_FILE"
printf '%s\n' '{"type":"step_start","sessionID":"ses_tesseraft_123"}'
printf '%s\n' '{"type":"step_finish","sessionID":"ses_tesseraft_123","part":{"tokens":{"input":7,"output":3},"cost":0.01}}'
exit "\${OC_EXIT_CODE:-0}"
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function invocationFiles(root) {
  return {
    args: path.join(root, 'args.txt'),
    stdin: path.join(root, 'stdin.txt'),
    configHome: path.join(root, 'config-home.txt'),
    config: path.join(root, 'config.json'),
    flags: path.join(root, 'flags.txt')
  };
}

const runAdapterScript = String.raw`
(require '[tesseraft.executors.opencode-cli :as opencode]
         '[cheshire.core :as json]
         '[babashka.fs :as fs])

(let [root (System/getenv "OC_TEST_ROOT")
      prompt-path (str (fs/path root "prompt.md.tmpl"))
      _ (fs/create-dirs root)
      _ (spit prompt-path "Implement the feature. Write {{run.dir}}/status.json\n")
      wf {:api-version "tesseraft.workflow/v1"
          :kind :workflow
          :metadata {:name "opencode-test"}
          :initial :agent
          :states {:agent {:type :agent
                           :executor :opencode-cli
                           :provider "openai"
                           :model "gpt-5"
                           :thinking "high"
                           :tools [:read :bash :write]
                           :prompt-template prompt-path
                           :outputs {:status {:path "status.json" :required true}}
                           :next :done}
                   :done {:type :terminal}}}
      ctx {:run {:dir root :id "opencode-test" :attempt 1 :round 1}
           :inputs {:repo-root root}}
      result (opencode/run-agent-node! wf ctx :agent (get-in wf [:states :agent]))]
  (println (json/generate-string result)))
`;

function runAdapter(root, exitCode = 0) {
  const files = invocationFiles(root);
  const output = execFileSync('bb', ['--classpath', 'src', '-e', runAdapterScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENCODE_BIN: fakeOpenCodeScript(),
      OC_TEST_ROOT: root,
      OC_ARGS_FILE: files.args,
      OC_STDIN_FILE: files.stdin,
      OC_CONFIG_HOME_FILE: files.configHome,
      OC_CONFIG_FILE: files.config,
      OC_FLAGS_FILE: files.flags,
      OC_EXIT_CODE: String(exitCode)
    },
    encoding: 'utf8'
  });
  return { result: JSON.parse(output.trim()), files };
}

test('opencode-cli runs headlessly with an isolated, least-privilege agent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-opencode-'));
  const { result, files } = runAdapter(root);

  assert.equal(result.executor, 'opencode-cli');
  assert.equal(result.ok, true);
  assert.equal(result['exit-code'], 0);
  assert.equal(result['resolved-model'], 'openai/gpt-5');
  assert.equal(result.thinking, 'high');
  assert.equal(result['session-id'], 'ses_tesseraft_123');
  assert.equal(result['event-count'], 2);
  assert.equal(result['malformed-event-count'], 0);
  assert.deepEqual(result.tokens, { input: 7, output: 3 });
  assert.equal(result.cost, 0.01);

  const args = fs.readFileSync(files.args, 'utf8').trim().split('\n');
  assert.deepEqual(args.slice(0, 7), ['run', '--format', 'json', '--title', 'opencode-test-agent-1', '--dir', root]);
  assert.ok(args.includes('--agent'));
  assert.equal(args[args.indexOf('--agent') + 1], 'tesseraft');
  assert.ok(args.includes('--pure'));
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.equal(args[args.indexOf('--model') + 1], 'openai/gpt-5');
  assert.equal(args[args.indexOf('--variant') + 1], 'high');

  assert.match(fs.readFileSync(files.stdin, 'utf8'), /Implement the feature/);
  assert.match(fs.readFileSync(files.configHome, 'utf8'), /opencode-sessions\/agent-1\/config$/);
  assert.deepEqual(fs.readFileSync(files.flags, 'utf8').trim().split('\n'), ['true', 'true', 'true']);

  const config = JSON.parse(fs.readFileSync(files.config, 'utf8'));
  const permission = config.agent.tesseraft.permission;
  assert.equal(permission['*'], 'deny');
  assert.equal(permission.read, 'allow');
  assert.equal(permission.bash, 'allow');
  assert.equal(permission.edit, 'allow');
  assert.equal(permission.question, undefined);
  assert.equal(permission.task, undefined);

  const events = fs.readFileSync(result['events-file'], 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 2);
  assert.equal(events[0].sessionID, 'ses_tesseraft_123');
  assert.equal(result.stdout, undefined);
});

test('opencode-cli normalizes a nonzero OpenCode exit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-opencode-fail-'));
  const { result } = runAdapter(root, 17);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.equal(result.category, 'process');
  assert.equal(result.code, 'executor_process_failed');
  assert.equal(result['exit-code'], 17);
});

test('the pinned OpenCode binary ignores repository configuration for Tesseraft runs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-opencode-config-'));
  const configHome = path.join(root, 'config-home');
  const dataHome = path.join(root, 'data-home');
  fs.mkdirSync(configHome, { recursive: true });
  fs.mkdirSync(dataHome, { recursive: true });
  fs.writeFileSync(path.join(root, 'opencode.json'), JSON.stringify({
    agent: { tesseraft: { permission: { bash: 'allow', task: 'allow' } } }
  }));

  const env = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      agent: {
        tesseraft: {
          description: 'Tesseraft workflow agent',
          mode: 'primary',
          permission: { '*': 'deny', read: 'allow' }
        }
      }
    })
  };
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_DIR;
  delete env.OPENCODE_PERMISSION;

  const output = execFileSync(path.join(repoRoot, 'node_modules', '.bin', 'opencode'), ['debug', 'config'], {
    cwd: root,
    env,
    encoding: 'utf8'
  });
  const config = JSON.parse(output);
  assert.deepEqual(config.agent.tesseraft.permission, { '*': 'deny', read: 'allow' });
});

test('opencode-cli model forms are validated by the workflow linter', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-opencode-lint-'));
  const prompt = path.join(root, 'prompt.md.tmpl');
  fs.writeFileSync(prompt, 'work\n');
  const script = String.raw`
(require '[tesseraft.lint.core :as lint]
         '[cheshire.core :as json])
(let [prompt (System/getenv "OC_LINT_PROMPT")
      base {:api-version "tesseraft.workflow/v1"
            :kind :workflow
            :metadata {:name "opencode-lint"}
            :initial :agent
            :states {:agent {:type :agent
                             :executor :opencode-cli
                             :prompt-template prompt
                             :outputs {:status {:path "status.json" :required true}}
                             :next :done}
                     :done {:type :terminal}}}
      result (fn [settings]
               (lint/lint-workflow (update-in base [:states :agent] merge settings)))]
  (println (json/generate-string
             {:composed (result {:provider "openai" :model "gpt-5"})
              :qualified (result {:model "anthropic/claude-sonnet-4"})
              :provider-only (result {:provider "openai"})
              :unqualified (result {:model "gpt-5"})
              :whitespace (result {:provider "openai" :model "gpt 5"})
              :mismatch (result {:provider "openai" :model "anthropic/claude-sonnet-4"})})))
`;
  const output = execFileSync('bb', ['--classpath', 'src', '-e', script], {
    cwd: repoRoot,
    env: { ...process.env, OC_LINT_PROMPT: prompt },
    encoding: 'utf8'
  });
  const results = JSON.parse(output.trim());
  assert.equal(results.composed.ok, true);
  assert.equal(results.qualified.ok, true);
  assert.ok(results['provider-only'].errors.some((error) => error.code === 'invalid-opencode-model'));
  assert.ok(results.unqualified.errors.some((error) => error.code === 'invalid-opencode-model'));
  assert.ok(results.whitespace.errors.some((error) => error.code === 'invalid-opencode-model'));
  assert.ok(results.mismatch.errors.some((error) => error.code === 'opencode-provider-model-mismatch'));
});
