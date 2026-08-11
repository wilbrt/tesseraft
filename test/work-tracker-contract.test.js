import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const q = JSON.stringify;
const bbJson = (script) => JSON.parse(execFileSync('bb', ['-e', script], { cwd: repoRoot, encoding: 'utf8' }));

const inlineRefs = (value) => {
  if (Array.isArray(value)) return value.map(inlineRefs);
  if (!value || typeof value !== 'object') return value;
  if (typeof value.$ref === 'string' && !value.$ref.includes('#')) {
    return inlineRefs(JSON.parse(fs.readFileSync(path.join(repoRoot, 'schemas', value.$ref), 'utf8')));
  }
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, inlineRefs(nested)]));
};

const validateWithDraft202012 = (schema, instance) => {
  const script = `
import json, sys
from jsonschema import Draft202012Validator
payload = json.load(sys.stdin)
errors = list(Draft202012Validator(payload['schema']).iter_errors(payload['instance']))
sys.exit(1 if errors else 0)
`;
  try {
    execFileSync('python3', ['-c', script], { input: JSON.stringify({ schema: inlineRefs(schema), instance }) });
    return true;
  } catch { return false; }
};

test('work-tracker schema is optional on the v2 descriptor and discriminates built-ins', () => {
  const descriptorSchema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'schemas', 'portable-project-descriptor.schema.json'), 'utf8'));
  const trackerSchema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'schemas', 'work-tracker.schema.json'), 'utf8'));
  assert.ok(descriptorSchema.properties.connections.properties['work-tracker']);
  assert.equal(validateWithDraft202012(descriptorSchema, { version: 2, project_id: 'without-tracker' }), true);
  for (const tracker of [
    { provider: 'plane', 'credential-ref': 'env:PLANE_TOKEN', config: { 'api-base-url': 'https://plane.example', 'workspace-slug': 'workspace', 'project-id': 'project' } },
    { provider: 'jira', 'credential-ref': 'tesseraft:jira/tracker', config: { 'base-url': 'https://jira.example', 'project-key': 'TES' } },
    { provider: 'github-issues', 'credential-ref': 'github-actions:secrets.GITHUB_TOKEN', config: { repository: 'owner/repo' } }
  ]) assert.equal(validateWithDraft202012(trackerSchema, tracker), true, tracker.provider);
  assert.equal(validateWithDraft202012(trackerSchema, {
    provider: 'plane', 'credential-ref': 'env:PLANE_TOKEN', config: { 'base-url': 'https://jira.example', 'project-key': 'TES' }
  }), false);
  assert.equal(validateWithDraft202012(trackerSchema, {
    provider: 'custom', 'credential-ref': 'env:CUSTOM', config: {}
  }), false);
});

test('normalized work-item schema discriminates provider remote scope', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'schemas', 'normalized-work-item.schema.json'), 'utf8'));
  const base = { schema_version: 1, project: { id: 'alpha' }, identifier: 'ID-1', title: 'Title', description: '', state: { name: 'open' }, priority: 'none', assignees: [], labels: [], fetched_at: '2026-08-10T00:00:00Z' };
  const remotes = {
    plane: { id: 'p1', identifier: 'PL-1', workspace_slug: 'ws', project_id: 'pid' },
    jira: { id: '100', identifier: 'TES-1', project_key: 'TES' },
    'github-issues': { id: '7', identifier: '#7', repository: 'owner/repo' }
  };
  for (const [provider, remote] of Object.entries(remotes)) {
    assert.equal(validateWithDraft202012(schema, { ...base, provider, remote }), true, provider);
    for (const [other, otherRemote] of Object.entries(remotes)) {
      if (other !== provider) assert.equal(validateWithDraft202012(schema, { ...base, provider, remote: otherRemote }), false);
    }
  }
});

