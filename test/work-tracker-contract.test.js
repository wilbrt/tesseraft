import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const bbJson = (script) => JSON.parse(execFileSync('bb', ['-e', script], { cwd: repoRoot, encoding: 'utf8' }));
const q = (value) => JSON.stringify(value);

const inlineRefs = (value) => {
  if (Array.isArray(value)) return value.map(inlineRefs);
  if (!value || typeof value !== 'object') return value;
  if (typeof value.$ref === 'string' && !value.$ref.includes('#')) {
    return inlineRefs(JSON.parse(fs.readFileSync(path.join(repoRoot, 'schemas', value.$ref), 'utf8')));
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, inlineRefs(v)]));
};

const validateWithDraft202012 = (schema, instance) => {
  const payload = JSON.stringify({ schema: inlineRefs(schema), instance });
  const script = `
import json, sys
from jsonschema import Draft202012Validator
payload = json.load(sys.stdin)
errors = sorted(Draft202012Validator(payload['schema']).iter_errors(payload['instance']), key=lambda e: list(e.path))
if errors:
    for error in errors:
        print('/'.join(str(part) for part in error.path), error.message)
    sys.exit(1)
`;
  try {
    execFileSync('python3', ['-c', script], { input: payload, encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
};

test('WT3 publishes no-tracker and built-in work-tracker schemas', () => {
  const projectSchema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'schemas', 'project.schema.json'), 'utf8'));
  const trackerSchema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'schemas', 'work-tracker.schema.json'), 'utf8'));
  assert.ok(projectSchema.properties.connections.properties['work-tracker'], 'project schema exposes optional connections.work-tracker');
  assert.equal(validateWithDraft202012(projectSchema, {
    project_id: 'wt3-none', name: 'WT3 None', workspace_root: '.', runs_root: 'runs', connections: {}
  }), true, 'omitting work-tracker means no tracker');
  for (const tracker of [
    { provider: 'plane', 'credential-ref': 'env:PLANE_TOKEN', config: { 'api-base-url': 'https://plane.example', 'workspace-slug': 'workspace', 'project-id': 'project' } },
    { provider: 'jira', 'credential-ref': 'tesseraft:jira/tracker', config: { 'base-url': 'https://jira.example', 'project-key': 'TES' } },
    { provider: 'github-issues', 'credential-ref': 'github-actions:secrets.GITHUB_TOKEN', config: { repository: 'owner/repo' } }
  ]) {
    assert.equal(validateWithDraft202012(trackerSchema, tracker), true, `valid ${tracker.provider} tracker schema`);
  }
  assert.equal(validateWithDraft202012(trackerSchema, {
    provider: 'plane', 'credential-ref': 'env:PLANE_TOKEN', config: { 'base-url': 'https://jira.example', 'project-key': 'TES' }
  }), false, 'built-in provider/config pairs are discriminated');
  assert.equal(validateWithDraft202012(trackerSchema, {
    provider: 'acme-tracker', 'credential-ref': 'env:ACME_TOKEN', config: { project: 'DEMO' }
  }), true, 'custom providers are schema-admissible but runtime-registered');
  assert.equal(validateWithDraft202012(trackerSchema, {
    provider: 'plane', 'schema-version': 99, 'credential-ref': 'env:PLANE_TOKEN', config: { 'api-base-url': 'https://plane.example', 'workspace-slug': 'workspace', 'project-id': 'project' }
  }), false, 'unsupported schema versions are rejected by schema');
});

test('WT3 core create inspect update clear normalizes tracker and preserves legacy connections', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt3-core-'));
  try {
    const create = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/create-project {:workspace-root ${q(root)}} "wt3-alpha" {:connections {:github {:credential-ref "env:GITHUB_TOKEN"} :jira {:base-url "https://legacy-jira.example" :credential-ref "env:JIRA_TOKEN"} :work_tracker {:provider "plane" :credential_ref "env:PLANE_TOKEN" :config {:api_base_url "https://plane.example" :workspace_slug "ws" :project_id "pid"}}}})))
