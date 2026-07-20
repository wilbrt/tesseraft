import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
const SC004_ROOT = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc004-root');
const SC004_DESCRIPTOR = path.join(SC004_ROOT, '.tesseraft', 'project.json');
const SC004_MANIFEST = path.join(PROJECTS_DIR, 'sc004-project.json');
const SC004_LEGACY_SENTINEL = path.join(SC004_ROOT, '.tesseraft', 'projects', 'legacy-default.json');
const SC005_OLD_ROOT = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc005-old-root');
const SC005_NEW_ROOT = path.join(process.cwd(), '.agent-runs', 'proj-scope-sc005-new-root');
const SC005_NEW_DESCRIPTOR = path.join(SC005_NEW_ROOT, '.tesseraft', 'project.json');
const SC005_MANIFEST = path.join(PROJECTS_DIR, 'sc005-project.json');

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
  fs.rmSync(SC004_MANIFEST, { force: true });
  fs.rmSync(SC005_MANIFEST, { force: true });
  fs.rmSync(SC004_ROOT, { recursive: true, force: true });
  fs.rmSync(SC005_OLD_ROOT, { recursive: true, force: true });
  fs.rmSync(SC005_NEW_ROOT, { recursive: true, force: true });
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

  const server = createServer();
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
  assert.equal(fs.existsSync(SC004_MANIFEST), false, 'SC-004 unregister should remove only user-local registration state');
  assert.equal(fs.readFileSync(SC004_DESCRIPTOR, 'utf8'), descriptorBefore, 'SC-004 unregister must leave the descriptor unchanged');
  assert.equal(fs.readFileSync(SC004_LEGACY_SENTINEL, 'utf8'), legacyBefore, 'SC-004 unregister must leave legacy project files unchanged');
  assert.equal(fs.existsSync(path.join(SC004_ROOT, 'runs', 'existing-run-data')), dataBefore, 'SC-004 unregister must leave project data unchanged');
});

test('SC-005 reports stale registrations and accepts explicit re-registration at the new root', async (t) => {
  cleanup();
  t.after(() => cleanup());

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

  const server = createServer();
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