test('descriptor-only create, inspect, update, and clear preserve code-host ownership', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt-v2-crud-'));
  const home = path.join(root, 'home');
  const projectRoot = path.join(root, 'alpha');
  const result = bbJson(`
(require '[cheshire.core :as json])
(require '[tesseraft.control-plane.core :as cp])
(def o {:workspace-root ${q(root)} :tesseraft-home ${q(home)}})
(def created (cp/create-project o "alpha" {:workspace_root ${q(projectRoot)}
  :connections {:code-host {:provider "github" :auth-mode "credential-ref" :credential-ref "env:GITHUB_TOKEN"}
                :work-tracker {:provider "plane" :credential-ref "env:PLANE_TOKEN"
                  :config {:api-base-url "https://plane.example" :workspace-slug "ws" :project-id "pid"}}}}))
(def updated (cp/update-project-connections o "alpha" {:work-tracker {:provider "github-issues"
  :credential-ref "env:GH_ISSUES" :config {:repository "owner/repo"}}}))
(def inspected (cp/get-project-connections o "alpha"))
(def cleared (cp/update-project-connections o "alpha" {:clear-work-tracker true}))
(println (json/generate-string {:created created :updated updated :inspected inspected :cleared cleared}))`);
  assert.equal(result.created.connections['work-tracker'].provider, 'plane');
  assert.equal(result.updated.connections['work-tracker'].provider, 'github-issues');
  assert.equal(result.inspected.connections['work-tracker'].provider, 'github-issues');
  assert.equal(result.cleared.connections['work-tracker'], undefined);
  assert.equal(result.cleared.connections['code-host']['credential-ref'], 'env:GITHUB_TOKEN');
  const descriptor = JSON.parse(fs.readFileSync(path.join(projectRoot, '.tesseraft', 'project.json'), 'utf8'));
  assert.equal(descriptor.version, 2);
  assert.equal(descriptor.connections['work-tracker'], undefined);
  assert.equal(fs.existsSync(path.join(root, '.tesseraft', 'projects', 'alpha.json')), false);
});

test('malformed and secret-bearing tracker updates are atomic and redacted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt-v2-atomic-'));
  const home = path.join(root, 'home');
  const projectRoot = path.join(root, 'alpha');
  bbJson(`
(require '[cheshire.core :as json]) (require '[tesseraft.control-plane.core :as cp])
(println (json/generate-string (cp/create-project {:workspace-root ${q(root)} :tesseraft-home ${q(home)}} "alpha"
  {:workspace_root ${q(projectRoot)} :connections {:work-tracker {:provider "jira" :credential-ref "env:JIRA"
   :config {:base-url "https://jira.example" :project-key "TES"}}}})))`);
  const descriptorPath = path.join(projectRoot, '.tesseraft', 'project.json');
  const before = fs.readFileSync(descriptorPath, 'utf8');
  const bad = bbJson(`
(require '[cheshire.core :as json]) (require '[tesseraft.control-plane.core :as cp])
(println (json/generate-string (cp/update-project-connections {:workspace-root ${q(root)} :tesseraft-home ${q(home)}} "alpha"
  {:work-tracker {:provider "plane" :credential-ref "env:PLANE" :config {:workspace-slug "ws" :project-id "p"}}})))`);
  assert.equal(bad.status, 400);
  const secret = bbJson(`
(require '[cheshire.core :as json]) (require '[tesseraft.control-plane.core :as cp])
(println (json/generate-string (cp/update-project-connections {:workspace-root ${q(root)} :tesseraft-home ${q(home)}} "alpha"
  {:work-tracker {:provider "jira" :credential-ref "env:JIRA" :config {:base-url "https://jira.example"
    :project-key "TES" :metadata [{:access_token "TRACKER_SECRET_SENTINEL"}]}}})))`);
  assert.equal(secret.status, 400);
  assert.doesNotMatch(JSON.stringify(secret), /TRACKER_SECRET_SENTINEL/);
  assert.equal(fs.readFileSync(descriptorPath, 'utf8'), before);
});

test('normal resolution rejects v1 descriptors while the migration command owns them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt-migration-boundary-'));
  fs.mkdirSync(path.join(root, '.tesseraft'), { recursive: true });
  fs.writeFileSync(path.join(root, '.tesseraft', 'project.json'), JSON.stringify({
    version: 1, project_id: 'legacy', runs_root: 'runs', discovery: { workflow_roots: [] }
  }));
  const result = bbJson(`
(require '[cheshire.core :as json])
(require '[tesseraft.control-plane.core :as cp])
(require '[tesseraft.migration.project :as migration])
(println (json/generate-string {:resolved (cp/resolve-project {:workspace-root ${q(root)}} nil)
                                :migration (migration/inspect {:workspace-root ${q(root)} :tesseraft-home ${q(path.join(root, 'home'))}} ${q(root)})}))`);
  assert.equal(result.resolved.status, 400);
  assert.equal(result.resolved.error.code, 'invalid_project_descriptor');
  assert.equal(result.migration.state, 'pending');
  assert.equal(result.migration.applicable, 1);
});
