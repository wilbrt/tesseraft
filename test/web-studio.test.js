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

test('GET /api/studio/workflows/:name falls back to bundled example workflows', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  // Example workflows ship under examples/<name>/ and are not copied into
  // .tesseraft/workflows/ in a fresh workspace. The Studio must still load
  // them so the composer can target example agent nodes (read-only view).
  const res = await fetch(`${base}/api/studio/workflows/smoke`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.workflow.name, 'smoke');
  assert.match(body.workflow.edn, /:workflow/);
  assert.match(body.workflow.path, /examples\/smoke\/workflow\.edn$/);
});

test('GET /api/studio/workflows/:name/assets/* 404s for a missing asset', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  await fetch(`${base}/api/studio/workflows`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'wf-asset' })
  });
  const res = await fetch(`${base}/api/studio/workflows/wf-asset/assets/prompts/missing.md.tmpl`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, 'not_found');
});

test('PUT /api/studio/workflows/:name/assets/* rejects unsafe paths with 400', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  await fetch(`${base}/api/studio/workflows`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'wf-asset-safe' })
  });

  // Path traversal via encoded `..` reaches the handler (literal `../` is
  // normalized away by the URL client before routing) and must be rejected.
  const escape1 = await fetch(`${base}/api/studio/workflows/wf-asset-safe/assets/prompts/%2e%2e%2fescape.md.tmpl`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'bad' })
  });
  assert.equal(escape1.status, 400);

  // Disallowed extension must be rejected.
  const badext = await fetch(`${base}/api/studio/workflows/wf-asset-safe/assets/prompts/x.exe`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'bad' })
  });
  assert.equal(badext.status, 400);

  // Non-string content must be rejected.
  const badcontent = await fetch(`${base}/api/studio/workflows/wf-asset-safe/assets/prompts/x.md.tmpl`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 123 })
  });
  assert.equal(badcontent.status, 400);

  // Nothing should have been written outside the package dir.
  assert.ok(!fs.existsSync(path.join(workflowsRoot, 'escape.md.tmpl')));
});

test('PUT then GET round-trips a prompt template asset under the package dir', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  await fetch(`${base}/api/studio/workflows`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'wf-asset-rt' })
  });
  const content = 'Draft a prompt for {{node.id}} using {{inputs.x}}.\\n';
  const put = await fetch(`${base}/api/studio/workflows/wf-asset-rt/assets/prompts/generated/my-node.md.tmpl`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content })
  });
  assert.equal(put.status, 200);
  const putBody = await put.json();
  assert.equal(putBody.ok, true);
  assert.equal(putBody.path, 'prompts/generated/my-node.md.tmpl');
  // Confined to the workflow package dir.
  const file = path.join(workflowsRoot, 'wf-asset-rt', 'prompts', 'generated', 'my-node.md.tmpl');
  assert.ok(fs.existsSync(file));
  assert.equal(fs.readFileSync(file, 'utf8'), content);

  const get = await fetch(`${base}/api/studio/workflows/wf-asset-rt/assets/prompts/generated/my-node.md.tmpl`);
  assert.equal(get.status, 200);
  const getBody = await get.json();
  assert.equal(getBody.workflow, 'wf-asset-rt');
  assert.equal(getBody.path, 'prompts/generated/my-node.md.tmpl');
  assert.equal(getBody.content, content);
});