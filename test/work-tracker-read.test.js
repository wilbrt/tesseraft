import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const q = (value) => JSON.stringify(value);

const bbJson = (script, env = {}) => JSON.parse(execFileSync('bb', ['-e', script], {
  cwd: repoRoot,
  env: { ...process.env, ...env },
  encoding: 'utf8'
}));

const writeProject = (root, id, tokenRef = `env:${id.toUpperCase()}_PLANE_TOKEN`, apiBaseUrl = 'https://api.plane.so/root') => {
  const projectRoot = path.join(root, 'projects', id);
  const projectDir = path.join(projectRoot, '.tesseraft');
  const registryPath = path.join(root, 'home', 'projects', 'registry.json');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify({
    version: 2,
    project_id: id,
    name: id,
    runs_root: 'runs',
    connections: {
      'work-tracker': {
        provider: 'plane',
        'credential-ref': tokenRef,
        config: { 'api-base-url': apiBaseUrl, 'workspace-slug': `${id}-ws`, 'project-id': `${id}-project` }
      }
    }
  }, null, 2));
  const registry = fs.existsSync(registryPath)
    ? JSON.parse(fs.readFileSync(registryPath, 'utf8'))
    : { version: 2, projects: {} };
  registry.projects[id] = { workspace_root: projectRoot };
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
};

const REMOTE_ID = '123e4567-e89b-12d3-a456-426614174000';
const OTHER_REMOTE_ID = '123e4567-e89b-12d3-a456-426614174001';

const fetchScript = ({ root, projectId = 'alpha', itemId = REMOTE_ID, status = 200, body, headers = {}, token = 'TOKEN_SENTINEL', mock = false }) => `
(require '[cheshire.core :as json])
(require '[tesseraft.adapters.builtin :as builtin])
(require '[tesseraft.control-plane.core :as cp])
(require '[tesseraft.runtime.store :as store])
(require '[tesseraft.work-tracker.plane :as plane])
(def root ${q(root)})
(def run-dir (str root "/runs/work-tracker-read"))
(def calls (atom []))
(def resolver (fn [options ref]
                (swap! calls conj {:workspace-root (:workspace-root options) :ref ref})
                {:present true :state "present" :credential-ref ref :value ${q(token)}}))
(def options {:workspace-root root :tesseraft-home (str root "/home")})
(def project (cp/resolve-project options ${q(projectId)}))
(def ctx {:run {:dir run-dir :project-id ${q(projectId)} :workspace-root root
                :tesseraft-home (str root "/home") :project-context project}
          :inputs {}
          :credential-resolver resolver})
(def node {:handler :work-tracker/fetch-item
           :inputs {:item-id ${q(itemId)}}
           :outputs {:work-item {:path "work-tracker/item.json"}}})
(binding [plane/*http-request* (fn [request]
                                 (swap! calls conj {:request request})
                                 {:status ${status} :headers ${prStr(headers)} :body ${q(body ?? '')}})]
  (def result (builtin/run-handler! nil ctx :fetch node {:mock? ${mock ? 'true' : 'false'}})))
(def artifact (store/read-json (str run-dir "/work-tracker/item.json")))
(println (json/generate-string {:result result :artifact artifact :calls @calls :run-dir run-dir}))
`;

function prStr(value) {
  if (Array.isArray(value)) return `[${value.map(prStr).join(' ')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).map(([k, v]) => `${q(k)} ${prStr(v)}`).join(' ')}}`;
  }
  return q(value);
}

