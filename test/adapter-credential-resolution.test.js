import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();

test('SC-001 GitHub adapter resolves tesseraft refs from the selected project local store', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-sc001-adapter-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({
    version: 1,
    credentials: { SC001_ADAPTER_TOKEN: 'SC001_ADAPTER_LOCAL_SENTINEL' }
  }));

  const script = String.raw`
(require '[tesseraft.adapters.builtin :as builtin])
(let [token (builtin/github-token
              {:run {:project-id "sc001-adapter"
                     :tesseraft-home (System/getenv "SC001_ADAPTER_HOME")}}
              {:project_id "sc001-adapter"
               :connections {:github {:credential-ref "tesseraft:SC001_ADAPTER_TOKEN"}}})]
  (println (pr-str token)))
`;
  const output = execFileSync('bb', ['-e', script], {
    cwd: repoRoot,
    env: { ...process.env, SC001_ADAPTER_HOME: home },
    encoding: 'utf8'
  }).trim();

  assert.equal(output, '"SC001_ADAPTER_LOCAL_SENTINEL"');
});
