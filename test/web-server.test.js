import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createServer, parseArgs, routeApi } from '../web/dist-server/server.js';
import { createFakePiSessionAdapter } from '../web/dist-server/lib/piSessionAdapter.js';

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

const removeRun = (runId) => {
  fs.rmSync(path.join(process.cwd(), '.agent-runs', 'smoke-demo', runId), { recursive: true, force: true });
};

test('parseArgs accepts port zero for tests', () => {
  assert.deepEqual(parseArgs(['--port', '0']), { host: '127.0.0.1', port: 0 });
});

test('routeApi maps supported API routes to control-plane commands', () => {
  assert.deepEqual(routeApi('/api/workflows'), ['workflows']);
  assert.deepEqual(routeApi('/api/workflows/smoke-demo/graph'), ['graph', 'smoke-demo']);
  assert.deepEqual(routeApi('/api/runs/smoke-test/events'), ['events', 'smoke-test']);
  assert.deepEqual(routeApi('/api/runs/smoke-test/artifacts'), ['artifacts', 'smoke-test']);
  assert.deepEqual(routeApi('/api/runs/smoke-test/artifact', new URLSearchParams('path=logs%2Fstart.log')), ['artifact', 'smoke-test', 'logs/start.log']);
  assert.deepEqual(routeApi('/api/unknown'), { notFound: true });
});

test('web server serves React index/assets and JSON API routes', async (t) => {
  removeRun('web-server-test');
  t.after(() => removeRun('web-server-test'));

  execFileSync('./bin/tesseraft', ['run', 'examples/smoke/workflow.edn', '--run-id', 'web-server-test', '--format', 'json'], {
    cwd: process.cwd(),
    stdio: 'pipe'
  });

  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  const indexText = await index.text();
  assert.match(indexText, /Tesseraft Local Web UI/);
  assert.match(indexText, /type="module"/);

  const assetMatch = indexText.match(/src="([^\"]+\.js)"/);
  assert.ok(assetMatch, 'expected built React JavaScript asset');
  const asset = await fetch(`${base}${assetMatch[1]}`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type') || '', /javascript/);

  const workflowsResponse = await fetch(`${base}/api/workflows`);
  assert.equal(workflowsResponse.status, 200);
  const workflows = await workflowsResponse.json();
  assert.ok(workflows.workflows.some((workflow) => workflow.name === 'smoke-demo'));

  const graphResponse = await fetch(`${base}/api/workflows/smoke-demo/graph`);
  assert.equal(graphResponse.status, 200);
  const graph = await graphResponse.json();
  assert.equal(graph.workflow_name, 'smoke-demo');
  assert.ok(graph.nodes.some((node) => node.id === 'start'));
  assert.ok(graph.edges.some((edge) => edge.from === 'start' && edge.to === 'done'));

  const runsResponse = await fetch(`${base}/api/runs`);
  assert.equal(runsResponse.status, 200);
  const runs = await runsResponse.json();
  assert.ok(runs.runs.some((run) => run.run_id === 'web-server-test'));

  const runResponse = await fetch(`${base}/api/runs/web-server-test`);
  assert.equal(runResponse.status, 200);
  const run = await runResponse.json();
  assert.equal(run.run.run_id, 'web-server-test');
  assert.equal(run.run.status, 'done');

  const eventsResponse = await fetch(`${base}/api/runs/web-server-test/events`);
  assert.equal(eventsResponse.status, 200);
  const events = await eventsResponse.json();
  assert.equal(events.run_id, 'web-server-test');
  assert.ok(events.events.some((event) => event.event === 'run.finished'));

  const artifactsResponse = await fetch(`${base}/api/runs/web-server-test/artifacts`);
  assert.equal(artifactsResponse.status, 200);
  const artifacts = await artifactsResponse.json();
  assert.ok(artifacts.artifacts.some((artifact) => artifact.path === 'state.edn'));
  assert.ok(artifacts.artifacts.some((artifact) => artifact.path === 'events.jsonl'));

  const artifactResponse = await fetch(`${base}/api/runs/web-server-test/artifact?path=${encodeURIComponent('events.jsonl')}`);
  assert.equal(artifactResponse.status, 200);
  const artifact = await artifactResponse.json();
  assert.equal(artifact.artifact.path, 'events.jsonl');
  assert.equal(artifact.previewable, true);
  assert.match(artifact.content, /run.finished/);
});

test('fake Pi session adapter creates sessions, prompts, and filtered events', async () => {
  const adapter = createFakePiSessionAdapter();
  const created = await adapter.createSession({ id: 'unit-pi', title: 'Unit Pi' });
  assert.equal(created.id, 'unit-pi');
  assert.equal(created.events[0].event, 'session.created');

  const listed = await adapter.listSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].event_count, 1);

  const sent = await adapter.sendPrompt('unit-pi', 'hello pi');
  assert.ok(sent);
  assert.equal(sent.events.length, 2);
  assert.equal(sent.events[0].role, 'user');
  assert.equal(sent.events[1].role, 'assistant');
  assert.match(sent.events[1].text, /Fake Pi adapter response/);

  const filtered = await adapter.listEvents('unit-pi', 1);
  assert.equal(filtered.length, 2);
  assert.deepEqual(filtered.map((event) => event.sequence), [2, 3]);
  assert.equal(await adapter.getSession('missing'), null);
});

