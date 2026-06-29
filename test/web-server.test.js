import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createServer, parseArgs, routeApi } from '../web/dist-server/server.js';

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
