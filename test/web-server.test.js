'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createServer, parseArgs, routeApi } = require('../web/server');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function removeRun(runId) {
  fs.rmSync(path.join(process.cwd(), '.agent-runs', 'smoke-demo', runId), { recursive: true, force: true });
}

test('parseArgs accepts port zero for tests', () => {
  assert.deepEqual(parseArgs(['--port', '0']), { host: '127.0.0.1', port: 0 });
});

test('routeApi maps supported API routes to control-plane commands', () => {
  assert.deepEqual(routeApi('/api/workflows'), ['workflows']);
  assert.deepEqual(routeApi('/api/workflows/smoke-demo/graph'), ['graph', 'smoke-demo']);
  assert.deepEqual(routeApi('/api/runs/smoke-test/events'), ['events', 'smoke-test']);
  assert.deepEqual(routeApi('/api/unknown'), { notFound: true });
});

test('web server serves static index and JSON API routes', async (t) => {
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
  assert.match(await index.text(), /Tesseraft Local Web UI/);

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
