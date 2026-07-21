import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from '../web/dist-server/server.js';

// ---- Harness (mirrors test/web-server.test.js) ----
const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    server.off('error', reject);
    resolve(server.address().port);
  });
});
const close = (server) => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});
const json = async (response) => response.json();

// ---- Minimal local-only workflow (noop/succeed -> terminal) ----
const workflowEdn = (name, title) => [
  '{:api-version "tesseraft.workflow/v1"',
  ' :kind :workflow',
  ` :metadata {:name "${name}" :title "${title}"}`,
  ' :defaults {:max-rounds 1 :state-timeout "1m"}',
  ' :policies {:require-timeouts true :require-max-rounds true}',
  ' :initial :start',
  ' :states {:start {:type :deterministic :handler :noop/succeed :runtime {:timeout "10s"} :next :done}',
  '           :done {:type :terminal :title "Done" :status :success}}}'
].join('\n');

const PROJECTS_DIR = path.join(process.cwd(), '.tesseraft', 'projects');
const ALPHA_WS = path.join(process.cwd(), '.agent-runs', 'proj-scope-alpha-ws');
const BETA_WS = path.join(process.cwd(), '.agent-runs', 'proj-scope-beta-ws');
const ALPHA_MANIFEST = path.join(PROJECTS_DIR, 'alpha.json');
const BETA_MANIFEST = path.join(PROJECTS_DIR, 'beta.json');
const ROOT_DESCRIPTOR = path.join(process.cwd(), '.tesseraft', 'project.json');
const ROOT_WORKFLOW_FIXTURE = path.join(process.cwd(), '.tesseraft', 'workflows', 'root-workflow');
const SC004_ROOT = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc004-root');
const SC004_DESCRIPTOR = path.join(SC004_ROOT, '.tesseraft', 'project.json');
const SC004_MANIFEST = path.join(PROJECTS_DIR, 'sc004-project.json');
const SC004_REGISTRY_HOME = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc004-home');
const SC004_REGISTRY = path.join(SC004_REGISTRY_HOME, 'projects', 'registry.json');
const SC004_LEGACY_SENTINEL = path.join(SC004_ROOT, '.tesseraft', 'projects', 'legacy-default.json');
const SC005_OLD_ROOT = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc005-old-root');
const SC005_NEW_ROOT = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc005-new-root');
const SC005_NEW_DESCRIPTOR = path.join(SC005_NEW_ROOT, '.tesseraft', 'project.json');
const SC005_MANIFEST = path.join(PROJECTS_DIR, 'sc005-project.json');
const SC005_REGISTRY_HOME = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc005-home');
const SC006_REGISTERED_ROOT = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc006-registered-root');
const SC006_MANIFEST = path.join(PROJECTS_DIR, 'sc006-project.json');
const SC007_ROOT = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc007-unsupported-version-root');
const SC007_DESCRIPTOR = path.join(SC007_ROOT, '.tesseraft', 'project.json');
const SC007_MANIFEST = path.join(PROJECTS_DIR, 'sc007-unsupported-version.json');
const SC008_LINK_ROOT = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc008-linked-root');
const SC008_MANIFEST = path.join(PROJECTS_DIR, 'sc008-symlink-escape.json');
const SC009_ALLOWED_ROOT = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc009-allowed-root');
const SC009_OUTSIDE_ROOT = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc009-outside-root');
const SC009_SYMLINK_ROOT = path.join(SC009_ALLOWED_ROOT, 'linked-outside-root');
const SC009_DIRECT_MANIFEST = path.join(PROJECTS_DIR, 'sc009-outside-root.json');
const SC009_SYMLINK_MANIFEST = path.join(PROJECTS_DIR, 'sc009-symlink-escaped-root.json');
const SC009_LEGACY_BYPASS_MANIFEST = path.join(PROJECTS_DIR, 'sc009-legacy-bypass.json');
const SC010_ROOT = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc010-migration-root');
const SC010_DESCRIPTOR = path.join(SC010_ROOT, '.tesseraft', 'project.json');
const SC010_LEGACY_REGISTRATION = path.join(PROJECTS_DIR, 'sc010-legacy-project.json');
const SC010_REGISTRY_HOME = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc010-home');
const SC010_REGISTRY = path.join(SC010_REGISTRY_HOME, 'projects', 'registry.json');
const SC010_LEGACY_MANIFEST = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc010-legacy-control', 'sc010-legacy-project.json');
const SC011_ROOT = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc011-migration-root');
const SC011_DESCRIPTOR = path.join(SC011_ROOT, '.tesseraft', 'project.json');
const SC011_LEGACY_REGISTRATION = path.join(PROJECTS_DIR, 'sc011-legacy-project.json');
const SC011_REGISTRY_HOME = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc011-home');
const SC011_REGISTRY = path.join(SC011_REGISTRY_HOME, 'projects', 'registry.json');
const SC011_LEGACY_MANIFEST = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc011-legacy-control', 'sc011-legacy-project.json');
const SC012_ROOT = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc012-browser-contract-root');
const SC012_DESCRIPTOR = path.join(SC012_ROOT, '.tesseraft', 'project.json');
const SC012_REGISTRY_HOME = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc012-home');
const SC013_ROOT = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc013-cli-migration-root');
const SC013_DESCRIPTOR = path.join(SC013_ROOT, '.tesseraft', 'project.json');
const SC013_REGISTRY_HOME = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc013-home');
const SC013_REGISTRY = path.join(SC013_REGISTRY_HOME, 'projects', 'registry.json');
const SC013_LEGACY_REGISTRATION = path.join(PROJECTS_DIR, 'sc013-cli-legacy.json');
const SC013_LEGACY_MANIFEST = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc013-legacy-control', 'sc013-cli-legacy.json');

const manifest = (id, name, ws) => ({
  project_id: id,
  name,
  workspace_root: path.relative(process.cwd(), ws),
  runs_root: 'runs',
  discovery: { 'workflow-roots': ['.tesseraft/workflows'] }
});