test('web server exposes fake Pi session routes as local JSON APIs', async (t) => {
  const server = createServer({ piSessionAdapter: createFakePiSessionAdapter() });
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const emptyList = await fetch(`${base}/api/pi-sessions`);
  assert.equal(emptyList.status, 200);
  assert.deepEqual(await emptyList.json(), { sessions: [] });

  const createdResponse = await fetch(`${base}/api/pi-sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'api-pi', title: 'API Pi' })
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.session.id, 'api-pi');
  assert.equal(created.session.title, 'API Pi');

  const listResponse = await fetch(`${base}/api/pi-sessions`);
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json();
  assert.equal(listed.sessions.length, 1);

  const detailResponse = await fetch(`${base}/api/pi-sessions/api-pi`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.session.events[0].event, 'session.created');

  const badPrompt = await fetch(`${base}/api/pi-sessions/api-pi/prompts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '' })
  });
  assert.equal(badPrompt.status, 400);
  assert.equal((await badPrompt.json()).error.code, 'bad_request');

  const promptResponse = await fetch(`${base}/api/pi-sessions/api-pi/prompts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'Summarize events' })
  });
  assert.equal(promptResponse.status, 200);
  const prompted = await promptResponse.json();
  assert.equal(prompted.events.length, 2);

  const eventsResponse = await fetch(`${base}/api/pi-sessions/api-pi/events?after=1`);
  assert.equal(eventsResponse.status, 200);
  const events = await eventsResponse.json();
  assert.equal(events.session_id, 'api-pi');
  assert.deepEqual(events.events.map((event) => event.sequence), [2, 3]);

  const missingResponse = await fetch(`${base}/api/pi-sessions/missing/events`);
  assert.equal(missingResponse.status, 404);
  assert.equal((await missingResponse.json()).error.code, 'not_found');
});

test('web server supports local smoke start, step, and resume mutations', async (t) => {
  const runId = `web-mutation-${Date.now()}`;
  removeRun(runId);
  t.after(() => removeRun(runId));

  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const startResponse = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflow_name: 'smoke-demo', run_id: runId, inputs: { ticket: 'SMOKE-1' } })
  });
  assert.equal(startResponse.status, 200);
  const started = await startResponse.json();
  assert.equal(started.operation, 'start');
  assert.equal(started.status, 'ok');
  assert.equal(started.run_id, runId);
  assert.equal(started.latest_runtime.run.status, 'running');

  const duplicateResponse = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflow_name: 'smoke-demo', run_id: runId, inputs: {} })
  });
  assert.equal(duplicateResponse.status, 409);

  const stepResponse = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/step`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(stepResponse.status, 200);
  const stepped = await stepResponse.json();
  assert.equal(stepped.operation, 'step');
  assert.equal(stepped.status, 'ok');
  assert.equal(stepped.latest_runtime.run.status, 'running');
  assert.equal(stepped.latest_runtime.run.state, 'done');

  const resumeResponse = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ max_steps: 1 })
  });
  assert.ok([200, 422].includes(resumeResponse.status));
  const resumed = await resumeResponse.json();
  assert.equal(resumed.operation, 'resume');
  assert.ok(['ok', 'guarded'].includes(resumed.status));
  if (resumeResponse.status === 422) assert.equal(resumed.code, 'max_steps_exceeded');

  const runResponse = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}`);
  assert.equal(runResponse.status, 200);
  const run = await runResponse.json();
  assert.equal(run.run.run_id, runId);
});

test('web server reports mutation validation errors as JSON', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const badJson = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json'
  });
  assert.equal(badJson.status, 400);
  const badJsonBody = await badJson.json();
  assert.equal(badJsonBody.error.code, 'bad_request');

  const badResume = await fetch(`${base}/api/runs/no-such-run/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ max_steps: 0 })
  });
  assert.ok([400, 404].includes(badResume.status));
});

