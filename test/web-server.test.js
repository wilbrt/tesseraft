import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createServer, parseArgs, routeApi } from '../web/dist-server/server.js';
import { createConfiguredPiSessionAdapter, createFakePiSessionAdapter, derivePiChatMessages, PiSettingsResolutionError } from '../web/dist-server/lib/piSessionAdapter.js';

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

const removeRunUnder = (runsRoot, runId) => {
  fs.rmSync(path.join(process.cwd(), runsRoot, runId), { recursive: true, force: true });
};

const waitForRunStatus = async (base, runId, status, attempts = 50) => {
  for (let i = 0; i < attempts; i += 1) {
    const response = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    if (body.run.status === status) return body.run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Run ${runId} did not reach status ${status}`);
};

const readStreamUntil = async (stream, pattern, attempts = 5) => {
  const reader = stream.getReader();
  let text = '';
  try {
    for (let i = 0; i < attempts && !pattern.test(text); i += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  return text;
};

test('parseArgs accepts port zero for tests', () => {
  assert.deepEqual(parseArgs(['--port', '0']), { host: '127.0.0.1', port: 0 });
});

test('built web wrapper starts and serves HTTP', async () => {
  const child = spawn(process.execPath, ['web/server.js', '--host', '127.0.0.1', '--port', '0'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    const url = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`web wrapper did not start: ${stderr}`)), 5000);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`web wrapper exited with ${code}: ${stderr}`));
      });
      child.stdout.on('data', (chunk) => {
        const text = String(chunk);
        const match = text.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://127.0.0.1:${match[1]}`);
        }
      });
    });

    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Tesseraft Local Web UI/);
  } finally {
    child.kill('SIGTERM');
  }
});

test('routeApi maps supported API routes to control-plane commands', () => {
  assert.deepEqual(routeApi('/api/workflows'), ['workflows']);
  assert.deepEqual(routeApi('/api/workflows/smoke-demo/graph'), ['graph', 'smoke-demo']);
  assert.deepEqual(routeApi('/api/runs/smoke-test/events'), ['events', 'smoke-test']);
  assert.deepEqual(routeApi('/api/runs/smoke-test/artifacts'), ['artifacts', 'smoke-test']);
  assert.deepEqual(routeApi('/api/runs/smoke-test/artifact', new URLSearchParams('path=logs%2Fstart.log')), ['artifact', 'smoke-test', 'logs/start.log']);
  assert.deepEqual(routeApi('/api/git-user'), ['git-user']);
  assert.deepEqual(routeApi('/api/settings'), ['settings']);
  assert.deepEqual(routeApi('/api/unknown'), { notFound: true });
});