test('WT5 normalizes a Plane item and persists only the allowlisted artifact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt5-normalize-'));
  writeProject(root, 'alpha');
  const planeBody = JSON.stringify({
    id: REMOTE_ID, identifier: 'ALPHA-7', name: 'Fix WT5', description_stripped: 'Safe description',
    state: { name: 'In Progress', SECRET_PRIVATE_FIELD: 'RAW_RESPONSE_SENTINEL' }, priority: 'high',
    assignee_details: [{ id: 'user-1', display_name: 'Ada' }], label_details: [{ name: 'bug', color: '#f00' }],
    url: 'https://app.plane.so/alpha/ALPHA-7', access_token: 'RAW_RESPONSE_SENTINEL'
  });
  const out = bbJson(fetchScript({ root, body: planeBody, token: 'WT5_TOKEN_SENTINEL' }));
  assert.equal(out.result.status, 'ok');
  assert.equal(out.artifact.schema_version, 1);
  assert.equal(out.artifact.provider, 'plane');
  assert.deepEqual(out.artifact.project, { id: 'alpha' });
  assert.deepEqual(out.artifact.remote, { id: REMOTE_ID, identifier: 'ALPHA-7', workspace_slug: 'alpha-ws', project_id: 'alpha-project' });
  assert.equal(out.artifact.identifier, 'ALPHA-7');
  assert.equal(out.artifact.title, 'Fix WT5');
  assert.equal(out.artifact.state.name, 'In Progress');
  assert.deepEqual(out.artifact.assignees, [{ id: 'user-1', display_name: 'Ada' }]);
  assert.deepEqual(out.artifact.labels, [{ name: 'bug', color: '#f00' }]);
  const durable = fs.readFileSync(path.join(out['run-dir'], 'work-tracker', 'item.json'), 'utf8');
  assert.doesNotMatch(durable, /WT5_TOKEN_SENTINEL|RAW_RESPONSE_SENTINEL|access_token|SECRET_PRIVATE_FIELD/);
});

test('WT5 Plane request uses project-scoped credentials, X-API-Key, and safe URL joining', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt5-isolation-'));
  writeProject(root, 'alpha', 'env:ALPHA_TOKEN', 'https://plane.self.hosted/custom/');
  writeProject(root, 'beta', 'env:BETA_TOKEN', 'https://plane.self.hosted/other');
  const out = bbJson(fetchScript({ root, projectId: 'alpha', itemId: OTHER_REMOTE_ID, body: JSON.stringify({ id: OTHER_REMOTE_ID, name: 'T' }), token: 'ALPHA_SECRET' }));
  const request = out.calls.find((call) => call.request).request;
  const resolverCall = out.calls.find((call) => call.ref);
  assert.equal(resolverCall.ref, 'env:ALPHA_TOKEN');
  assert.equal(request.headers['X-API-Key'], 'ALPHA_SECRET');
  assert.equal(request['timeout-ms'], 5000, 'Plane HTTP requests are bounded by the default timeout');
  assert.match(request.url, new RegExp(`^https:\\/\\/plane\\.self\\.hosted\\/custom\\/api\\/v1\\/workspaces\\/alpha-ws\\/projects\\/alpha-project\\/issues\\/${OTHER_REMOTE_ID}\\/$`));
  assert.equal(out.artifact.project.id, 'alpha');
  assert.equal(out.artifact.remote.project_id, 'alpha-project');
  assert.equal(out.artifact.remote.workspace_slug, 'alpha-ws');
  assert.doesNotMatch(request.url, /ALPHA_SECRET|BETA_TOKEN|BETA_SECRET/);
});

test('WT5 Plane request clamps oversized timeout overrides', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt5-timeout-clamp-'));
  writeProject(root, 'alpha');
  const script = fetchScript({ root, body: JSON.stringify({ id: REMOTE_ID, name: 'T' }) }).replace(
    `:inputs {:item-id ${q(REMOTE_ID)}}`,
    `:inputs {:item-id ${q(REMOTE_ID)} :timeout-ms 600000}`
  );
  const out = bbJson(script);
  const request = out.calls.find((call) => call.request).request;
  assert.equal(request['timeout-ms'], 10000, 'oversized timeout-ms is clamped to the documented maximum');
});