`);
    assert.equal(create.project_id, 'wt3-alpha');
    assert.equal(create.connections['work-tracker'].provider, 'plane');
    assert.deepEqual(create.connections['work-tracker'].config, { 'api-base-url': 'https://plane.example', 'workspace-slug': 'ws', 'project-id': 'pid' });
    assert.equal(create.connections.github['credential-ref'], 'env:GITHUB_TOKEN');
    assert.equal(create.connections.jira['base-url'], 'https://legacy-jira.example');

    const inspect = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/get-project-connections {:workspace-root ${q(root)} :credential-resolver (fn [_ ref] {:present true :state "present" :value "secret"})} "wt3-alpha")))
`);
    assert.equal(inspect.connections['work-tracker']['credential-state'].present, true);
    assert.equal(inspect.connections['work-tracker']['credential-state'].value, undefined, 'credential values are never returned');

    const update = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/update-project-connections {:workspace-root ${q(root)}} "wt3-alpha" {:work-tracker {:provider "github-issues" :credential-ref "env:GH_ISSUES" :config {:repository "owner/repo"}}})))
`);
    assert.equal(update.connections['work-tracker'].provider, 'github-issues');
    assert.equal(update.connections.github['credential-ref'], 'env:GITHUB_TOKEN', 'GitHub code-host connection is independent');
    assert.equal(update.connections.jira['base-url'], 'https://legacy-jira.example', 'legacy Jira connection is preserved');

    const aggregateUpdate = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/update-project {:workspace-root ${q(root)}} "wt3-alpha" {:connections {:work-tracker {:provider "jira" :credential-ref "env:JIRA_TRACKER" :config {:base-url "https://jira-tracker.example" :project-key "WT3"}}}})))
`);
    assert.equal(aggregateUpdate.connections['work-tracker'].provider, 'jira');
    assert.equal(aggregateUpdate.connections.github['credential-ref'], 'env:GITHUB_TOKEN', 'aggregate project update preserves GitHub');
    assert.equal(aggregateUpdate.connections.jira['base-url'], 'https://legacy-jira.example', 'aggregate project update preserves legacy Jira');

    const cleared = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/update-project-connections {:workspace-root ${q(root)}} "wt3-alpha" {:clear-work-tracker true})))
`);
    assert.equal(cleared.connections['work-tracker'], undefined);
    assert.ok(cleared.connections.github);
    assert.ok(cleared.connections.jira);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WT3 rejects malformed trackers atomically and isolates projects', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt3-invalid-'));
  try {
    bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(cp/create-project {:workspace-root ${q(root)}} "wt3-a" {:connections {:work-tracker {:provider "jira" :credential-ref "env:JIRA_A" :config {:base-url "https://jira-a.example" :project-key "A"}}}})
(cp/create-project {:workspace-root ${q(root)}} "wt3-b" {:connections {}})
(println (json/generate-string {:ok true}))
`);
    const manifestA = path.join(root, '.tesseraft', 'projects', 'wt3-a.json');
    const before = fs.readFileSync(manifestA, 'utf8');
    const bad = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/update-project-connections {:workspace-root ${q(root)}} "wt3-a" {:work-tracker {:provider "plane" :credential-ref "env:PLANE" :config {:workspace-slug "ws" :project-id "pid"}}})))
`);
    assert.equal(bad.status, 400);
    assert.equal(fs.readFileSync(manifestA, 'utf8'), before, 'failed update leaves project bytes unchanged');

    const numericProvider = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/update-project-connections {:workspace-root ${q(root)}} "wt3-a" {:work-tracker {:provider 123 :credential-ref "env:BAD" :config {:base-url "https://jira.example" :project-key "A"}}})))
`);
    assert.equal(numericProvider.status, 400);
    assert.match(numericProvider.error.message, /provider/);

    const numericProjectKey = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/update-project-connections {:workspace-root ${q(root)}} "wt3-a" {:work-tracker {:provider "jira" :credential-ref "env:JIRA" :config {:base-url "https://jira.example" :project-key 123}}})))
