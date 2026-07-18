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
  fs.rmSync(ALPHA_WS, { recursive: true, force: true });
  fs.rmSync(BETA_WS, { recursive: true, force: true });
};

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
