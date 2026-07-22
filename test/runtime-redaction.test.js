import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();

test('SC-006 runtime store redacts credential sentinels from durable state and events', () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-sc006-redaction-'));
  const script = String.raw`
(require '[tesseraft.runtime.store :as store])
(def sentinel "SC006_DURABLE_SECRET_SENTINEL")
(def run-dir (System/getenv "SC006_RUN_DIR"))
(def ctx {:run {:dir run-dir}
          :credential-secrets [sentinel]
          :diagnostics {:message (str "resolver failed with " sentinel)
                        :keep "non-secret-context"}})
(store/save-context! ctx)
(store/event! ctx {:event "credential.failure"
                   :details {:message (str "nested failure " sentinel)
                             :nested [{:token sentinel :keep "event-context"}]}})
`;
  execFileSync('bb', ['-e', script], {
    cwd: repoRoot,
    env: { ...process.env, SC006_RUN_DIR: runDir },
    encoding: 'utf8'
  });

  const state = fs.readFileSync(path.join(runDir, 'state.edn'), 'utf8');
  const events = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8');
  const durable = `${state}\n${events}`;

  assert.doesNotMatch(
    durable,
    /SC006_DURABLE_SECRET_SENTINEL/,
    'SC-006 durable runtime state and events must redact credential sentinel values recursively'
  );
  assert.match(durable, /non-secret-context/);
  assert.match(durable, /event-context/);
});