test('control-plane discovers project and global Tesseraft workflows', () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.agent-runs', 'workflow-discovery-project-'));
  const home = fs.mkdtempSync(path.join(process.cwd(), '.agent-runs', 'workflow-discovery-home-'));
  const workflowEdn = (name, title) => [
    '{:api-version "tesseraft.workflow/v1"',
    ' :kind :workflow',
    ` :metadata {:name "${name}" :title "${title}"}`,
    ' :initial :done',
    ' :states {:done {:type :terminal}}}'
  ].join('\n');

  try {
    fs.mkdirSync(path.join(root, '.tesseraft', 'workflows', 'shared'), { recursive: true });
    fs.mkdirSync(path.join(home, 'workflows', 'shared'), { recursive: true });
    fs.mkdirSync(path.join(home, 'workflows', 'global-only'), { recursive: true });
    fs.writeFileSync(path.join(root, '.tesseraft', 'workflows', 'shared', 'workflow.edn'), workflowEdn('shared-demo', 'Project Shared'));
    fs.writeFileSync(path.join(home, 'workflows', 'shared', 'workflow.edn'), workflowEdn('shared-demo', 'Global Shared'));
    fs.writeFileSync(path.join(home, 'workflows', 'global-only', 'workflow.edn'), workflowEdn('global-demo', 'Global Only'));

    const workflows = JSON.parse(execFileSync('./bin/tesseraft', ['control-plane', '--workspace-root', root, '--tesseraft-home', home, 'workflows'], { encoding: 'utf8' }));
    const shared = workflows.workflows.find((workflow) => workflow.name === 'shared-demo');
    const globalOnly = workflows.workflows.find((workflow) => workflow.name === 'global-demo');
    assert.equal(shared.source, 'project');
    assert.equal(shared.path, path.join('.tesseraft', 'workflows', 'shared', 'workflow.edn'));
    assert.equal(globalOnly.source, 'global');
    assert.equal(globalOnly.path, path.join(home, 'workflows', 'global-only', 'workflow.edn'));
    assert.equal(workflows.workflows.filter((workflow) => workflow.name === 'shared-demo').length, 1);

    const detail = JSON.parse(execFileSync('./bin/tesseraft', ['control-plane', '--workspace-root', root, '--tesseraft-home', home, 'workflow', 'shared-demo'], { encoding: 'utf8' }));
    assert.equal(detail.workflow.source, 'project');
    assert.equal(detail.workflow.normalized.metadata.title, 'Project Shared');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
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

  const reviewLoopResponse = await fetch(`${base}/api/workflows/review-loop`);
  assert.equal(reviewLoopResponse.status, 200);
  const reviewLoopDetail = await reviewLoopResponse.json();
  const executeState = reviewLoopDetail.workflow.normalized.states.execute;
  assert.equal(executeState.resources.requires[0].kind, 'worktree');
  assert.equal(executeState.transitions[0].next, 'start-test-server');
  assert.ok(executeState.resources.produces.some((resource) => resource.name === 'execution-status'));
  const designState = reviewLoopDetail.workflow.normalized.states.design;
  assert.equal(designState.outputs['manual-testing-spec'].path, 'manual-testing/spec.md');
  assert.ok(designState.resources.produces.some((resource) => resource.kind === 'manual-testing-spec'));
  const startServerState = reviewLoopDetail.workflow.normalized.states['start-test-server'];
  assert.equal(startServerState.handler, 'start-test-server');
  assert.ok(startServerState.resources.produces.some((resource) => resource.kind === 'web-service'));
  const manualTestingState = reviewLoopDetail.workflow.normalized.states['manual-testing'];
  assert.ok(manualTestingState.resources.requires.some((resource) => resource.kind === 'manual-testing-spec'));
  assert.ok(manualTestingState.resources.consumes.some((resource) => resource.kind === 'web-service'));

  const graphResponse = await fetch(`${base}/api/workflows/smoke-demo/graph`);
  assert.equal(graphResponse.status, 200);
  const graph = await graphResponse.json();
  assert.equal(graph.workflow_name, 'smoke-demo');
  assert.ok(graph.nodes.some((node) => node.id === 'start'));
  assert.ok(graph.edges.some((edge) => edge.from === 'start' && edge.to === 'done'));

  const reviewLoopGraphResponse = await fetch(`${base}/api/workflows/review-loop/graph`);
  assert.equal(reviewLoopGraphResponse.status, 200);
  const reviewLoopGraph = await reviewLoopGraphResponse.json();
  const executeNode = reviewLoopGraph.nodes.find((node) => node.id === 'execute');
  assert.ok(executeNode, 'expected review-loop execute graph node');
  assert.equal(executeNode.resources.requires[0].kind, 'worktree');
  assert.ok(executeNode.resources.produces.some((resource) => resource.name === 'execution-status'));
  assert.ok(reviewLoopGraph.edges.some((edge) => edge.from === 'execute' && edge.to === 'start-test-server'));
  assert.ok(reviewLoopGraph.edges.some((edge) => edge.from === 'start-test-server' && edge.to === 'manual-testing'));

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

  const streamResponse = await fetch(`${base}/api/runs/web-server-test/stream`);
  assert.equal(streamResponse.status, 200);
  assert.match(streamResponse.headers.get('content-type') || '', /text\/event-stream/);
  const streamText = await streamResponse.text();
  assert.match(streamText, /event: snapshot/);

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

test('configured Pi session adapter uses real SDK by default and fake only by explicit opt-in', async () => {
  const adapterSource = fs.readFileSync('web/dist-server/lib/piSessionAdapter.js', 'utf8');
  assert.match(adapterSource, /TESSERAFT_PI_ADAPTER === 'fake' \? createFakePiSessionAdapter\(\) : createRealPiSessionAdapter\(\)/);
  assert.doesNotMatch(adapterSource, /typeof sessionManagerFactory !== "object"|typeof sessionManagerFactory !== 'object'/);
  assert.match(adapterSource, /\.inMemory !== 'function'|\.inMemory !== "function"/);

  const fakeAdapter = createConfiguredPiSessionAdapter({ TESSERAFT_PI_ADAPTER: 'fake' });
  await fakeAdapter.createSession({ id: 'configured-fake' });
  const sent = await fakeAdapter.sendPrompt('configured-fake', 'hello pi');
  assert.ok(sent);
  assert.match(sent.events[1].text, /Fake Pi adapter response/);
  assert.deepEqual(sent.messages.map((message) => message.role), ['system', 'user', 'assistant']);
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
  assert.deepEqual(sent.messages.map((message) => message.role), ['system', 'user', 'assistant']);
  assert.deepEqual((await adapter.listMessages('unit-pi', 1))?.map((message) => message.role), ['user', 'assistant']);

  const filtered = await adapter.listEvents('unit-pi', 1);
  assert.equal(filtered.length, 2);
  assert.deepEqual(filtered.map((event) => event.sequence), [2, 3]);
  assert.equal(await adapter.getSession('missing'), null);
});

test('Pi chat message derivation coalesces assistant deltas', () => {
  const messages = derivePiChatMessages([
    { id: 'e1', session_id: 's1', sequence: 1, created_at: '2026-01-01T00:00:00.000Z', event: 'prompt.sent', role: 'user', text: 'Hello' },
    { id: 'e2', session_id: 's1', sequence: 2, created_at: '2026-01-01T00:00:01.000Z', event: 'sdk.event', role: 'assistant', text: 'Hel' },
    { id: 'e3', session_id: 's1', sequence: 3, created_at: '2026-01-01T00:00:02.000Z', event: 'sdk.event', role: 'assistant', text: 'lo' }
  ]);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].text, 'Hello');
});