test('WT5 prefers non-empty expanded Plane assignee and label details over base ID arrays', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt5-expanded-details-'));
  writeProject(root, 'alpha');
  const planeBody = JSON.stringify({
    id: REMOTE_ID,
    identifier: 'ALPHA-8',
    name: 'Expanded details',
    assignees: ['base-user-id'],
    assignee_details: [{ id: 'expanded-user-id', display_name: 'Grace' }],
    labels: ['base-label-id'],
    label_details: [{ id: 'expanded-label-id', name: 'feature', color: '#0f0' }]
  });
  const out = bbJson(fetchScript({ root, body: planeBody }));
  assert.equal(out.result.status, 'ok');
  assert.deepEqual(out.artifact.assignees, [{ id: 'expanded-user-id', display_name: 'Grace' }]);
  assert.deepEqual(out.artifact.labels, [{ id: 'expanded-label-id', name: 'feature', color: '#0f0' }]);
});

test('WT5 preserves Plane assignee and label IDs when only relationship arrays are present', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt5-id-fallbacks-'));
  writeProject(root, 'alpha');
  const planeBody = JSON.stringify({
    id: REMOTE_ID,
    identifier: 'ALPHA-9',
    name: 'ID fallbacks',
    assignees: ['user-id-only'],
    labels: ['label-id-only']
  });
  const out = bbJson(fetchScript({ root, body: planeBody }));
  assert.equal(out.result.status, 'ok');
  assert.deepEqual(out.artifact.assignees, [{ id: 'user-id-only' }]);
  assert.deepEqual(out.artifact.labels, [{ id: 'label-id-only' }]);
});

test('WT5 constructs a human identifier from numeric Plane sequence IDs when no identifier is present', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt5-sequence-id-'));
  writeProject(root, 'alpha');
  const planeBody = JSON.stringify({
    id: REMOTE_ID,
    sequence_id: 42,
    project_detail: { identifier: 'ALPHA' },
    name: 'Numeric sequence'
  });
  const out = bbJson(fetchScript({ root, body: planeBody }));
  assert.equal(out.result.status, 'ok');
  assert.equal(out.artifact.identifier, 'ALPHA-42');
  assert.equal(out.artifact.remote.identifier, 'ALPHA-42');
  assert.notEqual(out.artifact.identifier, REMOTE_ID);
});

test('WT5 mock mode is offline and does not resolve credentials or HTTP', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt5-mock-'));
  writeProject(root, 'alpha');
  const script = `
(require '[cheshire.core :as json])
(require '[tesseraft.adapters.builtin :as builtin])
(require '[tesseraft.runtime.store :as store])
(require '[tesseraft.work-tracker.plane :as plane])
(def run-dir (str ${q(root)} "/run"))
(def resolver-calls (atom 0))
(def http-calls (atom 0))
(def ctx {:run {:dir run-dir :project-id "alpha" :workspace-root ${q(root)}}
          :credential-resolver (fn [& _]
                                 (swap! resolver-calls inc)
                                 (throw (ex-info "resolver must not be called" {})))})
(def node {:handler :work-tracker/fetch-item :inputs {:item-id "MOCK-42"} :outputs {:work-item {:path "item.json"}}})
(binding [plane/*http-request* (fn [_]
                                 (swap! http-calls inc)
                                 (throw (ex-info "http must not be called" {})))]
  (def result (builtin/run-handler! nil ctx :fetch node {:mock? true})))
(println (json/generate-string {:result result
                                :artifact (store/read-json (str run-dir "/item.json"))
                                :resolver-calls @resolver-calls
                                :http-calls @http-calls}))
`;
  const out = bbJson(script);
  assert.equal(out.result.mock, true);
  assert.equal(out.artifact.identifier, 'MOCK-42');
  assert.equal(out['resolver-calls'], 0);
  assert.equal(out['http-calls'], 0);
});