const writeWorkflow = (ws, name, title) => {
  const dir = path.join(ws, '.tesseraft', 'workflows', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflow.edn'), workflowEdn(name, title));
};

const cleanup = () => {
  fs.rmSync(ALPHA_MANIFEST, { force: true });
  fs.rmSync(BETA_MANIFEST, { force: true });
  fs.rmSync(ROOT_DESCRIPTOR, { force: true });
  fs.rmSync(ROOT_WORKFLOW_FIXTURE, { recursive: true, force: true });
  fs.rmSync(SC004_MANIFEST, { force: true });
  fs.rmSync(SC004_REGISTRY_HOME, { recursive: true, force: true });
  fs.rmSync(SC005_MANIFEST, { force: true });
  fs.rmSync(SC005_REGISTRY_HOME, { recursive: true, force: true });
  fs.rmSync(SC006_MANIFEST, { force: true });
  fs.rmSync(SC007_MANIFEST, { force: true });
  fs.rmSync(SC004_ROOT, { recursive: true, force: true });
  fs.rmSync(SC005_OLD_ROOT, { recursive: true, force: true });
  fs.rmSync(SC005_NEW_ROOT, { recursive: true, force: true });
  fs.rmSync(SC006_REGISTERED_ROOT, { recursive: true, force: true });
  fs.rmSync(SC007_ROOT, { recursive: true, force: true });
  fs.rmSync(SC008_MANIFEST, { force: true });
  fs.rmSync(SC008_LINK_ROOT, { recursive: true, force: true });
  fs.rmSync(SC009_DIRECT_MANIFEST, { force: true });
  fs.rmSync(SC009_SYMLINK_MANIFEST, { force: true });
  fs.rmSync(SC009_LEGACY_BYPASS_MANIFEST, { force: true });
  fs.rmSync(SC009_SYMLINK_ROOT, { force: true });
  fs.rmSync(SC009_ALLOWED_ROOT, { recursive: true, force: true });
  fs.rmSync(SC009_OUTSIDE_ROOT, { recursive: true, force: true });
  fs.rmSync(SC010_ROOT, { recursive: true, force: true });
  fs.rmSync(SC010_LEGACY_REGISTRATION, { force: true });
  fs.rmSync(SC010_REGISTRY_HOME, { recursive: true, force: true });
  fs.rmSync(path.dirname(SC010_LEGACY_MANIFEST), { recursive: true, force: true });
  fs.rmSync(SC011_ROOT, { recursive: true, force: true });
  fs.rmSync(SC011_LEGACY_REGISTRATION, { force: true });
  fs.rmSync(SC011_REGISTRY_HOME, { recursive: true, force: true });
  fs.rmSync(path.dirname(SC011_LEGACY_MANIFEST), { recursive: true, force: true });
  fs.rmSync(SC012_ROOT, { recursive: true, force: true });
  fs.rmSync(SC012_REGISTRY_HOME, { recursive: true, force: true });
  fs.rmSync(SC013_ROOT, { recursive: true, force: true });
  fs.rmSync(SC013_LEGACY_REGISTRATION, { force: true });
  fs.rmSync(SC013_REGISTRY_HOME, { recursive: true, force: true });
  fs.rmSync(path.dirname(SC013_LEGACY_MANIFEST), { recursive: true, force: true });
  fs.rmSync(ALPHA_WS, { recursive: true, force: true });
  fs.rmSync(BETA_WS, { recursive: true, force: true });
};

test('SC-002 explicit project id reports agreeing descriptor and legacy duplicates', async (t) => {
  cleanup();
  t.after(() => cleanup());

  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(ROOT_DESCRIPTOR), { recursive: true });
  fs.writeFileSync(ROOT_DESCRIPTOR, JSON.stringify({
    version: 1,
    project_id: 'alpha',
    name: 'Alpha Descriptor',
    runs_root: 'runs',
    discovery: { 'workflow-roots': ['.tesseraft/workflows'] }
  }, null, 2));
  fs.writeFileSync(ALPHA_MANIFEST, JSON.stringify(manifest('alpha', 'Alpha Legacy', process.cwd()), null, 2));

  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const response = await fetch(`${base}/api/projects/alpha`);
  assert.equal(response.status, 200, 'explicit project id alpha should select agreeing descriptor and legacy sources');
  const body = await response.json();
  assert.equal(body.project_id, 'alpha', 'selected project should keep the explicitly requested project id');
  assert.equal(body.source, 'descriptor', 'nearest matching descriptor should be the chosen source');
  assert.ok(Array.isArray(body.diagnostics?.duplicates), 'SC-002 duplicate diagnostics should list agreeing duplicate sources');
  assert.ok(
    body.diagnostics.duplicates.some((duplicate) => duplicate?.source === 'manifest'),
    `SC-002 duplicate diagnostics should include the agreeing legacy manifest; got ${JSON.stringify(body.diagnostics.duplicates)}`
  );
});

test('SC-002 explicit project id ignores non-matching nearest descriptor and fails closed for operations', async (t) => {
  cleanup();
  t.after(() => cleanup());

  fs.mkdirSync(path.dirname(ROOT_DESCRIPTOR), { recursive: true });
  fs.writeFileSync(ROOT_DESCRIPTOR, JSON.stringify({
    version: 1,
    project_id: 'alpha',
    name: 'Alpha Descriptor',
    runs_root: 'runs',
    discovery: { 'workflow-roots': ['.tesseraft/workflows'] }
  }, null, 2));

  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const detail = await fetch(`${base}/api/projects/beta`);
  assert.equal(detail.status, 404, 'SC-002 requested id beta should not select a nearest descriptor for alpha');
  const detailBody = await detail.json();
  assert.equal(detailBody.error?.code, 'not_found', `SC-002 mismatched descriptor should fall through to not_found; got ${JSON.stringify(detailBody)}`);

  const workflows = await fetch(`${base}/api/projects/beta/workflows`);
  assert.equal(workflows.status, 404, 'SC-002 project-scoped operations for unknown ids must fail closed instead of using the invocation workspace');
  const workflowsBody = await workflows.json();
  assert.equal(workflowsBody.error?.code, 'not_found', `SC-002 unknown-id operation should propagate not_found; got ${JSON.stringify(workflowsBody)}`);
});

