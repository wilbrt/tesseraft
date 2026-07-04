// Workflow Studio server route tests (ESM).
//
// Writes go to WORKSPACE_ROOT (.tesseraft/workflows), redirected to a temp
// directory via TESSERAFT_WORKSPACE_ROOT. WORKSPACE_ROOT is read at
// module-load time of lib/paths.js (transitively by the server), so the env
// var must be set BEFORE the server module is imported. We do that by setting
// it at the top of this module and then dynamically importing the built server.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-studio-'));
process.env.TESSERAFT_WORKSPACE_ROOT = workspace;

const { createServer } = await import('../web/dist-server/server.js');

const workflowsRoot = path.join(workspace, '.tesseraft', 'workflows');

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

test('POST /api/studio/workflows creates a draft workflow.edn and sidecar', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const res = await fetch(`${base}/api/studio/workflows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'wf-create', description: 'create test' })
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.workflow.name, 'wf-create');
  const file = path.join(workflowsRoot, 'wf-create', 'workflow.edn');
  assert.ok(fs.existsSync(file));
  const edn = fs.readFileSync(file, 'utf8');
  assert.match(edn, /:name "wf-create"/);
  assert.match(edn, /:description "create test"/);
  const sidecar = JSON.parse(fs.readFileSync(path.join(workflowsRoot, 'wf-create', 'studio-state.json'), 'utf8'));
  assert.equal(sidecar.status, 'draft');
  assert.ok(sidecar.draft);
});

test('POST /api/studio/workflows rejects invalid names and refuses collisions', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const bad = await fetch(`${base}/api/studio/workflows`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Bad_Name!' })
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'bad_request');

  const dup = await fetch(`${base}/api/studio/workflows`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'wf-create' })
  });
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).error.code, 'conflict');
});

test('GET /api/studio/workflows/:name returns edn and stored sidecar state', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  await fetch(`${base}/api/studio/workflows`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'wf-get' })
  });
  const res = await fetch(`${base}/api/studio/workflows/wf-get`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.workflow.name, 'wf-get');
  assert.match(body.workflow.edn, /:name "wf-get"/);
  assert.ok(body.state.draft);

  const missing = await fetch(`${base}/api/studio/workflows/no-such-wf`);
  assert.equal(missing.status, 404);
});

test('PUT save_mode=draft persists a JSON draft and returns non-blocking lint', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const draft = {
    'api-version': 'tesseraft.workflow/v1',
    kind: ':workflow',
    metadata: { name: 'wf-draft' },
    initial: 'start',
    states: { start: { id: 'start', type: ':terminal', title: 'Start', status: ':success' } }
  };
  const res = await fetch(`${base}/api/studio/workflows/wf-draft`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ draft, positions: { start: { x: 10, y: 20 } }, save_mode: 'draft' })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.save_mode, 'draft');
  const edn = fs.readFileSync(path.join(workflowsRoot, 'wf-draft', 'workflow.edn'), 'utf8');
  assert.match(edn, /:terminal/);
  const sidecar = JSON.parse(fs.readFileSync(path.join(workflowsRoot, 'wf-draft', 'studio-state.json'), 'utf8'));
  assert.deepEqual(sidecar.positions, { start: { x: 10, y: 20 } });
});

test('PUT save_mode=completed lints first and rejects an invalid workflow with 422', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  await fetch(`${base}/api/studio/workflows`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'wf-completed' })
  });
  const draft = {
    'api-version': 'tesseraft.workflow/v1',
    kind: ':workflow',
    metadata: { name: 'wf-completed' },
    initial: null,
    states: {}
  };
  const res = await fetch(`${base}/api/studio/workflows/wf-completed`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ draft, save_mode: 'completed' })
  });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.save_mode, 'completed');
  assert.ok(body.lint.ok === false);
  assert.ok(body.lint.errors.length > 0);
});

test('PUT save_mode=completed persists a valid workflow and marks completed', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  await fetch(`${base}/api/studio/workflows`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'wf-valid' })
  });
  const draft = {
    'api-version': 'tesseraft.workflow/v1',
    kind: ':workflow',
    metadata: { name: 'wf-valid' },
    initial: 'start',
    states: { start: { id: 'start', type: ':terminal', title: 'Start', status: ':success' } }
  };
  const res = await fetch(`${base}/api/studio/workflows/wf-valid`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ draft, save_mode: 'completed' })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.save_mode, 'completed');
  assert.ok(body.lint.ok === true);
  const sidecar = JSON.parse(fs.readFileSync(path.join(workflowsRoot, 'wf-valid', 'studio-state.json'), 'utf8'));
  assert.equal(sidecar.status, 'completed');
});

test('POST /api/studio/workflows/:name/lint returns the linter report', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  await fetch(`${base}/api/studio/workflows`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'wf-lint' })
  });
  const res = await fetch(`${base}/api/studio/workflows/wf-lint/lint`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(typeof body.ok === 'boolean');
});