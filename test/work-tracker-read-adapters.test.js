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

function prStr(value) {
  if (Array.isArray(value)) return `[${value.map(prStr).join(' ')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([k, v]) => `${q(k)} ${prStr(v)}`).join(' ')}}`;
  return q(value);
}

const writeProject = (root, id, tracker, extraConnections = {}) => {
  const projectDir = path.join(root, '.tesseraft', 'projects');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${id}.json`), JSON.stringify({
    project_id: id,
    name: id,
    workspace_root: '.',
    runs_root: 'runs',
    connections: { ...extraConnections, 'work-tracker': tracker }
  }, null, 2));
};

const runtimeScript = ({ root, projectId = 'alpha', itemId, provider, status = 200, body = '{}', headers = {}, token = 'TRACKER_TOKEN_SENTINEL', mock = false }) => `
(require '[cheshire.core :as json])
(require '[tesseraft.adapters.builtin :as builtin])
(require '[tesseraft.runtime.store :as store])
(require '[tesseraft.work-tracker.jira :as jira])
(require '[tesseraft.work-tracker.github-issues :as gh-issues])
(def root ${q(root)})
(def run-dir (str root "/runs/work-tracker-read-adapters"))
(def calls (atom []))
(def resolver (fn [options ref]
                (swap! calls conj {:workspace-root (:workspace-root options) :ref ref})
                {:present true :state "present" :credential-ref ref :value ${q(token)}}))
(def ctx {:run {:dir run-dir :project-id ${q(projectId)} :workspace-root root}
          :inputs {}
          :credential-resolver resolver})
(def node {:handler :work-tracker/fetch-item
           :inputs {:item-id ${q(itemId)}}
           :outputs {:work-item {:path "work-tracker/item.json"}}})
(def transport (fn [request]
                 (swap! calls conj {:request request})
                 {:status ${status} :headers ${prStr(headers)} :body ${q(body)}}))
(binding [jira/*http-request* transport gh-issues/*http-request* transport]
  (def result (builtin/run-handler! nil ctx :fetch node {:mock? ${mock ? 'true' : 'false'}})))
(def artifact (store/read-json (str run-dir "/work-tracker/item.json")))
(println (json/generate-string {:result result :artifact artifact :calls @calls :run-dir run-dir}))
`;

const jiraTracker = (ref = 'env:JIRA_TRACKER') => ({ provider: 'jira', 'credential-ref': ref, config: { 'base-url': 'https://jira.example', 'project-key': 'TES' } });
const ghTracker = (ref = 'env:GH_ISSUES') => ({ provider: 'github-issues', 'credential-ref': ref, config: { repository: 'owner/repo' } });

test('WT6 normalizes Jira and GitHub Issues into equivalent allowlisted artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt6-normalize-'));
  writeProject(root, 'jira-proj', jiraTracker());
  writeProject(root, 'gh-proj', ghTracker());

  const jira = bbJson(runtimeScript({
    root, projectId: 'jira-proj', provider: 'jira', itemId: 'TES-42', token: 'JIRA_SECRET',
    body: JSON.stringify({
      id: '10042', key: 'TES-42', fields: {
        summary: 'Fix Jira adapter', description: 'Safe Jira description', status: { name: 'In Progress' }, priority: { name: 'High' },
        assignee: { accountId: 'acct-1', displayName: 'Ada', emailAddress: 'RAW_RESPONSE_SENTINEL' }, labels: ['bug']
      }, raw_secret: 'RAW_RESPONSE_SENTINEL'
    })
  }));
  assert.equal(jira.result.provider, 'jira');
  assert.deepEqual(jira.artifact.remote, { id: '10042', identifier: 'TES-42', project_key: 'TES' });
  assert.equal(jira.artifact.title, 'Fix Jira adapter');
  assert.deepEqual(jira.artifact.assignees, [{ id: 'acct-1', display_name: 'Ada' }]);
  assert.deepEqual(jira.artifact.labels, [{ name: 'bug' }]);

  const gh = bbJson(runtimeScript({
    root, projectId: 'gh-proj', provider: 'github-issues', itemId: '7', token: 'GH_ISSUES_SECRET',
    body: JSON.stringify({
      id: 7007, number: 7, title: 'Fix GitHub adapter', body: 'Safe GitHub body', state: 'open',
      assignees: [{ id: 1, login: 'octo', email: 'RAW_RESPONSE_SENTINEL' }], labels: [{ id: 9, name: 'medium', color: '0f0' }],
      html_url: 'https://github.com/owner/repo/issues/7', token: 'RAW_RESPONSE_SENTINEL'
    })
  }));
  assert.equal(gh.result.provider, 'github-issues');
  assert.deepEqual(gh.artifact.remote, { id: '7007', identifier: '#7', repository: 'owner/repo' });
  assert.equal(gh.artifact.title, 'Fix GitHub adapter');
  assert.equal(gh.artifact.priority, 'medium');
  assert.deepEqual(gh.artifact.assignees, [{ id: '1', display_name: 'octo' }]);

  for (const out of [jira, gh]) {
    const durable = fs.readFileSync(path.join(out['run-dir'], 'work-tracker', 'item.json'), 'utf8');
    assert.doesNotMatch(durable, /JIRA_SECRET|GH_ISSUES_SECRET|RAW_RESPONSE_SENTINEL|emailAddress|raw_secret/);
  }
});

test('WT6 runtime dispatch uses only the selected project tracker credential and transport', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt6-dispatch-'));
  writeProject(root, 'alpha', ghTracker('env:ALPHA_TRACKER'), { github: { 'credential-ref': 'env:LEGACY_GITHUB' } });
  writeProject(root, 'beta', jiraTracker('env:BETA_TRACKER'));
  const out = bbJson(runtimeScript({ root, projectId: 'alpha', itemId: '3', token: 'ALPHA_TRACKER_SECRET', body: JSON.stringify({ id: 3, number: 3, title: 'T' }) }));
  const resolverCall = out.calls.find((call) => call.ref);
  const request = out.calls.find((call) => call.request).request;
  assert.equal(resolverCall.ref, 'env:ALPHA_TRACKER');
  assert.equal(request.headers.Authorization, 'Bearer ALPHA_TRACKER_SECRET');
  assert.match(request.url, /^https:\/\/api\.github\.com\/repos\/owner\/repo\/issues\/3$/);
  const durable = fs.readFileSync(path.join(out['run-dir'], 'work-tracker', 'item.json'), 'utf8');
  assert.doesNotMatch(durable, /LEGACY_GITHUB|BETA_TRACKER|ALPHA_TRACKER_SECRET/);
});

test('WT6 rejects malformed item refs/config before fake transport is called', () => {
  const jiraOut = bbJson(`
(require '[cheshire.core :as json])
(require '[tesseraft.work-tracker.jira :as jira])
(def calls (atom 0))
(binding [jira/*http-request* (fn [_] (swap! calls inc) {:status 200 :body "{}"})]
  (println (json/generate-string {:result (jira/fetch-item {:tracker {:provider "jira" :config {:base-url "https://jira.example" :project-key "TES"}}
                                                           :token "TOKEN_SENTINEL" :item-id "OTHER-1" :timeout-ms 10})
                                 :calls @calls})))`);
  assert.equal(jiraOut.result.category, 'invalid_item_id');
  assert.equal(jiraOut.calls, 0);

  const ghOut = bbJson(`
(require '[cheshire.core :as json])
(require '[tesseraft.work-tracker.github-issues :as gh])
(def calls (atom 0))
(binding [gh/*http-request* (fn [_] (swap! calls inc) {:status 200 :body "{}"})]
  (println (json/generate-string {:result (gh/fetch-item {:tracker {:provider "github-issues" :config {:repository "not owner repo"}}
                                                         :token "TOKEN_SENTINEL" :item-id "abc" :timeout-ms 10})
                                 :calls @calls})))`);
  assert.equal(ghOut.result.category, 'invalid_config');
  assert.equal(ghOut.calls, 0);
  assert.doesNotMatch(JSON.stringify({ jiraOut, ghOut }), /TOKEN_SENTINEL/);
});

test('WT6 GitHub Issues rejects pull request payloads instead of normalizing them as issues', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt6-pr-reject-'));
  writeProject(root, 'alpha', ghTracker());
  const out = bbJson(runtimeScript({ root, itemId: '9', body: JSON.stringify({ id: 9, number: 9, title: 'PR', pull_request: { url: 'RAW_RESPONSE_SENTINEL' } }) }));
  assert.equal(out.artifact.status, 'error');
  assert.equal(out.artifact.category, 'not_issue');
  assert.doesNotMatch(JSON.stringify(out.artifact), /RAW_RESPONSE_SENTINEL/);
});

test('WT6 adapter failures are stable, bounded, and redacted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt6-failures-'));
  writeProject(root, 'alpha', ghTracker());
  for (const [name, status, body, expected, headers] of [
    ['malformed JSON', 200, '{bad json RAW_RESPONSE_SENTINEL}', 'malformed_json', {}],
    ['malformed output', 200, '{"message":"RAW_RESPONSE_SENTINEL"}', 'malformed_output', {}],
    ['401', 401, 'SECRET BODY', 'unauthorized', {}],
    ['403', 403, 'SECRET BODY', 'forbidden', {}],
    ['404', 404, 'SECRET BODY', 'not_found', {}],
    ['403 rate limit', 403, 'SECRET BODY', 'rate_limited', { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1710000000', Authorization: 'SECRET' }],
    ['429', 429, 'SECRET BODY', 'rate_limited', { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1710000000', Authorization: 'SECRET' }],
    ['5xx', 503, 'SERVER SECRET BODY', 'server_error', {}]
  ]) {
    const out = bbJson(runtimeScript({ root, itemId: '4', status, body, headers, token: `${name}-TOKEN` }));
    assert.equal(out.artifact.category, expected, name);
    if (status === 429) assert.deepEqual(out.artifact.rate_limit, { remaining: '0', reset: '1710000000' });
    const durable = fs.readFileSync(path.join(out['run-dir'], 'work-tracker', 'item.json'), 'utf8');
    assert.doesNotMatch(durable, /SECRET BODY|SERVER SECRET BODY|RAW_RESPONSE_SENTINEL|TOKEN_SENTINEL|Authorization/);
  }
});

test('WT6 timeout and transport failures do not retain exception or token text', () => {
  const out = bbJson(`
(require '[cheshire.core :as json])
(require '[tesseraft.work-tracker.github-issues :as gh])
(binding [gh/*http-request* (fn [_] (throw (ex-info "TOKEN_SENTINEL socket exploded" {:raw "RAW_RESPONSE_SENTINEL"})))]
  (println (json/generate-string (gh/fetch-item {:tracker {:provider "github-issues" :config {:repository "owner/repo"}}
                                                :token "TOKEN_SENTINEL" :item-id "1" :timeout-ms 10}))))`);
  assert.equal(out.category, 'transport');
  assert.doesNotMatch(JSON.stringify(out), /TOKEN_SENTINEL|RAW_RESPONSE_SENTINEL|socket exploded/);
});

test('WT6 mock mode remains offline and derives safe provider scope from persisted context only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt6-mock-'));
  const script = `
(require '[cheshire.core :as json])
(require '[tesseraft.adapters.builtin :as builtin])
(require '[tesseraft.runtime.store :as store])
(require '[tesseraft.work-tracker.jira :as jira])
(def run-dir (str ${q(root)} "/run"))
(def ctx {:run {:dir run-dir :project-id "alpha"
                :project-context {:project_id "alpha" :connections {:work-tracker {:provider "jira" :config {:project-key "TES"}}}}}
          :credential-resolver (fn [& _] (throw (ex-info "resolver must not be called" {})))})
(def node {:handler :work-tracker/fetch-item :inputs {:item-id "TES-1"} :outputs {:work-item {:path "item.json"}}})
(binding [jira/*http-request* (fn [_] (throw (ex-info "http must not be called" {})))]
  (def result (builtin/run-handler! nil ctx :fetch node {:mock? true})))
(println (json/generate-string {:result result :artifact (store/read-json (str run-dir "/item.json"))}))`;
  const out = bbJson(script);
  assert.equal(out.result.mock, true);
  assert.equal(out.artifact.provider, 'jira');
  assert.deepEqual(out.artifact.remote, { id: 'TES-1', identifier: 'TES-1', project_key: 'TES' });
});