test('WT5 Plane failures are stable, bounded, and redacted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt5-failures-'));
  writeProject(root, 'alpha');
  for (const [name, status, body, expected, headers] of [
    ['malformed JSON', 200, '{bad json TOKEN_SENTINEL}', 'malformed_json', {}],
    ['401', 401, 'SECRET BODY', 'unauthorized', {}],
    ['404', 404, 'SECRET BODY', 'not_found', {}],
    ['429', 429, 'SECRET BODY', 'rate_limited', { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1710000000' }],
    ['5xx', 503, 'SERVER SECRET BODY', 'server_error', {}]
  ]) {
    const out = bbJson(fetchScript({ root, body, status, headers, token: `${name}-TOKEN` }));
    assert.equal(out.artifact.status, 'error', name);
    assert.equal(out.artifact.category, expected, name);
    if (status === 429) assert.deepEqual(out.artifact.rate_limit, { remaining: '0', reset: '1710000000' });
    const durable = fs.readFileSync(path.join(out['run-dir'], 'work-tracker', 'item.json'), 'utf8');
    assert.doesNotMatch(durable, /SECRET BODY|SERVER SECRET BODY|TOKEN_SENTINEL|access_token/);
  }
});

test('WT5 Plane rejects invalid timeout overrides without issuing HTTP', () => {
  const script = `
(require '[cheshire.core :as json])
(require '[tesseraft.work-tracker.plane :as plane])
(def calls (atom 0))
(binding [plane/*http-request* (fn [_] (swap! calls inc) {:status 200 :body "{}"})]
  (println (json/generate-string {:result (plane/fetch-item {:tracker {:provider "plane"
                                                                       :config {:api-base-url "https://api.plane.so"
                                                                                :workspace-slug "ws"
                                                                                :project-id "pid"}}
                                                           :api-key "TOKEN_SENTINEL"
                                                           :item-id ${q(REMOTE_ID)}
                                                           :timeout-ms "not-a-duration"})
                                 :calls @calls})))
`;
  const out = bbJson(script);
  assert.equal(out.result.status, 'error');
  assert.equal(out.result.category, 'invalid_timeout');
  assert.equal(out.calls, 0, 'invalid timeout-ms is rejected before HTTP');
  assert.doesNotMatch(JSON.stringify(out), /TOKEN_SENTINEL/);
});

test('WT5 Plane rejects human identifiers without issuing HTTP', () => {
  const script = `
(require '[cheshire.core :as json])
(require '[tesseraft.work-tracker.plane :as plane])
(def calls (atom 0))
(binding [plane/*http-request* (fn [_] (swap! calls inc) {:status 200 :body "{}"})]
  (println (json/generate-string {:result (plane/fetch-item {:tracker {:provider "plane"
                                                                       :config {:api-base-url "https://api.plane.so"
                                                                                :workspace-slug "ws"
                                                                                :project-id "pid"}}
                                                           :api-key "TOKEN_SENTINEL"
                                                           :item-id "ISS-1"
                                                           :timeout-ms 10})
                                 :calls @calls})))
`;
  const out = bbJson(script);
  assert.equal(out.result.status, 'error');
  assert.equal(out.result.category, 'invalid_item_id');
  assert.equal(out.calls, 0, 'human identifiers are not sent to the direct /issues/{remote-id}/ endpoint');
  assert.doesNotMatch(JSON.stringify(out), /TOKEN_SENTINEL/);
});

test('WT5 runtime ignores legacy ticket/identifier aliases instead of treating them as Plane remote IDs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt5-aliases-'));
  writeProject(root, 'alpha');
  const script = `
(require '[cheshire.core :as json])
(require '[tesseraft.adapters.builtin :as builtin])
(require '[tesseraft.runtime.store :as store])
(require '[tesseraft.work-tracker.plane :as plane])
(def run-dir (str ${q(root)} "/runs/work-tracker-read"))
(def ctx {:run {:dir run-dir :project-id "alpha" :workspace-root ${q(root)}}
          :inputs {:ticket "ALPHA-7"}
          :credential-resolver (fn [_ ref] {:present true :state "present" :credential-ref ref :value "TOKEN_SENTINEL"})})
(def node {:handler :work-tracker/fetch-item :inputs {:identifier "ALPHA-7"} :outputs {:work-item {:path "work-tracker/item.json"}}})
(binding [plane/*http-request* (fn [_] (throw (ex-info "http must not be called" {})))]
  (def result (builtin/run-handler! nil ctx :fetch node {:mock? false})))
(println (json/generate-string {:result result :artifact (store/read-json (str run-dir "/work-tracker/item.json"))}))
`;
  const out = bbJson(script);
  assert.equal(out.artifact.category, 'missing_item');
  assert.doesNotMatch(JSON.stringify(out), /TOKEN_SENTINEL/);
});

