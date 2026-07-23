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

test('SC-006 Jira adapter writes ticket artifacts through runtime redaction', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-sc006-jira-adapter-'));
  const runDir = path.join(root, 'run');
  const sentinel = 'SC006_JIRA_ADAPTER_SECRET_SENTINEL';
  const script = String.raw`
(require '[tesseraft.adapters.builtin :as builtin])
(require '[babashka.fs :as fs])
(let [run-dir (System/getenv "SC006_RUN_DIR")
      sentinel (System/getenv "SC006_SENTINEL")
      ctx {:run {:dir run-dir}
           :inputs {:ticket "TESS-006"}
           :credential-secrets [sentinel]}
      node {:outputs {:ticket-json {:path "ticket.json"}}}]
  (fs/create-dirs run-dir)
  (binding [builtin/*process-extra-env* {"SC006_SENTINEL" sentinel}]
    (builtin/jira-fetch-ticket! nil ctx nil node)))
`;
  execFileSync('bb', ['-e', script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SC006_RUN_DIR: runDir,
      SC006_SENTINEL: sentinel,
      JIRA_FETCH_CMD: 'printf "{\\"ticket\\":\\"TESS-006\\",\\"leak\\":\\"%s\\",\\"keep\\":\\"jira-context\\"}" "$SC006_SENTINEL"'
    },
    encoding: 'utf8'
  });

  const artifact = fs.readFileSync(path.join(runDir, 'ticket.json'), 'utf8');
  assert.doesNotMatch(artifact, new RegExp(sentinel), 'SC-006 Jira ticket artifact must redact resolved credential sentinels');
  assert.match(artifact, /jira-context/);
});

test('SC-006 runtime redacts credential sentinels from prompts, logs, and JSON artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-sc006-sinks-'));
  const runDir = path.join(root, 'run');
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const workflowDir = path.join(root, 'workflow');
  const sentinel = 'SC006_ALL_SINKS_SECRET_SENTINEL';
  fs.mkdirSync(path.join(workspace, '.tesseraft', 'projects'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ version: 1, credentials: { token: sentinel } }));
  fs.writeFileSync(path.join(workspace, '.tesseraft', 'projects', 'sc006.json'), JSON.stringify({
    project_id: 'sc006',
    workspace_root: '.',
    runs_root: 'runs',
    discovery: { 'workflow-roots': ['examples'], 'tesseraft-home': home },
    connections: { github: { 'credential-ref': 'tesseraft:token' } }
  }));
  fs.writeFileSync(path.join(workflowDir, 'prompt.tmpl'), 'Prompt leaks {{inputs.secret}} and keeps prompt-context\n');
  const workflowFile = path.join(workflowDir, 'workflow.edn');
  fs.writeFileSync(workflowFile, '');

  const script = String.raw`
(require '[tesseraft.runtime.store :as store])
(require '[tesseraft.runtime.core :as runtime])
(require '[tesseraft.executors.pi-cli :as pi-cli])
(require '[babashka.fs :as fs])
(let [sentinel (System/getenv "SC006_SENTINEL")
      run-dir (System/getenv "SC006_RUN_DIR")
      workspace (System/getenv "SC006_WORKSPACE")
      home (System/getenv "SC006_HOME")
      wf {:__file (System/getenv "SC006_WF_FILE") :__dir (System/getenv "SC006_WF_DIR")}
      ctx {:run {:dir run-dir :id "sc006" :attempt 1 :project-id "sc006" :workspace-root workspace :tesseraft-home home :issues-file (str (fs/path run-dir "issues.json"))}
           :inputs {:secret sentinel}
           :credential-secrets [sentinel]}]
  (store/ensure-run-dirs! ctx)
  (pi-cli/render-prompt! wf ctx :agent {:prompt-template "prompt.tmpl"})
  (runtime/run-process-node! wf ctx :proc {:command ["bash" "-lc" "printf '{\"status\":\"ok\",\"leak\":\"%s\",\"keep\":\"process-context\"}' \"$SC006_SENTINEL\"; printf '%s' \"$SC006_SENTINEL\" >&2"]})
  (store/write-runtime-json! ctx (fs/path run-dir "artifacts" "direct.json") {:nested [{:secret sentinel :keep "artifact-context"}]})
  nil)
`;
  execFileSync('bb', ['-e', script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SC006_RUN_DIR: runDir,
      SC006_WORKSPACE: workspace,
      SC006_HOME: home,
      SC006_WF_FILE: workflowFile,
      SC006_WF_DIR: workflowDir,
      SC006_SENTINEL: sentinel
    },
    encoding: 'utf8'
  });

  const durable = fs.readdirSync(runDir, { recursive: true })
    .filter((entry) => fs.statSync(path.join(runDir, entry)).isFile())
    .map((entry) => fs.readFileSync(path.join(runDir, entry), 'utf8'))
    .join('\n');
  assert.doesNotMatch(durable, new RegExp(sentinel), 'SC-006 durable prompts, logs, and artifacts must redact credential sentinels');
  assert.match(durable, /prompt-context/);
  assert.match(durable, /process-context/);
  assert.match(durable, /artifact-context/);
});