test('project-scoped operations fail closed when project resolution fails', async (t) => {
  cleanup();
  t.after(() => cleanup());

  fs.mkdirSync(path.dirname(ROOT_DESCRIPTOR), { recursive: true });
  fs.writeFileSync(ROOT_DESCRIPTOR, JSON.stringify({
    version: 1,
    project_id: 'alpha',
    name: 'Alpha Descriptor',
    runs_root: 'runs',
    discovery: { 'workflow-roots': ['.tesseraft/workflows'] }
  }, null, 2));
  writeWorkflow(process.cwd(), 'root-workflow', 'Root Workflow Must Not Leak');

  const rootSettings = path.join(process.cwd(), '.tesseraft', 'settings.json');
  const rootGitUser = path.join(process.cwd(), '.tesseraft', 'git-user.json');
  fs.rmSync(rootSettings, { force: true });
  fs.rmSync(rootGitUser, { force: true });

  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  const unknown = 'missing-project';

  const reads = [
    `/api/projects/${unknown}/workflows/root-workflow`,
    `/api/projects/${unknown}/workflows/root-workflow/graph`,
    `/api/projects/${unknown}/runs`,
    `/api/projects/${unknown}/runs/any-run`,
    `/api/projects/${unknown}/settings`,
    `/api/projects/${unknown}/git-user`
  ];
  for (const route of reads) {
    const response = await fetch(`${base}${route}`);
    assert.equal(response.status, 404, `${route} must propagate the project resolution status`);
    const body = await response.json();
    assert.equal(body.error?.code, 'not_found', `${route} must propagate the structured project resolution error; got ${JSON.stringify(body)}`);
    assert.equal(body.workflow, undefined, `${route} must not fall back to root workflow discovery`);
    assert.equal(body.runs, undefined, `${route} must not fall back to root run listing`);
    assert.equal(body.settings, undefined, `${route} must not fall back to root settings`);
    assert.equal(body.git_user, undefined, `${route} must not fall back to root git-user`);
  }

  const settingsWrite = await fetch(`${base}/api/projects/${unknown}/settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ color_scheme: 'matrix' })
  });
  assert.equal(settingsWrite.status, 404, 'settings mutation must fail on project resolution before writing');
  assert.equal((await settingsWrite.json()).error?.code, 'not_found');
  assert.equal(fs.existsSync(rootSettings), false, 'failed project-scoped settings mutation must not write root settings');

  const gitUserWrite = await fetch(`${base}/api/projects/${unknown}/git-user`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Missing Project', email: 'missing@example.com' })
  });
  assert.equal(gitUserWrite.status, 404, 'git-user mutation must fail on project resolution before writing');
  assert.equal((await gitUserWrite.json()).error?.code, 'not_found');
  assert.equal(fs.existsSync(rootGitUser), false, 'failed project-scoped git-user mutation must not write root git-user');
});

test('SC-004 registers and unregisters a descriptor-derived project identity', async (t) => {
  cleanup();
  t.after(() => cleanup());

  fs.mkdirSync(path.dirname(SC004_DESCRIPTOR), { recursive: true });
  fs.writeFileSync(SC004_DESCRIPTOR, JSON.stringify({
    version: 1,
    project_id: 'sc004-project',
    name: 'SC004 Descriptor Project',
    runs_root: 'runs',
    discovery: { 'workflow-roots': ['.tesseraft/workflows'] }
  }, null, 2));
  fs.mkdirSync(path.dirname(SC004_LEGACY_SENTINEL), { recursive: true });
  fs.writeFileSync(SC004_LEGACY_SENTINEL, JSON.stringify({ project_id: 'default', workspace_root: '.', marker: 'keep-me' }, null, 2));
  fs.mkdirSync(path.join(SC004_ROOT, 'runs', 'existing-run-data'), { recursive: true });

  const expectedRoot = fs.realpathSync(SC004_ROOT);
  const descriptorBefore = fs.readFileSync(SC004_DESCRIPTOR, 'utf8');
  const legacyBefore = fs.readFileSync(SC004_LEGACY_SENTINEL, 'utf8');
  const dataBefore = fs.existsSync(path.join(SC004_ROOT, 'runs', 'existing-run-data'));
  process.env.TESSERAFT_HOME = SC004_REGISTRY_HOME;
  t.after(() => { delete process.env.TESSERAFT_HOME; });

  const server = createServer({ browserAllowedProjectRoots: [SC004_ROOT] });
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const register = async () => fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_root: SC004_ROOT })
  });

  const firstRegister = await register();
  assert.equal(firstRegister.status, 201, 'SC-004 descriptor-derived registration should not require caller-supplied project_id');
  const firstBody = await firstRegister.json();
  assert.equal(firstBody.project_id, 'sc004-project', 'SC-004 registration should derive project_id from .tesseraft/project.json');
  assert.equal(path.normalize(firstBody.workspace_root || firstBody.canonical_root || ''), expectedRoot, 'SC-004 registration should store the canonical descriptor root');
  assert.equal(fs.existsSync(SC004_MANIFEST), false, 'SC-004 registration must not write legacy workspace manifest storage');
  assert.equal(fs.existsSync(SC004_REGISTRY), true, 'SC-004 registration should be stored in a versioned user-local registry');
  const registry = JSON.parse(fs.readFileSync(SC004_REGISTRY, 'utf8'));
  assert.equal(registry.version, 1, 'SC-004 user-local registry should declare schema version 1');
  assert.equal(path.normalize(registry.projects?.['sc004-project']?.workspace_root || ''), expectedRoot, 'SC-004 registry mapping should store the canonical root');

  const secondRegister = await register();
  assert.ok(secondRegister.status === 200 || secondRegister.status === 201, `SC-004 repeat registration should be idempotent; got ${secondRegister.status}`);

  const list = await fetch(`${base}/api/projects`).then(json);
  const registrations = list.projects.filter((project) => project.project_id === 'sc004-project');
  assert.equal(registrations.length, 1, `SC-004 list should report exactly one registration; got ${JSON.stringify(registrations)}`);
  assert.equal(path.normalize(registrations[0].workspace_root || registrations[0].canonical_root || ''), expectedRoot, 'SC-004 list should report the registered canonical root');

  const detail = await fetch(`${base}/api/projects/sc004-project`).then(json);
  assert.equal(detail.project_id, 'sc004-project', 'SC-004 detail should resolve the registered descriptor-derived id');
  assert.equal(path.normalize(detail.workspace_root || detail.canonical_root || ''), expectedRoot, 'SC-004 detail should report the registered canonical root');
  assert.equal(detail.source, 'registration', 'SC-004 detail/source inspection should identify user-local registration as the source');

  const unregister = await fetch(`${base}/api/projects/sc004-project`, { method: 'DELETE' });
  assert.ok(unregister.status === 200 || unregister.status === 204, `SC-004 unregister should remove the user-local registration; got ${unregister.status}`);
  const registryAfterUnregister = JSON.parse(fs.readFileSync(SC004_REGISTRY, 'utf8'));
  assert.equal(registryAfterUnregister.projects?.['sc004-project'], undefined, 'SC-004 unregister should remove only the user-local registry mapping');
  assert.equal(fs.existsSync(SC004_MANIFEST), false, 'SC-004 unregister should not create or delete legacy workspace manifest storage');
  assert.equal(fs.readFileSync(SC004_DESCRIPTOR, 'utf8'), descriptorBefore, 'SC-004 unregister must leave the descriptor unchanged');
  assert.equal(fs.readFileSync(SC004_LEGACY_SENTINEL, 'utf8'), legacyBefore, 'SC-004 unregister must leave legacy project files unchanged');
  assert.equal(fs.existsSync(path.join(SC004_ROOT, 'runs', 'existing-run-data')), dataBefore, 'SC-004 unregister must leave project data unchanged');
});

test('browser registration derives project-owned fields from descriptor and preserves malformed registry on delete', async (t) => {
  cleanup();
  t.after(() => cleanup());

  fs.mkdirSync(path.dirname(SC012_DESCRIPTOR), { recursive: true });
  fs.writeFileSync(SC012_DESCRIPTOR, JSON.stringify({
    version: 1,
    project_id: 'sc012-descriptor-owned',
    name: 'SC012 Descriptor Owned',
    runs_root: 'runs',
    discovery: { 'workflow-roots': ['.tesseraft/workflows'] }
  }, null, 2));
  process.env.TESSERAFT_HOME = SC012_REGISTRY_HOME;
  t.after(() => { delete process.env.TESSERAFT_HOME; });

  const server = createServer({ browserAllowedProjectRoots: [SC012_ROOT] });
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const register = await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_root: SC012_ROOT,
      project_id: 'caller-override',
      name: 'Caller Override',
      runs_root: 'caller-runs',
      discovery: { 'workflow-roots': ['caller-workflows'] }
    })
  });
  assert.equal(register.status, 201, `browser registration should accept descriptor-backed roots without caller identity override; got ${register.status}`);
  const body = await register.json();
  assert.equal(body.project_id, 'sc012-descriptor-owned', 'browser registration must derive project_id only from descriptor');
  assert.equal(body.name, 'SC012 Descriptor Owned', 'browser registration must derive name only from descriptor');
  assert.equal(body.runs_root, 'runs', 'browser registration must derive runs_root only from descriptor');
  assert.deepEqual(body.discovery?.['workflow-roots'], ['.tesseraft/workflows'], 'browser registration must derive workflow roots only from descriptor');

  const registryPath = path.join(SC012_REGISTRY_HOME, 'projects', 'registry.json');
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const malformedRegistry = '{"version":999,"projects":{"sc012-descriptor-owned":{}}}\n';
  fs.writeFileSync(registryPath, malformedRegistry);
  const unregister = await fetch(`${base}/api/projects/sc012-descriptor-owned`, { method: 'DELETE' });
  assert.equal(unregister.status, 400, `browser unregister must reject invalid durable registry state; got ${unregister.status}`);
  assert.equal(fs.readFileSync(registryPath, 'utf8'), malformedRegistry, 'browser unregister must not normalize or overwrite invalid registry state');
});

test('SC-005 reports stale registrations and accepts explicit re-registration at the new root', async (t) => {
  cleanup();
  t.after(() => cleanup());

  process.env.TESSERAFT_HOME = SC005_REGISTRY_HOME;
  t.after(() => { delete process.env.TESSERAFT_HOME; });

  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  fs.mkdirSync(SC005_OLD_ROOT, { recursive: true });
  const staleRoot = fs.realpathSync(SC005_OLD_ROOT);
  fs.writeFileSync(SC005_MANIFEST, JSON.stringify({
    project_id: 'sc005-project',
    name: 'SC005 Stale Registration',
    workspace_root: staleRoot,
    runs_root: 'runs',
    discovery: { 'workflow-roots': ['.tesseraft/workflows'] },
    source: 'registration'
  }, null, 2));
  fs.rmSync(SC005_OLD_ROOT, { recursive: true, force: true });

  const server = createServer({ browserAllowedProjectRoots: [path.join(process.cwd(), '.agent-runs')] });
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const staleSelection = await fetch(`${base}/api/projects/sc005-project`);
  assert.equal(staleSelection.status, 409, 'SC-005 stale registration selection should fail with a focused missing-root diagnostic');
  const staleBody = await staleSelection.json();
  assert.equal(staleBody.error?.code, 'stale_project_root', `SC-005 stale diagnostic should use stale_project_root; got ${JSON.stringify(staleBody)}`);
  assert.equal(path.normalize(staleBody.error?.details?.recorded_root || ''), staleRoot, 'SC-005 stale diagnostic should report the recorded missing root');
  assert.equal(staleBody.error?.details?.searched_for_replacement, false, 'SC-005 must not search for a replacement root');

  fs.mkdirSync(path.dirname(SC005_NEW_DESCRIPTOR), { recursive: true });
  fs.writeFileSync(SC005_NEW_DESCRIPTOR, JSON.stringify({
    version: 1,
    project_id: 'sc005-project',
    name: 'SC005 Moved Project',
    runs_root: 'runs',
    discovery: { 'workflow-roots': ['.tesseraft/workflows'] }
  }, null, 2));
  const newRoot = fs.realpathSync(SC005_NEW_ROOT);

  const registerNewRoot = await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_root: SC005_NEW_ROOT })
  });
  assert.ok(registerNewRoot.status === 200 || registerNewRoot.status === 201, `SC-005 explicit re-registration at the new root should replace the stale mapping; got ${registerNewRoot.status}`);
  const registered = await registerNewRoot.json();
  assert.equal(registered.project_id, 'sc005-project', 'SC-005 re-registration should keep the descriptor project id');
  assert.equal(path.normalize(registered.workspace_root || registered.canonical_root || ''), newRoot, 'SC-005 re-registration should store the new canonical root');

  const detail = await fetch(`${base}/api/projects/sc005-project`).then(json);
  assert.equal(detail.project_id, 'sc005-project', 'SC-005 selection should succeed after explicit re-registration');
  assert.equal(path.normalize(detail.workspace_root || detail.canonical_root || ''), newRoot, 'SC-005 selection should use only the new registered root');
  assert.equal(detail.source, 'registration', 'SC-005 selection after re-registration should identify registration as source');
});

test('SC-006 rejects conflicting canonical roots across project sources', async (t) => {
  cleanup();
  t.after(() => cleanup());

  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(ROOT_DESCRIPTOR), { recursive: true });
  fs.mkdirSync(SC006_REGISTERED_ROOT, { recursive: true });
  fs.writeFileSync(ROOT_DESCRIPTOR, JSON.stringify({
    version: 1,
    project_id: 'sc006-project',
    name: 'SC006 Descriptor Project',
    runs_root: 'runs',
    discovery: { 'workflow-roots': ['.tesseraft/workflows'] }
  }, null, 2));
  fs.writeFileSync(SC006_MANIFEST, JSON.stringify({
    project_id: 'sc006-project',
    name: 'SC006 Registered Elsewhere',
    workspace_root: fs.realpathSync(SC006_REGISTERED_ROOT),
    runs_root: 'runs',
    discovery: { 'workflow-roots': ['.tesseraft/workflows'] },
    source: 'registration'
  }, null, 2));
  const descriptorRoot = fs.realpathSync(process.cwd());
  const registeredRoot = fs.realpathSync(SC006_REGISTERED_ROOT);

  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const response = await fetch(`${base}/api/projects/sc006-project`);
  assert.equal(response.status, 409, 'SC-006 conflicting canonical roots should reject selection with a project identity conflict');
  const body = await response.json();
  assert.equal(body.error?.code, 'project_identity_conflict', `SC-006 conflict diagnostic should use project_identity_conflict; got ${JSON.stringify(body)}`);
  assert.equal(body.error?.details?.project_id, 'sc006-project', 'SC-006 conflict diagnostic should name the conflicting project id');
  assert.ok(Array.isArray(body.error?.details?.sources), `SC-006 conflict diagnostic should list disagreeing sources; got ${JSON.stringify(body)}`);
  assert.ok(
    body.error.details.sources.some((source) => source?.source === 'descriptor' && path.normalize(source.canonical_root || source.workspace_root || '') === descriptorRoot),
    `SC-006 conflict diagnostic should include descriptor canonical root ${descriptorRoot}; got ${JSON.stringify(body.error.details.sources)}`
  );
  assert.ok(
    body.error.details.sources.some((source) => source?.source === 'registration' && path.normalize(source.canonical_root || source.workspace_root || '') === registeredRoot),
    `SC-006 conflict diagnostic should include registration canonical root ${registeredRoot}; got ${JSON.stringify(body.error.details.sources)}`
  );
  assert.equal(body.project_id, undefined, 'SC-006 conflict must not select either project source');
});

test('SC-007 rejects unsupported versioned project descriptors before registration', async (t) => {
  cleanup();
  t.after(() => cleanup());

  const sc007Root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-sc007-root-'));
  t.after(() => fs.rmSync(sc007Root, { recursive: true, force: true }));
  const sc007Descriptor = path.join(sc007Root, '.tesseraft', 'project.json');
  fs.mkdirSync(path.dirname(sc007Descriptor), { recursive: true });
  fs.writeFileSync(sc007Descriptor, JSON.stringify({
    version: 999,
    project_id: 'sc007-unsupported-version',
    name: 'SC007 Unsupported Descriptor Version',
    runs_root: 'runs',
    discovery: { 'workflow-roots': ['.tesseraft/workflows'] }
  }, null, 2));

  const server = createServer({ browserAllowedProjectRoots: [sc007Root] });
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const response = await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_root: sc007Root })
  });

  assert.equal(response.status, 400, 'SC-007 unsupported descriptor version should be rejected before registration');
  const body = await response.json();
  assert.equal(body.error?.code, 'invalid_project_descriptor', `SC-007 invalid-version diagnostic should use invalid_project_descriptor; got ${JSON.stringify(body)}`);
  assert.equal(body.project_id, undefined, 'SC-007 invalid descriptor must not select or register a project');
  assert.equal(fs.existsSync(SC007_MANIFEST), false, 'SC-007 invalid descriptor must not be persisted as a registration');
});

test('SC-008 rejects project-owned roots that symlink outside the project boundary', async (t) => {
  cleanup();
  t.after(() => cleanup());

  const sc008Root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-sc008-root-'));
  t.after(() => fs.rmSync(sc008Root, { recursive: true, force: true }));
  const externalRunsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-sc008-runs-'));
  t.after(() => fs.rmSync(externalRunsRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(sc008Root, '.tesseraft'), { recursive: true });
  fs.symlinkSync(externalRunsRoot, path.join(sc008Root, 'linked-runs'), 'dir');
  fs.writeFileSync(path.join(sc008Root, '.tesseraft', 'project.json'), JSON.stringify({
    version: 1,
    project_id: 'sc008-symlink-escape',
    name: 'SC008 Symlink Escape',
    runs_root: 'linked-runs',
    discovery: { 'workflow-roots': ['.tesseraft/workflows'] }
  }, null, 2));

  const server = createServer({ browserAllowedProjectRoots: [sc008Root] });
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const response = await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_root: sc008Root })
  });

  assert.equal(response.status, 400, 'SC-008 symlink-resolved runs_root outside the project boundary should be rejected');
  const body = await response.json();
  assert.equal(body.error?.code, 'project_path_escape', `SC-008 project-owned path confinement diagnostic should use project_path_escape; got ${JSON.stringify(body)}`);
  assert.equal(body.project_id, undefined, 'SC-008 symlink escape must not select or register a project');
  assert.equal(fs.existsSync(SC008_MANIFEST), false, 'SC-008 symlink escape must not be persisted as a registration');
});

test('SC-009 rejects browser project registration when no allowed roots are configured', async (t) => {
  cleanup();
  t.after(() => cleanup());

  fs.mkdirSync(path.join(SC009_OUTSIDE_ROOT, '.tesseraft'), { recursive: true });
  fs.writeFileSync(path.join(SC009_OUTSIDE_ROOT, '.tesseraft', 'project.json'), JSON.stringify({
    version: 1,
    project_id: 'sc009-outside-root',
    name: 'SC009 Outside Root',
    runs_root: 'runs',
    discovery: { 'workflow-roots': ['.tesseraft/workflows'] }
  }, null, 2));

  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const response = await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_root: SC009_OUTSIDE_ROOT })
  });
  assert.equal(response.status, 400, 'SC-009 production-default browser registration must fail closed without configured allowed roots');
  const body = await response.json();
  assert.equal(body.error?.code, 'project_root_not_allowed', `SC-009 default rejection should use project_root_not_allowed; got ${JSON.stringify(body)}`);
  assert.equal(fs.existsSync(SC009_DIRECT_MANIFEST), false, 'SC-009 default rejection must not persist registration state');
});

test('SC-009 rejects omitted and blank browser project roots before legacy project creation', async (t) => {
  cleanup();
  t.after(() => cleanup());

  fs.mkdirSync(SC009_ALLOWED_ROOT, { recursive: true });

  const server = createServer({ browserAllowedProjectRoots: [SC009_ALLOWED_ROOT] });
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  for (const body of [{ project_id: 'sc009-legacy-bypass' }, { project_id: 'sc009-legacy-bypass', project_root: '   ' }]) {
    const response = await fetch(`${base}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 400, `SC-009 browser registration must reject legacy body ${JSON.stringify(body)}`);
    const responseBody = await response.json();
    assert.equal(responseBody.error?.code, 'bad_request', `SC-009 missing-root diagnostic should be bad_request; got ${JSON.stringify(responseBody)}`);
    assert.equal(fs.existsSync(SC009_LEGACY_BYPASS_MANIFEST), false, 'SC-009 rejected legacy browser body must not create workspace-local project state');
  }
});