`);
    assert.equal(numericProjectKey.status, 400);
    assert.equal(fs.readFileSync(manifestA, 'utf8'), before, 'type validation failures leave bytes unchanged');

    const secret = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/update-project-connections {:workspace-root ${q(root)}} "wt3-a" {:work-tracker {:provider "jira" :credential-ref "env:JIRA" :config {:base-url "https://jira.example" :project-key "A" :nested [{:access_token "WT3_SECRET_SENTINEL"}]}}})))
`);
    assert.equal(secret.status, 400);
    assert.doesNotMatch(JSON.stringify(secret), /WT3_SECRET_SENTINEL/);

    const customSecret = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(cp/register-work-tracker-provider! "acme-tracker" {:required #{:project} :optional #{:metadata}})
(println (json/generate-string (cp/update-project-connections {:workspace-root ${q(root)}} "wt3-a" {:work-tracker {:provider "acme-tracker" :credential-ref "env:ACME" :config {:project "A" :metadata [{:refresh_token "WT3_CUSTOM_SECRET_SENTINEL"}]}}})))
`);
    assert.equal(customSecret.status, 400);
    assert.doesNotMatch(JSON.stringify(customSecret), /WT3_CUSTOM_SECRET_SENTINEL/);
    assert.equal(fs.readFileSync(manifestA, 'utf8'), before, 'custom-provider secret failures leave bytes unchanged');

    const projectB = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/get-project-connections {:workspace-root ${q(root)}} "wt3-b")))
`);
    assert.deepEqual(projectB.connections, {}, 'project B is unchanged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('WT3 registered portable project connection mutations update descriptor without shadow manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt3-registered-'));
  const home = path.join(root, 'home');
  const projectRoot = path.join(root, 'project-a');
  const otherRoot = path.join(root, 'project-b');
  const descriptorPath = path.join(projectRoot, '.tesseraft', 'project.json');
  const otherDescriptorPath = path.join(otherRoot, '.tesseraft', 'project.json');
  try {
    fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
    fs.mkdirSync(path.dirname(otherDescriptorPath), { recursive: true });
    fs.writeFileSync(descriptorPath, JSON.stringify({
      version: 1,
      project_id: 'wt3-registered',
      name: 'WT3 Registered',
      runs_root: 'runs',
      discovery: { 'workflow-roots': ['examples'] },
      connections: {
        github: { 'credential-ref': 'env:WT3_REG_GITHUB' },
        'work-tracker': { provider: 'jira', 'credential-ref': 'env:WT3_REG_JIRA', config: { 'base-url': 'https://jira.example', 'project-key': 'OLD' } }
      }
    }, null, 2));
    fs.writeFileSync(otherDescriptorPath, JSON.stringify({ version: 1, project_id: 'wt3-other', connections: {} }, null, 2));

    const result = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(cp/create-project {:workspace-root ${q(root)} :tesseraft-home ${q(home)}} "wt3-registered" {:workspace_root ${q(projectRoot)} :source "registration"})
(cp/create-project {:workspace-root ${q(root)} :tesseraft-home ${q(home)}} "wt3-other" {:workspace_root ${q(otherRoot)} :source "registration"})
(def updated (cp/update-project-connections {:workspace-root ${q(root)} :tesseraft-home ${q(home)}} "wt3-registered" {:work-tracker {:provider "github-issues" :credential-ref "env:WT3_REG_GH_ISSUES" :config {:repository "owner/repo"}}}))
(def inspected (cp/get-project-connections {:workspace-root ${q(root)} :tesseraft-home ${q(home)}} "wt3-registered"))
(def cleared (cp/update-project-connections {:workspace-root ${q(root)} :tesseraft-home ${q(home)}} "wt3-registered" {:clear-work-tracker true}))
(println (json/generate-string {:updated updated :inspected inspected :cleared cleared}))
`);
    assert.equal(result.updated.connections['work-tracker'].provider, 'github-issues');
    assert.equal(result.inspected.connections['work-tracker'].provider, 'github-issues');
    assert.equal(result.cleared.connections['work-tracker'], undefined);
    assert.equal(fs.existsSync(path.join(root, '.tesseraft', 'projects', 'wt3-registered.json')), false, 'registered mutation must not create a legacy shadow manifest');
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    assert.equal(descriptor.connections.github['credential-ref'], 'env:WT3_REG_GITHUB');
    assert.equal(descriptor.connections['work-tracker'], undefined, 'clear removes only descriptor-owned work-tracker');
    assert.deepEqual(JSON.parse(fs.readFileSync(otherDescriptorPath, 'utf8')).connections, {}, 'other registered project descriptor is unchanged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WT3 portable migration preserves valid connections and rejects secret-bearing trackers atomically', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt3-migrate-'));
  const home = path.join(root, 'home');
  const projectRoot = path.join(root, 'portable');
  const legacyPath = path.join(root, 'legacy.json');
  const descriptorPath = path.join(projectRoot, '.tesseraft', 'project.json');
  try {
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify({
      project_id: 'wt3-migrate',
      name: 'WT3 Migrate',
      workspace_root: projectRoot,
      runs_root: 'runs',
      discovery: { 'workflow-roots': ['examples'] },
      connections: {
        github: { 'credential-ref': 'env:WT3_MIG_GITHUB' },
        jira: { 'base-url': 'https://legacy-jira.example', 'credential-ref': 'env:WT3_MIG_JIRA' },
        'work-tracker': { provider: 'plane', 'credential-ref': 'env:WT3_MIG_PLANE', config: { 'api-base-url': 'https://plane.example', 'workspace-slug': 'ws', 'project-id': 'pid' } }
      }
    }, null, 2));
    const migrated = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/migrate-project-portable {:workspace-root ${q(root)} :tesseraft-home ${q(home)}} "wt3-migrate" ${q(legacyPath)} ${q(projectRoot)})))
`);
    assert.equal(migrated.connections.github['credential-ref'], 'env:WT3_MIG_GITHUB');
    assert.equal(migrated.connections.jira['base-url'], 'https://legacy-jira.example');
    assert.equal(migrated.connections['work-tracker'].provider, 'plane');
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    assert.equal(descriptor.connections['work-tracker'].provider, 'plane');

    const badRoot = path.join(root, 'bad-portable');
    const badLegacyPath = path.join(root, 'bad-legacy.json');
    fs.mkdirSync(badRoot, { recursive: true });
    fs.writeFileSync(badLegacyPath, JSON.stringify({
      project_id: 'wt3-bad-migrate',
      workspace_root: badRoot,
      runs_root: 'runs',
      connections: { 'work-tracker': { provider: 'jira', 'credential-ref': 'env:WT3_BAD', config: { 'base-url': 'https://jira.example', 'project-key': 'BAD', nested: [{ refresh_token: 'WT3_MIGRATE_SECRET_SENTINEL' }] } } }
    }, null, 2));
    const badBytes = fs.readFileSync(badLegacyPath, 'utf8');
    const rejected = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/migrate-project-portable {:workspace-root ${q(root)} :tesseraft-home ${q(home)}} "wt3-bad-migrate" ${q(badLegacyPath)} ${q(badRoot)})))
`);
    assert.equal(rejected.status, 400);
    assert.doesNotMatch(JSON.stringify(rejected), /WT3_MIGRATE_SECRET_SENTINEL/);
    assert.equal(fs.readFileSync(badLegacyPath, 'utf8'), badBytes, 'failed migration preserves legacy bytes');
    assert.equal(fs.existsSync(path.join(badRoot, '.tesseraft', 'project.json')), false, 'failed migration leaves no descriptor');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