test('Pi chat message derivation includes real SDK assistant text deltas without explicit role', () => {
  const messages = derivePiChatMessages([
    { id: 'e1', session_id: 's1', sequence: 1, created_at: '2026-01-01T00:00:00.000Z', event: 'prompt.sent', role: 'user', text: 'Hello' },
    { id: 'e2', session_id: 's1', sequence: 2, created_at: '2026-01-01T00:00:01.000Z', event: 'message_update', text: 'Hel', data: { sdk_event: { type: 'message_update', assistantMessageEvent: { delta: 'Hel' } } } },
    { id: 'e3', session_id: 's1', sequence: 3, created_at: '2026-01-01T00:00:02.000Z', event: 'message_update', text: 'lo', data: { sdk_event: { type: 'message_update', assistantMessageEvent: { delta: 'lo' } } } }
  ]);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].text, 'Hello');
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
  assert.equal(detail.session.messages[0].role, 'system');

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
  assert.deepEqual(prompted.messages.map((message) => message.role), ['system', 'user', 'assistant']);

  const streamResponse = await fetch(`${base}/api/pi-sessions/api-pi/stream`);
  assert.equal(streamResponse.status, 200);
  assert.match(streamResponse.headers.get('content-type') || '', /text\/event-stream/);
  const streamText = await readStreamUntil(streamResponse.body, /event: snapshot/);
  assert.match(streamText, /event: snapshot/);
  const snapshotJson = streamText.match(/data: (.*)/)?.[1];
  assert.ok(snapshotJson, 'expected Pi session stream snapshot data');
  const snapshot = JSON.parse(snapshotJson);
  assert.deepEqual(snapshot.messages.map((message) => message.role), ['system', 'user', 'assistant']);
  assert.equal(snapshot.messages.filter((message) => message.role === 'assistant').length, 1);

  const eventsResponse = await fetch(`${base}/api/pi-sessions/api-pi/events?after=1`);
  assert.equal(eventsResponse.status, 200);
  const events = await eventsResponse.json();
  assert.equal(events.session_id, 'api-pi');
  assert.deepEqual(events.events.map((event) => event.sequence), [2, 3]);

  const missingResponse = await fetch(`${base}/api/pi-sessions/missing/events`);
  assert.equal(missingResponse.status, 404);
  assert.equal((await missingResponse.json()).error.code, 'not_found');
});