test('WT2 injected resolver failures are safe and live resolver secrets redact durable output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt2-resolver-failure-'));
  const runDir = path.join(root, 'run');
  const sentinel = 'WT2_INJECTED_RESOLVER_FAILURE_SENTINEL';
  const script = String.raw`
(require '[babashka.fs :as fs])
(require '[cheshire.core :as json])
(require '[clojure.string :as str])
(require '[tesseraft.control-plane.core :as cp])
(require '[tesseraft.runtime.store :as store])
(let [run-dir (System/getenv "WT2_RUN_DIR")
      sentinel (System/getenv "WT2_SENTINEL")
      resolver (fn [_options ref]
                 (if (= ref "tesseraft:failure")
                   (throw (ex-info (str "resolver exploded with " sentinel)
                                   {:nested {:secret sentinel}}))
                   {:present true :state "present" :credential-ref ref :value sentinel}))
      failure (cp/mask-credential {:credential-resolver resolver} "tesseraft:failure")
      project {:project_id "injected"
               :workspace_root "."
               :runs_root ".agent-runs"
               :discovery {:workflow-roots ["examples"]}
               :connections {:github {:credential-ref "tesseraft:success"}
                             :jira {:credential-ref "tesseraft:failure"}}}
      ctx {:run {:dir run-dir
                 :project-id "injected"
                 :project-context project}
           :credential-resolver resolver
           :diagnostics {:failure failure
                         :message (str "consumer failure included " sentinel)
                         :keep "state-context"}}]
  (fs/create-dirs run-dir)
  (store/save-context! ctx)
  (store/event! ctx {:event "credential.failure"
                     :failure failure
                     :message (str "event failure included " sentinel)
                     :keep "event-context"})
  (let [public-json (json/generate-string (cp/api-value failure))]
    (assert (= "invalid" (:state failure)) "resolver failure was not classified safely")
    (assert (not (str/includes? public-json sentinel)) "public resolver failure leaked its sentinel")
    (println public-json)))
`;
  const publicFailure = execFileSync('bb', ['-e', script], {
    cwd: repoRoot,
    env: { ...process.env, WT2_RUN_DIR: runDir, WT2_SENTINEL: sentinel },
    encoding: 'utf8'
  }).trim();
  const state = fs.readFileSync(path.join(runDir, 'state.edn'), 'utf8');
  const events = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8');
  const durable = `${state}\n${events}`;

  assert.doesNotMatch(publicFailure, new RegExp(sentinel));
  assert.doesNotMatch(durable, new RegExp(sentinel));
  assert.doesNotMatch(state, /credential-resolver/, 'ephemeral resolver functions must not be persisted');
  assert.match(durable, /state-context/);
  assert.match(durable, /event-context/);
});