test('SC-009 confines browser project registration to configured filesystem roots', async (t) => {
  cleanup();
  t.after(() => cleanup());

  fs.mkdirSync(path.join(SC009_ALLOWED_ROOT, 'inside'), { recursive: true });
  fs.mkdirSync(path.join(SC009_OUTSIDE_ROOT, '.tesseraft'), { recursive: true });
  fs.writeFileSync(path.join(SC009_OUTSIDE_ROOT, '.tesseraft', 'project.json'), JSON.stringify({
    version: 1,
    project_id: 'sc009-outside-root',
    name: 'SC009 Outside Root',
    runs_root: 'runs',
    discovery: { 'workflow-roots': ['.tesseraft/workflows'] }
  }, null, 2));
  fs.symlinkSync(SC009_OUTSIDE_ROOT, SC009_SYMLINK_ROOT, 'dir');

  const server = createServer({ browserAllowedProjectRoots: [SC009_ALLOWED_ROOT] });
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const outsideResponse = await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_root: SC009_OUTSIDE_ROOT })
  });

  assert.equal(outsideResponse.status, 400, 'SC-009 outside browser project_root should be rejected by configured allowed roots');
  const outsideBody = await outsideResponse.json();
  assert.equal(outsideBody.error?.code, 'project_root_not_allowed', `SC-009 outside-root diagnostic should use project_root_not_allowed; got ${JSON.stringify(outsideBody)}`);
  assert.equal(outsideBody.project_id, undefined, 'SC-009 outside root must not select or register a project');
  assert.equal(fs.existsSync(SC009_DIRECT_MANIFEST), false, 'SC-009 rejected outside root must not be persisted as a registration');

  const symlinkResponse = await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_root: SC009_SYMLINK_ROOT })
  });

  assert.equal(symlinkResponse.status, 400, 'SC-009 symlink-escaped browser project_root should be rejected by configured allowed roots after realpath resolution');
  const symlinkBody = await symlinkResponse.json();
  assert.equal(symlinkBody.error?.code, 'project_root_not_allowed', `SC-009 symlink diagnostic should use project_root_not_allowed; got ${JSON.stringify(symlinkBody)}`);
  assert.equal(symlinkBody.project_id, undefined, 'SC-009 symlink-escaped root must not select or register a project');
  assert.equal(fs.existsSync(SC009_SYMLINK_MANIFEST), false, 'SC-009 rejected symlink-escaped root must not be persisted as a registration');
});