test('web server reports not found and malformed API routes as JSON errors', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const missing = await fetch(`${base}/api/workflows/does-not-exist`);
  assert.equal(missing.status, 404);
  const missingBody = await missing.json();
  assert.equal(missingBody.error.code, 'not_found');

  const malformed = await fetch(`${base}/api/workflows/%E0%A4%A/graph`);
  assert.equal(malformed.status, 400);
  const malformedBody = await malformed.json();
  assert.equal(malformedBody.error.code, 'bad_request');

  const unknown = await fetch(`${base}/api/nope`);
  assert.equal(unknown.status, 404);
  const unknownBody = await unknown.json();
  assert.equal(unknownBody.error.code, 'not_found');
});

test('control-plane derived attempts do not treat exit code zero as a failure', () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.agent-runs', 'exit-zero-'));
  const runDir = path.join(root, 'wf', 'exit-zero-run');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state.edn'), '{:workflow {:name "wf" :version "v1"} :run {:id "exit-zero-run" :status "running" :state :next}}');
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), [
    JSON.stringify({ event: 'node.started', state: 'start', attempt: 1, at: '2026-01-01T00:00:00Z' }),
    JSON.stringify({ event: 'node.finished', state: 'start', at: '2026-01-01T00:00:01Z', result: { status: 'ok', 'exit-code': 0 } })
  ].join('\n'));

  try {
    const run = JSON.parse(execFileSync('./bin/tesseraft', ['control-plane', '--workspace-root', root, '--runs-root', 'wf', 'run', 'exit-zero-run'], { encoding: 'utf8' }));
    assert.equal(run.run.attempts[0].status, 'ok');
    assert.equal(run.run.attempts[0].error, undefined);
    assert.deepEqual(run.run.failures, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('control-plane artifact reads reject unsafe paths', () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.agent-runs', 'artifact-safety-'));
  const runDir = path.join(root, 'wf', 'safe-run');
  const outside = path.join(root, 'outside.txt');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state.edn'), '{:workflow {:name "wf" :version "v1"} :run {:id "safe-run" :status "done" :state :done}}');
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), '');
  fs.writeFileSync(path.join(runDir, 'note.md'), '# hello\n');
  fs.writeFileSync(outside, 'secret');
  fs.symlinkSync(outside, path.join(runDir, 'escape.txt'));

  try {
    const ok = JSON.parse(execFileSync('./bin/tesseraft', ['control-plane', '--workspace-root', root, '--runs-root', 'wf', 'artifact', 'safe-run', 'note.md'], { encoding: 'utf8' }));
    assert.equal(ok.previewable, true);
    assert.match(ok.content, /hello/);

    assert.throws(() => execFileSync('./bin/tesseraft', ['control-plane', '--workspace-root', root, '--runs-root', 'wf', 'artifact', 'safe-run', '../outside.txt'], { encoding: 'utf8', stdio: 'pipe' }));
    assert.throws(() => execFileSync('./bin/tesseraft', ['control-plane', '--workspace-root', root, '--runs-root', 'wf', 'artifact', 'safe-run', outside], { encoding: 'utf8', stdio: 'pipe' }));
    assert.throws(() => execFileSync('./bin/tesseraft', ['control-plane', '--workspace-root', root, '--runs-root', 'wf', 'artifact', 'safe-run', 'escape.txt'], { encoding: 'utf8', stdio: 'pipe' }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
