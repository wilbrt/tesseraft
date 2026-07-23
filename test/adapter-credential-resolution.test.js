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

test('WT2 injectable resolver is shared by selected-project public and adapter consumers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt2-injected-resolver-'));
  const selectedHome = path.join(root, 'selected-home');
  const ambientHome = path.join(root, 'ambient-home');
  const projectsDir = path.join(root, '.tesseraft', 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(ambientHome, { recursive: true });
  fs.writeFileSync(path.join(ambientHome, 'credentials.json'), JSON.stringify({
    version: 1,
    credentials: { github: 'WT2_AMBIENT_SENTINEL_MUST_NOT_BE_USED' }
  }));
  fs.writeFileSync(path.join(projectsDir, 'injected.json'), JSON.stringify({
    project_id: 'injected',
    name: 'Injected resolver project',
    workspace_root: '.',
    runs_root: '.agent-runs',
    discovery: { 'workflow-roots': ['examples'], 'tesseraft-home': selectedHome },
    connections: { github: { 'credential-ref': 'tesseraft:github' } }
  }));

  const script = String.raw`
(require '[cheshire.core :as json])
(require '[clojure.string :as str])
(require '[tesseraft.adapters.builtin :as builtin])
(require '[tesseraft.control-plane.core :as cp])
(require '[tesseraft.control-plane.doctor :as doctor])
(let [root (System/getenv "WT2_ROOT")
      selected-home (System/getenv "WT2_SELECTED_HOME")
      ambient-home (System/getenv "WT2_AMBIENT_HOME")
      sentinel "WT2_SELECTED_PROJECT_FAKE_SENTINEL"
      calls (atom [])
      resolver (fn [options ref]
                 (swap! calls conj {:home (:tesseraft-home options) :ref ref})
                 {:present true :state "present" :credential-ref ref :value sentinel})
      options {:workspace-root root :tesseraft-home ambient-home :credential-resolver resolver}
      project (cp/resolve-project options "injected")
      connections (cp/get-project-connections options "injected")
      report (doctor/doctor-report options "injected")
      adapter-token (builtin/github-token {:run {:project-id "injected"
                                                  :workspace-root root
                                                  :tesseraft-home ambient-home
                                                  :project-context project}
                                             :credential-resolver resolver}
                                            project)
      credential-check (first (filter #(= "github-credential" (get % "id")) (get report "checks")))
      public-json (json/generate-string {:connections connections :doctor report})]
  (assert (= sentinel adapter-token) "adapter did not use the injected resolver")
  (assert (= "present" (get-in connections [:connections :github "credential-state" "state"]))
          "control plane did not use the injected resolver")
  (assert (= "ready" (get credential-check "status")) "doctor did not use the injected resolver")
  (assert (seq @calls) "the fake resolver was not called")
  (assert (every? #(= selected-home (:home %)) @calls)
          (str "a consumer used ambient project options: " (pr-str @calls)))
  (assert (not (str/includes? public-json sentinel)) "public output leaked the selected sentinel")
  (assert (not (str/includes? public-json "WT2_AMBIENT_SENTINEL_MUST_NOT_BE_USED"))
          "public output leaked the ambient sentinel")
  (println (json/generate-string {:ok true :calls (count @calls)})))
`;
  const result = JSON.parse(execFileSync('bb', ['-e', script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      WT2_ROOT: root,
      WT2_SELECTED_HOME: selectedHome,
      WT2_AMBIENT_HOME: ambientHome
    },
    encoding: 'utf8'
  }));

  assert.equal(result.ok, true);
  assert.ok(result.calls >= 3);
});