test('SC-010 migrates a valid legacy control manifest to portable project state repeatably', async (t) => {
  cleanup();
  t.after(() => cleanup());

  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(SC010_LEGACY_MANIFEST), { recursive: true });
  fs.mkdirSync(SC010_ROOT, { recursive: true });
  const legacyManifest = {
    project_id: 'sc010-legacy-project',
    name: 'SC010 Legacy Project',
    workspace_root: SC010_ROOT,
    runs_root: 'runs',
    discovery: { 'workflow-roots': ['.tesseraft/workflows'] },
    source: 'manifest'
  };
  fs.writeFileSync(SC010_LEGACY_MANIFEST, JSON.stringify(legacyManifest, null, 2));
  const legacyBefore = fs.readFileSync(SC010_LEGACY_MANIFEST, 'utf8');
  const expectedRoot = fs.realpathSync(SC010_ROOT);
  process.env.TESSERAFT_HOME = SC010_REGISTRY_HOME;
  t.after(() => { delete process.env.TESSERAFT_HOME; });

  const server = createServer({ browserAllowedProjectRoots: [SC010_ROOT] });
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const migrateBody = { legacy_manifest: SC010_LEGACY_MANIFEST, project_root: SC010_ROOT };
  const firstMigration = await fetch(`${base}/api/projects/sc010-legacy-project/migrate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(migrateBody)
  });
  assert.ok(firstMigration.status === 200 || firstMigration.status === 201, `SC-010 valid legacy migration should succeed; got ${firstMigration.status}`);
  const firstBody = await firstMigration.json();
  assert.equal(firstBody.project_id, 'sc010-legacy-project', 'SC-010 migration should report the migrated legacy project id');
  assert.equal(firstBody.source, 'descriptor', 'SC-010 migrated project should be selected from the new portable descriptor');
  assert.ok(firstBody.diagnostics?.migration || firstBody.diagnostics?.migrated_from || firstBody['migrated-from'], `SC-010 migration should report migration/source diagnostics; got ${JSON.stringify(firstBody)}`);

  assert.equal(fs.readFileSync(SC010_LEGACY_MANIFEST, 'utf8'), legacyBefore, 'SC-010 migration must preserve the legacy source byte-for-byte');
  assert.equal(fs.existsSync(SC010_DESCRIPTOR), true, 'SC-010 migration should create a portable .tesseraft/project.json descriptor');
  const descriptor = JSON.parse(fs.readFileSync(SC010_DESCRIPTOR, 'utf8'));
  assert.equal(descriptor.version, 1, 'SC-010 descriptor should declare supported portable version 1');
  assert.equal(descriptor.project_id, 'sc010-legacy-project', 'SC-010 descriptor should preserve legacy project identity');
  assert.equal(descriptor.workspace_root, undefined, 'SC-010 portable descriptor must not persist machine-specific workspace_root');
  assert.equal(descriptor.runs_root, 'runs', 'SC-010 descriptor should preserve project-relative runs_root');
  assert.deepEqual(descriptor.discovery?.['workflow-roots'], ['.tesseraft/workflows'], 'SC-010 descriptor should preserve project-relative workflow discovery roots');

  assert.equal(fs.existsSync(SC010_LEGACY_REGISTRATION), false, 'SC-010 migration must not write registration state into legacy workspace manifest storage');
  assert.equal(fs.existsSync(SC010_REGISTRY), true, 'SC-010 migration should create matching user-local registry state');
  const registry = JSON.parse(fs.readFileSync(SC010_REGISTRY, 'utf8'));
  assert.equal(registry.version, 1, 'SC-010 registry should declare schema version 1');
  const registration = registry.projects?.['sc010-legacy-project'];
  assert.ok(registration, `SC-010 registry should contain migrated registration; got ${JSON.stringify(registry)}`);
  assert.equal(path.normalize(registration.workspace_root || registration.canonical_root || ''), expectedRoot, 'SC-010 registration should store the canonical migrated root');

  const descriptorBeforeRepeat = fs.readFileSync(SC010_DESCRIPTOR, 'utf8');
  const registryBeforeRepeat = fs.readFileSync(SC010_REGISTRY, 'utf8');
  const repeatMigration = await fetch(`${base}/api/projects/sc010-legacy-project/migrate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(migrateBody)
  });
  assert.ok(repeatMigration.status === 200 || repeatMigration.status === 201, `SC-010 repeated completed migration should be safe and successful; got ${repeatMigration.status}`);
  assert.equal(fs.readFileSync(SC010_LEGACY_MANIFEST, 'utf8'), legacyBefore, 'SC-010 repeated migration must still preserve the legacy source byte-for-byte');
  assert.equal(fs.readFileSync(SC010_DESCRIPTOR, 'utf8'), descriptorBeforeRepeat, 'SC-010 repeated migration must not overwrite the destination descriptor');
  assert.equal(fs.readFileSync(SC010_REGISTRY, 'utf8'), registryBeforeRepeat, 'SC-010 repeated migration must not overwrite registration state');
});