test('web server supports local smoke start-and-run, step, and resume mutations', async (t) => {
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
  assert.equal(startResponse.status, 202);
  const started = await startResponse.json();
  assert.equal(started.operation, 'start');
  assert.equal(started.status, 'running');
  assert.equal(started.code, 'background_started');
  assert.equal(started.run_id, runId);

  const completedRun = await waitForRunStatus(base, runId, 'done');
  assert.equal(completedRun.state, 'done');

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
  assert.equal(stepped.latest_runtime.run.status, 'done');
  assert.equal(stepped.latest_runtime.run.state, 'done');

  const resumeResponse = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ max_steps: 1 })
  });
  assert.equal(resumeResponse.status, 202);
  const resumed = await resumeResponse.json();
  assert.equal(resumed.operation, 'resume');
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.code, 'background_started');

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

test('control-plane delete-run removes done runs and refuses executing runs', async (t) => {
  const runsRoot = path.join('.agent-runs', `delete-fixtures-${Date.now()}`);
  const doneRunDir = path.join(process.cwd(), runsRoot, 'wf', 'done-run');
  const executingRunDir = path.join(process.cwd(), runsRoot, 'wf', 'executing-run');
  t.after(() => fs.rmSync(path.join(process.cwd(), runsRoot), { recursive: true, force: true }));

  fs.mkdirSync(doneRunDir, { recursive: true });
  fs.writeFileSync(path.join(doneRunDir, 'state.edn'), '{:workflow {:name "wf" :version "v1"} :run {:id "done-run" :status "done" :state :done}}');
  fs.writeFileSync(path.join(doneRunDir, 'events.jsonl'), '');

  fs.mkdirSync(executingRunDir, { recursive: true });
  fs.writeFileSync(path.join(executingRunDir, 'state.edn'), '{:workflow {:name "wf" :version "v1"} :run {:id "executing-run" :status "running" :state :work :updated-at "2999-01-01T00:00:00Z"}}');
  fs.writeFileSync(path.join(executingRunDir, 'events.jsonl'), JSON.stringify({ event: 'node.started', state: 'work', attempt: 1, at: '2999-01-01T00:00:00Z' }));

  const doneDelete = JSON.parse(execFileSync('./bin/tesseraft', ['control-plane', '--workspace-root', process.cwd(), '--runs-root', runsRoot, 'delete-run', 'done-run'], { encoding: 'utf8' }));
  assert.equal(doneDelete.status, 200);
  assert.equal(doneDelete.deleted, true);
  assert.equal(doneDelete.run_id, 'done-run');
  assert.equal(fs.existsSync(doneRunDir), false);

  let conflictStatus = 0;
  let conflictBody;
  try {
    execFileSync('./bin/tesseraft', ['control-plane', '--workspace-root', process.cwd(), '--runs-root', runsRoot, 'delete-run', 'executing-run'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    conflictStatus = error.status ?? null;
    conflictBody = JSON.parse(error.stdout);
  }
  assert.ok(conflictStatus === 1, `expected nonzero exit for executing delete, got ${conflictStatus}`);
  assert.equal(conflictBody.error.code, 'conflict');
  assert.equal(conflictBody.error.details.liveness, 'executing');
  assert.equal(fs.existsSync(executingRunDir), true);

  let missingStatus = 0;
  let missingBody;
  try {
    execFileSync('./bin/tesseraft', ['control-plane', '--workspace-root', process.cwd(), '--runs-root', runsRoot, 'delete-run', 'no-such-run'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    missingStatus = error.status ?? null;
    missingBody = JSON.parse(error.stdout);
  }
  assert.ok(missingStatus === 1, `expected nonzero exit for missing delete, got ${missingStatus}`);
  assert.equal(missingBody.status, 404);
  assert.equal(missingBody.error.code, 'not_found');
});

test('web server deletes done runs via DELETE /api/runs/:runId and refuses executing runs', async (t) => {
  const runsRoot = path.join('.agent-runs', `delete-web-${Date.now()}`);
  t.after(() => fs.rmSync(path.join(process.cwd(), runsRoot), { recursive: true, force: true }));

  const make = (runId, status, state, events) => {
    const dir = path.join(process.cwd(), runsRoot, 'wf', runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.edn'), `{:workflow {:name "wf" :version "v1"} :run {:id "${runId}" :status "${status}" :state ${state}${status === 'running' ? ' :updated-at "2999-01-01T00:00:00Z"' : ''}}}`);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), events || '');
    return dir;
  };
  const doneDir = make('web-delete-done', 'done', ':done');
  const executingDir = make('web-delete-exec', 'running', ':work', JSON.stringify({ event: 'node.started', state: 'work', attempt: 1, at: '2999-01-01T00:00:00Z' }));

  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const doneResponse = await fetch(`${base}/api/runs/web-delete-done`, { method: 'DELETE' });
  assert.equal(doneResponse.status, 200);
  const doneBody = await doneResponse.json();
  assert.equal(doneBody.operation, 'delete');
  assert.equal(doneBody.status, 'ok');
  assert.equal(doneBody.run_id, 'web-delete-done');
  assert.equal(doneBody.deleted, true);
  assert.equal(fs.existsSync(doneDir), false);

  const executingResponse = await fetch(`${base}/api/runs/web-delete-exec`, { method: 'DELETE' });
  assert.equal(executingResponse.status, 409);
  const executingBody = await executingResponse.json();
  assert.equal(executingBody.error.code, 'conflict');
  assert.equal(executingBody.error.details.liveness, 'executing');
  assert.equal(fs.existsSync(executingDir), true);
});

test('GET /api/browse lists repo-rooted directory entries and rejects path escapes', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const root = await fetch(`${base}/api/browse?path=.`);
  assert.equal(root.status, 200);
  const rootBody = await root.json();
  assert.ok(Array.isArray(rootBody.entries));
  assert.ok(rootBody.entries.some((entry) => entry.name === 'web' && entry.is_dir === true));
  assert.ok(rootBody.entries.some((entry) => entry.name === 'package.json' && entry.is_file === true));
  // Hidden files are omitted.
  assert.ok(!rootBody.entries.some((entry) => entry.name === '.git'));

  const sub = await fetch(`${base}/api/browse?path=web`);
  assert.equal(sub.status, 200);
  const subBody = await sub.json();
  assert.ok(subBody.is_dir === true);
  assert.ok(subBody.entries.some((entry) => entry.name === 'src' && entry.is_dir === true));

  const escape = await fetch(`${base}/api/browse?path=${encodeURIComponent('../')}`);
  assert.equal(escape.status, 400);
  const escapeBody = await escape.json();
  assert.equal(escapeBody.error.code, 'bad_request');

  const missing = await fetch(`${base}/api/browse?path=does-not-exist-xyz`);
  assert.equal(missing.status, 404);
});

test('routeApi maps the browse route', () => {
  assert.deepEqual(routeApi('/api/browse'), ['browse']);
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

test('web server exposes git-user read and write via the control plane', async (t) => {
  const configFile = path.join(process.cwd(), '.tesseraft', 'git-user.json');
  fs.rmSync(configFile, { force: true });
  t.after(() => fs.rmSync(configFile, { force: true }));

  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const initial = await fetch(`${base}/api/git-user`);
  assert.equal(initial.status, 200);
  const initialBody = await initial.json();
  assert.equal(initialBody.git_user.source, 'none');
  assert.equal(initialBody.git_user.name, null);

  const badWrite = await fetch(`${base}/api/git-user`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Bot', email: 'not-an-email' })
  });
  assert.equal(badWrite.status, 400);
  assert.equal((await badWrite.json()).error.code, 'bad_request');
  assert.equal(fs.existsSync(configFile), false);

  const write = await fetch(`${base}/api/git-user`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Tess Bot', email: 'tess@example.com' })
  });
  assert.equal(write.status, 200);
  const written = await write.json();
  assert.equal(written.git_user.name, 'Tess Bot');
  assert.equal(written.git_user.email, 'tess@example.com');
  assert.equal(written.git_user.source, 'project');

  const stored = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(stored.name, 'Tess Bot');
  assert.equal(stored.email, 'tess@example.com');

  const refreshed = await fetch(`${base}/api/git-user`);
  assert.equal(refreshed.status, 200);
  const refreshedBody = await refreshed.json();
  assert.equal(refreshedBody.git_user.source, 'project');
  assert.equal(refreshedBody.git_user.name, 'Tess Bot');
});

test('web server exposes settings read and write via the control plane with masked tokens', async (t) => {
  const configFile = path.join(process.cwd(), '.tesseraft', 'settings.json');
  fs.rmSync(configFile, { force: true });
  t.after(() => fs.rmSync(configFile, { force: true }));

  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const initial = await fetch(`${base}/api/settings`);
  assert.equal(initial.status, 200);
  const initialBody = await initial.json();
  assert.equal(initialBody.settings.source, 'none');
  assert.equal(initialBody.settings.pi_default_provider, null);
  assert.equal(initialBody.settings.github_token.present, false);
  assert.equal(initialBody.settings.jira_token.present, false);

  const badWrite = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pi_default_provider: `a${'\n'}b` })
  });
  assert.equal(badWrite.status, 400);
  assert.equal((await badWrite.json()).error.code, 'bad_request');
  assert.equal(fs.existsSync(configFile), false);

  const write = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pi_default_provider: 'openai',
      pi_default_model: 'gpt-4o-mini',
      github_token: 'ghp_secretvalue1234',
      jira_token: 'jira-token-abcd',
      default_repo_root: '/tmp/my-repo'
    })
  });
  assert.equal(write.status, 200);
  const written = await write.json();
  assert.equal(written.settings.source, 'project');
  assert.equal(written.settings.pi_default_provider, 'openai');
  assert.equal(written.settings.pi_default_model, 'gpt-4o-mini');
  assert.equal(written.settings.default_repo_root, '/tmp/my-repo');
  // Tokens must be masked — only present + last 4 preview, never full value.
  assert.equal(written.settings.github_token.present, true);
  assert.equal(written.settings.github_token.preview, '1234');
  assert.equal(written.settings.jira_token.present, true);
  assert.equal(written.settings.jira_token.preview, 'abcd');

  const stored = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(stored.github_token, 'ghp_secretvalue1234');
  assert.equal(stored.jira_token, 'jira-token-abcd');

  // The masked GET round-trips: sending the sentinel preserves the token.
  const unchanged = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pi_default_provider: 'anthropic', github_token: null })
  });
  assert.equal(unchanged.status, 200);
  const unchangedBody = await unchanged.json();
  assert.equal(unchangedBody.settings.pi_default_provider, 'anthropic');
  assert.equal(unchangedBody.settings.github_token.present, true);
  assert.equal(unchangedBody.settings.github_token.preview, '1234');
  // And the stored value is unchanged.
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).github_token, 'ghp_secretvalue1234');

  // Clearing the provider while a model is still set is an inconsistent
  // state and must be rejected (cross-field validation).
  const inconsistent = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pi_default_provider: null })
  });
  assert.equal(inconsistent.status, 400);
  assert.equal((await inconsistent.json()).error.code, 'bad_request');
  // The stored file is unchanged: provider still 'anthropic'.
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).pi_default_provider, 'anthropic');

  // Clearing both provider and model removes them and is allowed.
  const cleared = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pi_default_provider: null, pi_default_model: null })
  });
  assert.equal(cleared.status, 200);
  const clearedBody = await cleared.json();
  assert.equal(clearedBody.settings.pi_default_provider, null);
  assert.equal(clearedBody.settings.pi_default_model, null);

  // Setting a model without a provider is also rejected.
  const modelOnly = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pi_default_model: 'gpt-4o-mini' })
  });
  assert.equal(modelOnly.status, 400);
  assert.equal((await modelOnly.json()).error.code, 'bad_request');
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

test('POST /api/pi-sessions surfaces pi_settings_resolution failures as 400 {error:{code,message}}', async (t) => {
  const errAdapter = {
    createSession: async () => { throw new PiSettingsResolutionError('acme', 'nope', 'no catalog entry for provider "acme" model "nope"'); },
    listSessions: async () => [],
    getSession: async () => null,
    sendPrompt: async () => null,
    listMessages: async () => [],
    listEvents: async () => [],
    streamEvents: async () => {}
  };
  const server = createServer({ piSessionAdapter: errAdapter });
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  const res = await fetch(`${base}/api/pi-sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.status, 400);
  assert.equal(body.error.code, 'pi_settings_resolution');
  assert.match(body.error.message, /acme/);
  assert.match(body.error.message, /nope/);
  assert.match(body.error.message, /pi auth/);
  assert.equal(typeof body.error.message, 'string');
  assert.ok(body.error.message.length > 0, 'actionable message text is exposed for the UI to render');
});
