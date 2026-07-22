import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();

test('SC-006 runtime store redacts credential sentinels from durable state and events after reload', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-sc006-redaction-'));
  const runDir = path.join(root, 'runs', 'sc006');
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const credentialsPath = path.join(home, 'credentials.json');
  const projectsDir = path.join(workspace, '.tesseraft', 'projects');
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.writeFileSync(credentialsPath, JSON.stringify({
    version: 1,
    credentials: { SC006_RUNTIME_TOKEN: 'SC006_DURABLE_SECRET_SENTINEL' }
  }));
  fs.writeFileSync(path.join(projectsDir, 'sc006.json'), JSON.stringify({
    project_id: 'sc006',
    name: 'SC006 Redaction',
    workspace_root: '.',
    runs_root: 'runs',
    discovery: { 'workflow-roots': ['examples'], 'tesseraft-home': home },
    connections: { github: { 'credential-ref': 'tesseraft:SC006_RUNTIME_TOKEN' } }
  }));

  const script = String.raw`
(require '[tesseraft.runtime.store :as store])
(let [sentinel "SC006_DURABLE_SECRET_SENTINEL"
      run-dir (System/getenv "SC006_RUN_DIR")
      workspace (System/getenv "SC006_WORKSPACE")
      home (System/getenv "SC006_HOME")
      ctx {:run {:dir run-dir
                 :project-id "sc006"
                 :workspace-root workspace
                 :tesseraft-home home}
           :diagnostics {:message (str "resolver failed with " sentinel)
                         :keep "non-secret-context"}}]
  (store/save-context! ctx)
  (let [loaded (store/load-context run-dir)]
    (store/event! loaded {:event "credential.failure"
                          :details {:message (str "nested failure " sentinel)
                                    :nested [{:token sentinel :keep "event-context"}]}})))
`;
  execFileSync('bb', ['-e', script], {
    cwd: repoRoot,
    env: { ...process.env, SC006_RUN_DIR: runDir, SC006_WORKSPACE: workspace, SC006_HOME: home },
    encoding: 'utf8'
  });

  const state = fs.readFileSync(path.join(runDir, 'state.edn'), 'utf8');
  const events = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8');
  const durable = `${state}\n${events}`;

  assert.doesNotMatch(
    durable,
    /SC006_DURABLE_SECRET_SENTINEL/,
    'SC-006 durable runtime state and events must redact credential sentinel values recursively after reload'
  );
  assert.match(durable, /non-secret-context/);
  assert.match(durable, /event-context/);
});