test('SC-011 rolls back a migration-created descriptor when registration cannot be written', async (t) => {
  cleanup();
  t.after(() => {
    fs.rmSync(PROJECTS_DIR, { recursive: true, force: true });
    cleanup();
  });

  fs.mkdirSync(path.dirname(SC011_LEGACY_MANIFEST), { recursive: true });
  fs.mkdirSync(SC011_ROOT, { recursive: true });
  const legacyManifest = {
    project_id: 'sc011-legacy-project',
    name: 'SC011 Legacy Project',
    workspace_root: SC011_ROOT,
    runs_root: 'runs',
    discovery: { 'workflow-roots': ['.tesseraft/workflows'] },
    source: 'manifest'
  };
  fs.writeFileSync(SC011_LEGACY_MANIFEST, JSON.stringify(legacyManifest, null, 2));
  const legacyBefore = fs.readFileSync(SC011_LEGACY_MANIFEST, 'utf8');

  fs.rmSync(PROJECTS_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(PROJECTS_DIR), { recursive: true });
  fs.mkdirSync(SC011_REGISTRY_HOME, { recursive: true });
  fs.writeFileSync(path.join(SC011_REGISTRY_HOME, 'projects'), 'not a directory, so registry creation fails');
  process.env.TESSERAFT_HOME = SC011_REGISTRY_HOME;
  t.after(() => { delete process.env.TESSERAFT_HOME; });

  const server = createServer({ browserAllowedProjectRoots: [SC011_ROOT] });
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const migration = await fetch(`${base}/api/projects/sc011-legacy-project/migrate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ legacy_manifest: SC011_LEGACY_MANIFEST, project_root: SC011_ROOT })
  });
  assert.equal(migration.status, 400, `SC-011 migration with unwritable registration should report failure; got ${migration.status}`);
  const body = await migration.json();
  assert.equal(body.error?.code, 'migration_failed', `SC-011 failed migration should use migration_failed; got ${JSON.stringify(body)}`);

  assert.equal(fs.readFileSync(SC011_LEGACY_MANIFEST, 'utf8'), legacyBefore, 'SC-011 failed migration must preserve the legacy source byte-for-byte');
  assert.equal(fs.existsSync(SC011_LEGACY_REGISTRATION), false, 'SC-011 failed migration must not write legacy registration state');
  assert.equal(fs.existsSync(SC011_REGISTRY), false, 'SC-011 failed migration must not leave user-local registry state');
  assert.equal(fs.existsSync(SC011_DESCRIPTOR), false, 'SC-011 failed migration must roll back the migration-created destination descriptor');
});

test('local CLI migrates legacy manifest to portable descriptor and user registry repeatably', async (t) => {
  cleanup();
  t.after(() => cleanup());

  fs.mkdirSync(path.dirname(SC013_LEGACY_MANIFEST), { recursive: true });
  fs.mkdirSync(SC013_ROOT, { recursive: true });
  const legacyManifest = {
    project_id: 'sc013-cli-legacy',
    name: 'SC013 CLI Legacy',
    workspace_root: SC013_ROOT,
    runs_root: 'runs',
    discovery: { 'workflow-roots': ['.tesseraft/workflows'] },
    source: 'manifest'
  };
  fs.writeFileSync(SC013_LEGACY_MANIFEST, JSON.stringify(legacyManifest, null, 2));
  const legacyBefore = fs.readFileSync(SC013_LEGACY_MANIFEST, 'utf8');

  const output = JSON.parse(execFileSync('./bin/tesseraft', [
    'control-plane',
    '--workspace-root', process.cwd(),
    '--tesseraft-home', SC013_REGISTRY_HOME,
    'project', 'migrate', 'sc013-cli-legacy',
    '--legacy-manifest', SC013_LEGACY_MANIFEST,
    '--project-root', SC013_ROOT
  ], { encoding: 'utf8', stdio: 'pipe' }));
  assert.equal(output.project_id, 'sc013-cli-legacy', 'CLI migration should report migrated project id');
  assert.equal(output.source, 'descriptor', 'CLI migration should select migrated descriptor state');
  assert.equal(fs.readFileSync(SC013_LEGACY_MANIFEST, 'utf8'), legacyBefore, 'CLI migration must preserve legacy manifest bytes');
  assert.equal(fs.existsSync(SC013_LEGACY_REGISTRATION), false, 'CLI migration must not write legacy workspace registration');
  assert.equal(fs.existsSync(SC013_DESCRIPTOR), true, 'CLI migration must create portable descriptor');
  const descriptor = JSON.parse(fs.readFileSync(SC013_DESCRIPTOR, 'utf8'));
  assert.equal(descriptor.workspace_root, undefined, 'CLI migration descriptor must not persist machine-specific workspace_root');
  assert.equal(descriptor.project_id, 'sc013-cli-legacy');
  const registryBeforeRepeat = fs.readFileSync(SC013_REGISTRY, 'utf8');
  const descriptorBeforeRepeat = fs.readFileSync(SC013_DESCRIPTOR, 'utf8');

  execFileSync('./bin/tesseraft', [
    'control-plane',
    '--workspace-root', process.cwd(),
    '--tesseraft-home', SC013_REGISTRY_HOME,
    'project', 'migrate', 'sc013-cli-legacy',
    '--legacy-manifest', SC013_LEGACY_MANIFEST,
    '--project-root', SC013_ROOT
  ], { encoding: 'utf8', stdio: 'pipe' });
  assert.equal(fs.readFileSync(SC013_DESCRIPTOR, 'utf8'), descriptorBeforeRepeat, 'repeat CLI migration must not overwrite descriptor');
  assert.equal(fs.readFileSync(SC013_REGISTRY, 'utf8'), registryBeforeRepeat, 'repeat CLI migration must not overwrite registry');
});

test('two projects: discovery, settings, run identity, delete isolation, security', async (t) => {
  // Defensive: remove any leftovers from a prior crashed run before/after.
  cleanup();
  t.after(() => cleanup());

  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  writeWorkflow(ALPHA_WS, 'alpha-demo', 'Alpha Demo');
  writeWorkflow(BETA_WS, 'beta-demo', 'Beta Demo');
  fs.writeFileSync(ALPHA_MANIFEST, JSON.stringify(manifest('alpha', 'Alpha', ALPHA_WS), null, 2));
  fs.writeFileSync(BETA_MANIFEST, JSON.stringify(manifest('beta', 'Beta', BETA_WS), null, 2));

  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  const DUP_RUN_ID = 'proj-scope-dup';

  // 1. Discovery is project-scoped: each project sees only its own workflow.
  const alphaWf = await fetch(`${base}/api/projects/alpha/workflows`).then(json);
  const betaWf = await fetch(`${base}/api/projects/beta/workflows`).then(json);
  const alphaNames = alphaWf.workflows.map((w) => w.name);
  const betaNames = betaWf.workflows.map((w) => w.name);
  assert.ok(alphaNames.includes('alpha-demo'), `alpha should discover alpha-demo; got ${alphaNames.join(',')}`);
  assert.ok(!alphaNames.includes('beta-demo'), 'alpha must not discover beta-demo');
  assert.ok(betaNames.includes('beta-demo'), `beta should discover beta-demo; got ${betaNames.join(',')}`);
  assert.ok(!betaNames.includes('alpha-demo'), 'beta must not discover alpha-demo');

  // 2. Settings isolation: writing to alpha is invisible to beta. The control
  //    plane requires a provider whenever a model is set, so set both.
  const setAlpha = await fetch(`${base}/api/projects/alpha/settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pi_default_provider: 'alpha-provider', pi_default_model: 'Alpha-Model', color_scheme: 'matrix' })
  });
  assert.equal(setAlpha.status, 200);
  const alphaSettings = await fetch(`${base}/api/projects/alpha/settings`).then(json);
  const betaSettings = await fetch(`${base}/api/projects/beta/settings`).then(json);
  assert.equal(alphaSettings.settings.pi_default_provider, 'alpha-provider', 'alpha settings should reflect the write');
  assert.equal(alphaSettings.settings.pi_default_model, 'Alpha-Model', 'alpha settings should reflect the write');
  assert.equal(alphaSettings.settings.color_scheme, 'matrix', 'alpha should use its saved scheme');
  assert.equal(betaSettings.settings.color_scheme, 'classic', 'beta should retain the classic default');
  assert.notEqual(betaSettings.settings.pi_default_provider, 'alpha-provider', 'beta must not see alpha settings');
  assert.notEqual(betaSettings.settings.pi_default_model, 'Alpha-Model', 'beta must not see alpha settings');

  // 3. Run identity (project_id, run_id): identical run_id in two projects
  //    both start (202) and resolve independently; no 409 across projects.
  const startAlpha = await fetch(`${base}/api/projects/alpha/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflow_name: 'alpha-demo', run_id: DUP_RUN_ID, inputs: {}, max_steps: 1 })
  });
  assert.equal(startAlpha.status, 202, `alpha start should be 202; got ${startAlpha.status}`);
  const startBeta = await fetch(`${base}/api/projects/beta/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflow_name: 'beta-demo', run_id: DUP_RUN_ID, inputs: {}, max_steps: 1 })
  });
  assert.equal(startBeta.status, 202, `beta start with identical run_id should be 202 (no cross-project 409); got ${startBeta.status}`);

  // Both runs resolve under their own project; run dirs live under each
  // project's distinct runs root.
  const alphaRunRes = await fetch(`${base}/api/projects/alpha/runs/${DUP_RUN_ID}`);
  const betaRunRes = await fetch(`${base}/api/projects/beta/runs/${DUP_RUN_ID}`);
  assert.equal(alphaRunRes.status, 200, 'alpha run should resolve');
  assert.equal(betaRunRes.status, 200, 'beta run should resolve');
  const alphaRun = await alphaRunRes.json();
  const betaRun = await betaRunRes.json();
  assert.equal(alphaRun.run.run_id, DUP_RUN_ID);
  assert.equal(betaRun.run.run_id, DUP_RUN_ID);
  const alphaPath = String(alphaRun.run.path || alphaRun.run.dir || '');
  const betaPath = String(betaRun.run.path || betaRun.run.dir || '');
  assert.ok(alphaPath.includes('proj-scope-alpha-ws'), `alpha run dir should live under alpha workspace; got ${alphaPath}`);
  assert.ok(betaPath.includes('proj-scope-beta-ws'), `beta run dir should live under beta workspace; got ${betaPath}`);
  assert.notEqual(alphaPath, betaPath, 'run dirs must differ across projects');
  if (alphaRun.run.project_id) assert.equal(alphaRun.run.project_id, 'alpha', 'alpha run state should carry project_id alpha');
  if (betaRun.run.project_id) assert.equal(betaRun.run.project_id, 'beta', 'beta run state should carry project_id beta');

  // 4. Delete isolation: deleting alpha's run leaves beta's intact.
  const deleteAlpha = await fetch(`${base}/api/projects/alpha/runs/${DUP_RUN_ID}`, { method: 'DELETE' });
  assert.ok(deleteAlpha.status === 200 || deleteAlpha.status === 202, `delete alpha should succeed; got ${deleteAlpha.status}`);
  const alphaAfter = await fetch(`${base}/api/projects/alpha/runs/${DUP_RUN_ID}`);
  assert.equal(alphaAfter.status, 404, 'alpha run should be gone after delete');
  const betaAfter = await fetch(`${base}/api/projects/beta/runs/${DUP_RUN_ID}`);
  assert.equal(betaAfter.status, 200, 'beta run must still resolve after alpha is deleted');

  // 5. Credential-ref security: raw token payloads are rejected on connection writes.
  const rawToken = await fetch(`${base}/api/projects/alpha/connections`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ github: { github_token: 'plaintext-secret' } })
  });
  assert.equal(rawToken.status, 400, 'raw github_token payload must be rejected');

  // 6. Path confinement: an absolute (escaping) runs_root is rejected on create.
  const escape = await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: 'bad-escape', runs_root: '/etc' })
  });
  assert.equal(escape.status, 400, 'absolute runs_root must be rejected');
  // Ensure no manifest was written for the rejected project.
  assert.equal(fs.existsSync(path.join(PROJECTS_DIR, 'bad-escape.json')), false, 'rejected project must not be persisted');
});
