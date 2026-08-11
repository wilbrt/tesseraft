import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const q = JSON.stringify;
const bbJson = (script, env = {}) => JSON.parse(execFileSync('bb', ['-e', script], {
  cwd: repoRoot,
  env: { ...process.env, ...env },
  encoding: 'utf8'
}));

const writeProject = (controlRoot, projectId, connections, projectRoot = path.join(controlRoot, 'projects', projectId)) => {
  const descriptorDir = path.join(projectRoot, '.tesseraft');
  const registryPath = path.join(controlRoot, 'home', 'projects', 'registry.json');
  fs.mkdirSync(descriptorDir, { recursive: true });
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(path.join(descriptorDir, 'project.json'), JSON.stringify({
    version: 2,
    project_id: projectId,
    name: projectId,
    runs_root: 'runs',
    discovery: { workflow_roots: [] },
    connections
  }, null, 2));
  const registry = fs.existsSync(registryPath)
    ? JSON.parse(fs.readFileSync(registryPath, 'utf8'))
    : { version: 2, projects: {} };
  registry.projects[projectId] = { workspace_root: projectRoot };
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
  return { projectRoot, descriptorPath: path.join(descriptorDir, 'project.json') };
};

const diagnosis = (root, id, extraOptions = '') => bbJson(`
(require '[cheshire.core :as json])
(require '[tesseraft.control-plane.core :as cp])
(println (json/generate-string (cp/work-tracker-diagnosis {:workspace-root ${q(root)} :tesseraft-home ${q(path.join(root, 'home'))} ${extraOptions}} ${q(id)})))`);

test('raw descriptor diagnosis distinguishes absent, incomplete, invalid, unresolved, and ready', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt-doctor-states-'));
  writeProject(root, 'absent', {});
  assert.deepEqual({ state: diagnosis(root, 'absent').state, source: diagnosis(root, 'absent').source }, { state: 'absent', source: 'descriptor' });

  writeProject(root, 'incomplete', { 'work-tracker': {
    provider: 'plane', 'credential-ref': 'env:PLANE', config: { 'api-base-url': 'https://plane.example' }
  } });
  const incomplete = diagnosis(root, 'incomplete');
  assert.equal(incomplete.state, 'incomplete');
  assert.match(incomplete.message, /Missing work-tracker config fields/);

  writeProject(root, 'invalid', { 'work-tracker': {
    provider: 'jira', 'credential-ref': 'env:JIRA', config: { 'base-url': 'not-a-url', 'project-key': 'TES' }
  } });
  assert.equal(diagnosis(root, 'invalid').state, 'invalid');

  writeProject(root, 'unresolved', { 'work-tracker': {
    provider: 'github-issues', 'credential-ref': 'env:DEFINITELY_UNSET_TRACKER_TOKEN', config: { repository: 'owner/repo' }
  } });
  const unresolved = diagnosis(root, 'unresolved');
  assert.equal(unresolved.state, 'unresolved');
  assert.equal(unresolved['credential-state'], 'absent');

  writeProject(root, 'ready', { 'work-tracker': {
    provider: 'plane', 'credential-ref': 'env:PLANE_READY', config: { 'api-base-url': 'https://plane.example', 'workspace-slug': 'ws', 'project-id': 'p' }
  } });
  const ready = diagnosis(root, 'ready', ':credential-resolver (fn [_ ref] {:present true :state "present" :credential-ref ref :value "DOCTOR_SECRET_SENTINEL"})');
  assert.equal(ready.state, 'ready');
  assert.equal(ready['credential-state'], 'present');
  assert.equal(ready.config, undefined);
  assert.doesNotMatch(JSON.stringify(ready), /DOCTOR_SECRET_SENTINEL/);
});

test('doctor exposes independent config and credential checks for valid v2 projects', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt-doctor-report-'));
  writeProject(root, 'configured', { 'work-tracker': {
    provider: 'jira', 'credential-ref': 'env:JIRA_READY', config: { 'base-url': 'https://jira.example', 'project-key': 'TES' }
  } });
  writeProject(root, 'none', {});
  const configured = bbJson(`
(require '[cheshire.core :as json]) (require '[tesseraft.control-plane.doctor :as doctor])
(println (json/generate-string (doctor/doctor-report {:workspace-root ${q(root)} :tesseraft-home ${q(path.join(root, 'home'))}
  :credential-resolver (fn [_ ref] {:present true :state "present" :credential-ref ref :value "DOCTOR_SECRET_SENTINEL"})} "configured")))`);
  assert.equal(configured.checks.length, 10);
  const config = configured.checks.find((check) => check.id === 'work-tracker-config');
  const credential = configured.checks.find((check) => check.id === 'work-tracker-credential');
  assert.equal(config.state, 'ready');
  assert.equal(credential.state, 'ready');
  assert.equal(configured.work_tracker.source, 'descriptor');
  assert.doesNotMatch(JSON.stringify(configured), /DOCTOR_SECRET_SENTINEL/);

  const none = bbJson(`
(require '[cheshire.core :as json]) (require '[tesseraft.control-plane.doctor :as doctor])
(println (json/generate-string (doctor/doctor-report {:workspace-root ${q(root)} :tesseraft-home ${q(path.join(root, 'home'))}} "none")))`);
  assert.equal(none.work_tracker.state, 'absent');
  assert.equal(none.checks.find((check) => check.id === 'work-tracker-config').status, 'not-configured');
});

test('diagnosis follows the registered descriptor across roots and classifies unreadable bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt-doctor-cross-root-'));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt-external-project-'));
  writeProject(root, 'external', { 'work-tracker': {
    provider: 'jira', 'credential-ref': 'env:EXTERNAL_JIRA', config: { 'base-url': 'https://jira.example', 'project-key': 'EXT' }
  } }, external);
  assert.equal(diagnosis(root, 'external').provider, 'jira');

  const corrupt = writeProject(root, 'corrupt', {});
  fs.writeFileSync(corrupt.descriptorPath, '{not valid json');
  for (const fnName of ['work-tracker-diagnosis', 'work-tracker-config-diagnosis', 'work-tracker-credential-diagnosis']) {
    const result = bbJson(`
(require '[cheshire.core :as json]) (require '[tesseraft.control-plane.core :as cp])
(println (json/generate-string (cp/${fnName} {:workspace-root ${q(root)} :tesseraft-home ${q(path.join(root, 'home'))}} "corrupt")))`);
    assert.equal(result.state, 'invalid');
    assert.match(result.message, /not readable JSON/);
  }
});

test('provider metadata comes from the closed executable catalog and contains no credentials', () => {
  const result = bbJson(`
(require '[cheshire.core :as json]) (require '[tesseraft.control-plane.core :as cp])
(println (json/generate-string {:registration-exposed (boolean (ns-resolve 'tesseraft.control-plane.core 'register-work-tracker-provider!))
                                :catalog (cp/list-work-tracker-providers)}))`);
  assert.equal(result['registration-exposed'], false);
  assert.deepEqual(result.catalog.providers.map((provider) => provider.provider), ['github-issues', 'jira', 'plane']);
  const plane = result.catalog.providers.find((provider) => provider.provider === 'plane');
  assert.deepEqual(plane.fields.map((field) => field.name), ['api-base-url', 'workspace-slug', 'project-id']);
  assert.ok(plane.fields.every((field) => field.required));
  assert.doesNotMatch(JSON.stringify(result), /credential.?value|access.?token|secret.?value/i);
});