test('WT5 Plane timeout becomes a stable redacted failure', () => {
  const script = `
(require '[cheshire.core :as json])
(require '[tesseraft.work-tracker.plane :as plane])
(binding [plane/*http-request* (fn [_] {:error :timeout :message "TOKEN_SENTINEL raw timeout"})]
  (println (json/generate-string (plane/fetch-item {:tracker {:provider "plane"
                                                              :config {:api-base-url "https://api.plane.so"
                                                                       :workspace-slug "ws"
                                                                       :project-id "pid"}}
                                                  :api-key "TOKEN_SENTINEL"
                                                  :item-id ${q(REMOTE_ID)}
                                                  :timeout-ms 10}))))
`;
  const out = bbJson(script);
  assert.equal(out.status, 'error');
  assert.equal(out.category, 'timeout');
  assert.doesNotMatch(JSON.stringify(out), /TOKEN_SENTINEL/);
});

test('WT5 injected transport exceptions become stable redacted durable failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt5-transport-'));
  writeProject(root, 'alpha');
  const script = `
(require '[cheshire.core :as json])
(require '[tesseraft.adapters.builtin :as builtin])
(require '[tesseraft.control-plane.core :as cp])
(require '[tesseraft.runtime.store :as store])
(require '[tesseraft.work-tracker.plane :as plane])
(def root ${q(root)})
(def run-dir (str root "/runs/work-tracker-read"))
(def options {:workspace-root root :tesseraft-home (str root "/home")})
(def project (cp/resolve-project options "alpha"))
(def ctx {:run {:dir run-dir :project-id "alpha" :workspace-root root
                :tesseraft-home (str root "/home") :project-context project}
          :credential-resolver (fn [_ ref] {:present true :state "present" :credential-ref ref :value "TOKEN_SENTINEL"})})
(def node {:handler :work-tracker/fetch-item :inputs {:item-id ${q(REMOTE_ID)}} :outputs {:work-item {:path "work-tracker/item.json"}}})
(binding [plane/*http-request* (fn [_] (throw (ex-info "TOKEN_SENTINEL socket exploded" {:raw "RAW_RESPONSE_SENTINEL"})))]
  (def result (builtin/run-handler! nil ctx :fetch node {:mock? false})))
(def artifact (store/read-json (str run-dir "/work-tracker/item.json")))
(println (json/generate-string {:result result :artifact artifact :run-dir run-dir}))
`;
  const out = bbJson(script);
  assert.equal(out.artifact.status, 'error');
  assert.equal(out.artifact.category, 'transport');
  const durable = fs.readFileSync(path.join(out['run-dir'], 'work-tracker', 'item.json'), 'utf8');
  assert.doesNotMatch(durable, /TOKEN_SENTINEL|RAW_RESPONSE_SENTINEL|socket exploded/);
});

test('WT5 exposes only provider-neutral work-tracker dispatch', () => {
  const script = `
(require '[cheshire.core :as json])
(require '[tesseraft.adapters.builtin :as builtin])
(println (json/generate-string {:has-work-tracker (contains? builtin/handlers :work-tracker/fetch-item)
                                :has-jira (contains? builtin/handlers :jira/fetch-ticket)
                                :handler-ids (mapv (comp name key) builtin/handlers)}))
`;
  const out = bbJson(script);
  assert.equal(out['has-work-tracker'], true);
  assert.equal(out['has-jira'], false);
  assert.ok(out['handler-ids'].includes('fetch-item'));
});
