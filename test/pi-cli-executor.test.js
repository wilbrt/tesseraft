import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();

function fakePiScript(stdinFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-fake-pi-'));
  const bin = path.join(dir, 'pi');
  fs.writeFileSync(bin, `#!/usr/bin/env bash
cat > "${stdinFile}"
printf 'fake pi completed'
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

const runPiAdapterScript = String.raw`
(require '[tesseraft.executors.pi-cli :as pi]
         '[cheshire.core :as json]
         '[babashka.fs :as fs])

(let [root (System/getenv "PI_TEST_ROOT")
      prompt-path (str (fs/path root "prompt.md.tmpl"))
      _ (fs/create-dirs root)
      _ (spit prompt-path "Design the increment.\n")
      wf {:api-version "tesseraft.workflow/v1"
          :kind :workflow
          :metadata {:name "pi-test"}
          :initial :agent
          :states {:agent {:type :agent
                           :executor :pi-cli
                           :prompt-template prompt-path
                           :outputs {:status {:path "status.json" :required true}}
                           :next :done}
                   :done {:type :terminal}}}
      ctx {:run {:dir root :id "pi-test" :attempt 1 :round 1}
           :inputs {:repo-root root}}
      result (pi/run-agent-node! wf ctx :agent (get-in wf [:states :agent]))]
  (println (json/generate-string result)))
`;

test('pi-cli executor closes unused stdin so print mode can start', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-pi-'));
  const stdinFile = path.join(root, 'stdin.txt');
  const fakeBin = fakePiScript(stdinFile);

  const out = execFileSync('bb', ['--classpath', 'src', '-e', runPiAdapterScript], {
    cwd: repoRoot,
    env: {...process.env, PI_BIN: fakeBin, PI_TEST_ROOT: root},
    encoding: 'utf8',
    timeout: 3000
  });

  const result = JSON.parse(out.trim());
  assert.equal(result.executor, 'pi-cli');
  assert.equal(result.ok, true);
  assert.equal(result['exit-code'], 0);
  assert.equal(result.stdout, undefined);
  assert.equal(fs.readFileSync(stdinFile, 'utf8'), '');
});
