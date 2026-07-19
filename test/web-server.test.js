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

const seedConnectionsDoctorFixture = () => {
  const root = process.cwd();
  const projectsDir = path.join(root, '.tesseraft', 'projects');
  const defaultManifest = path.join(projectsDir, 'default.json');
  const explicitManifest = path.join(projectsDir, 'doctor-explicit.json');
  const fixtureWs = path.join(root, '.agent-runs', 'manual-connections-doctor-explicit-ws');
  const workflowDir = path.join(fixtureWs, '.tesseraft', 'workflows', 'manual-doctor');
  const backups = new Map();
  for (const p of [defaultManifest, explicitManifest]) {
    backups.set(p, fs.existsSync(p) ? fs.readFileSync(p) : null);
  }
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.mkdirSync(path.join(fixtureWs, 'runs'), { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.writeFileSync(path.join(workflowDir, 'workflow.edn'), `{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "manual-doctor" :title "Manual Doctor"}
 :defaults {:max-rounds 1 :state-timeout "1m"}
 :policies {:require-timeouts true :require-max-rounds true}
 :initial :start
 :states {:start {:type :deterministic
                  :handler :noop/succeed
                  :runtime {:timeout "10s"}
                  :next :done}
          :done {:type :terminal :title "Done" :status :success}}}
`);
  fs.writeFileSync(defaultManifest, JSON.stringify({
    project_id: 'default',
    name: 'Default',
    workspace_root: '.',
    runs_root: '.agent-runs',
    discovery: { 'workflow-roots': ['.tesseraft/workflows', 'examples'] },
    settings: {}
  }, null, 2));
  fs.writeFileSync(explicitManifest, JSON.stringify({
    project_id: 'doctor-explicit',
    name: 'Doctor Explicit',
    workspace_root: '.agent-runs/manual-connections-doctor-explicit-ws',
    runs_root: 'runs',
    discovery: { 'workflow-roots': ['.tesseraft/workflows'] },
    settings: { 'default-repo-root': 'missing-repo-root' },
    connections: {
      github: { 'credential-ref': 'env:DOCTOR_EXPLICIT_GITHUB_TOKEN' },
      jira: { 'base-url': 'https://doctor-explicit.invalid', 'credential-ref': 'env:DOCTOR_EXPLICIT_JIRA_TOKEN' }
    }
  }, null, 2));
  return () => {
    fs.rmSync(fixtureWs, { recursive: true, force: true });
    for (const [p, content] of backups.entries()) {
      if (content === null) fs.rmSync(p, { force: true });
      else fs.writeFileSync(p, content);
    }
  };
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

test('server subprocesses resolve default workspace under TESSERAFT_WORKSPACE_ROOT', async () => {
  fs.mkdirSync(path.join(process.cwd(), '.agent-runs'), { recursive: true });
  const workspace = fs.mkdtempSync(path.join(process.cwd(), '.agent-runs', 'server-workspace-root-'));
  const home = fs.mkdtempSync(path.join(process.cwd(), '.agent-runs', 'server-workspace-home-'));
  const workflowDir = path.join(workspace, '.tesseraft', 'workflows', 'server-isolated');
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(path.join(workflowDir, 'workflow.edn'), `{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "server-isolated" :title "Server Isolated"}
 :initial :done
 :states {:done {:type :terminal}}}
`);

  const child = spawn(process.execPath, ['web/dist-server/server.js', '--host', '127.0.0.1', '--port', '0'], {
    cwd: process.cwd(),
    env: { ...process.env, TESSERAFT_WORKSPACE_ROOT: workspace, TESSERAFT_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    const url = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`isolated server did not start: ${stderr}`)), 10000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`isolated server exited with ${code}: ${stderr}`)); });
      child.stdout.on('data', (chunk) => {
        const match = String(chunk).match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timeout); resolve(`http://127.0.0.1:${match[1]}`); }
      });
    });

    const response = await fetch(`${url}/api/workflows`);
    assert.equal(response.status, 200);
    const body = await response.json();
    const isolated = body.workflows.find((workflow) => workflow.name === 'server-isolated');
    assert.equal(isolated.source, 'project');
    assert.equal(isolated.path, path.join('.tesseraft', 'workflows', 'server-isolated', 'workflow.edn'));
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
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
  assert.deepEqual(routeApi('/api/projects'), ['projects']);
  assert.deepEqual(routeApi('/api/projects/default'), ['project', 'default']);
  assert.deepEqual(routeApi('/api/projects/acme/doctor'), ['project-doctor', 'acme']);
  assert.deepEqual(routeApi('/api/projects/acme/connections'), ['project-connections', 'acme']);
  assert.deepEqual(routeApi('/api/unknown'), { notFound: true });
});

test('control-plane discovers project and global Tesseraft workflows', () => {
  fs.mkdirSync(path.join(process.cwd(), '.agent-runs'), { recursive: true });
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

test('web server exposes seeded explicit Connections Doctor project for manual review', async (t) => {
  const cleanupFixture = seedConnectionsDoctorFixture();
  t.after(cleanupFixture);

  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const projectsResponse = await fetch(`${base}/api/projects`);
  assert.equal(projectsResponse.status, 200);
  const projects = await projectsResponse.json();
  const ids = projects.projects.map((project) => project.project_id).sort();
  assert.deepEqual(ids, ['default', 'doctor-explicit']);

  const defaultResponse = await fetch(`${base}/api/projects/default/doctor`);
  assert.equal(defaultResponse.status, 200);
  const defaultDoctor = await defaultResponse.json();
  assert.equal(defaultDoctor.project_id, 'default');

  const explicitResponse = await fetch(`${base}/api/projects/doctor-explicit/doctor`);
  assert.equal(explicitResponse.status, 200);
  const explicitDoctor = await explicitResponse.json();
  assert.equal(explicitDoctor.project_id, 'doctor-explicit');
  assert.equal(explicitDoctor.checks.find((check) => check.id === 'workflow-discovery')?.status, 'ready');
  assert.equal(explicitDoctor.checks.find((check) => check.id === 'runs-root')?.status, 'ready');
  assert.equal(explicitDoctor.checks.find((check) => check.id === 'repository-root')?.status, 'invalid');
  assert.notDeepEqual(defaultDoctor, explicitDoctor);
  assert.doesNotMatch(JSON.stringify(defaultDoctor), /manual-connections-doctor-explicit-ws/);
  assert.doesNotMatch(JSON.stringify(explicitDoctor), /SECRET_SENTINEL_VALUE|stdout|stderr|ghp_|token-preview/);

  const missingResponse = await fetch(`${base}/api/projects/doctor-missing/doctor`);
  assert.equal(missingResponse.status, 404);
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

  const doctorResponse = await fetch(`${base}/api/projects/default/doctor`);
  assert.equal(doctorResponse.status, 200);
  const doctor = await doctorResponse.json();
  assert.equal(doctor.project_id, 'default');
  assert.equal(doctor.checks.length, 10);
  assert.deepEqual(Object.keys(doctor.summary).sort(), ['invalid', 'not-configured', 'ready', 'unreachable'].sort());
  assert.ok(doctor.checks.every((check) => ['ready', 'not-configured', 'unreachable', 'invalid'].includes(check.status)));
  assert.doesNotMatch(JSON.stringify(doctor), /SECRET_SENTINEL|stdout|stderr|GH_TOKEN_VALUE/);

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

test('Pi session stream serializes slow snapshots instead of overlapping polls', async (t) => {
  const delegate = createFakePiSessionAdapter();
  await delegate.createSession({ id: 'slow-stream', title: 'Slow stream' });
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const adapter = {
    ...delegate,
    listMessages: async (sessionId) => {
      active += 1;
      calls += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1600));
        return await delegate.listMessages(sessionId);
      } finally {
        active -= 1;
      }
    }
  };
  const server = createServer({ piSessionAdapter: adapter });
  const port = await listen(server);
  t.after(() => close(server));

  const response = await fetch(`http://127.0.0.1:${port}/api/pi-sessions/slow-stream/stream`);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  await new Promise((resolve) => setTimeout(resolve, 3800));
  await reader.cancel();

  assert.ok(calls >= 2, `expected multiple snapshots, received ${calls}`);
  assert.equal(maximumActive, 1, 'slow snapshot polls overlapped');
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

test('completed runtime cleans up detached processes carrying its run owner marker', (t) => {
  if (process.platform !== 'linux') return t.skip('/proc ownership cleanup is Linux-specific');
  const runId = `owned-cleanup-${Date.now()}`;
  const workflowName = 'owned-cleanup';
  const fixtureDir = path.join(process.cwd(), '.agent-runs', 'test-fixtures', runId);
  const workflowFile = path.join(fixtureDir, 'workflow.edn');
  const helperFile = path.join(fixtureDir, 'launch-detached.sh');
  const runDir = path.join(process.cwd(), '.agent-runs', workflowName, runId);
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(helperFile, [
    '#!/bin/sh',
    'setsid sleep 60 </dev/null >/dev/null 2>&1 &',
    'echo $! > "$AGENT_RUN_DIR/owned.pid"',
    'printf \'{"status":"ok","ok":true}\\n\''
  ].join('\n'));
  fs.chmodSync(helperFile, 0o755);
  fs.writeFileSync(workflowFile, [
    `{:api-version "tesseraft.workflow/v1" :kind :workflow :metadata {:name "${workflowName}"}`,
    ' :defaults {:max-rounds 1 :state-timeout "1m"}',
    ' :policies {:require-timeouts true :require-max-rounds true}',
    ' :initial :launch',
    ` :states {:launch {:type :process :command [${JSON.stringify(helperFile)}] :runtime {:timeout "30s"} :next :done}`,
    '          :done {:type :terminal :status :success}}}'
  ].join('\n'));
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));

  execFileSync('./bin/tesseraft', ['run', workflowFile, '--run-id', runId, '--format', 'json'], {
    cwd: process.cwd(),
    stdio: 'pipe'
  });

  const ownedPid = Number(fs.readFileSync(path.join(runDir, 'owned.pid'), 'utf8').trim());
  assert.ok(Number.isInteger(ownedPid) && ownedPid > 0);
  assert.throws(() => process.kill(ownedPid, 0), /ESRCH/, 'detached run-owned process survived normal completion');
  assert.equal(fs.existsSync(path.join(runDir, 'runtime-process.json')), false);
});

test('web server cancels a detached runtime and persists terminal cancellation', async (t) => {
  const runId = `web-cancel-${Date.now()}`;
  const workflowName = 'cancel-smoke';
  const workflowDir = path.join(process.cwd(), '.tesseraft', 'workflows', workflowName);
  const runDir = path.join(process.cwd(), '.agent-runs', workflowName, runId);
  fs.rmSync(workflowDir, { recursive: true, force: true });
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(path.join(workflowDir, 'workflow.edn'), [
    `{:api-version "tesseraft.workflow/v1" :kind :workflow :metadata {:name "${workflowName}"}`,
    ' :defaults {:max-rounds 1 :state-timeout "2m"}',
    ' :policies {:require-timeouts true :require-max-rounds true}',
    ' :initial :wait',
    ' :states {:wait {:type :timer :duration "60s" :runtime {:timeout "90s"} :next :done}',
    '          :done {:type :terminal :status :success}}}'
  ].join('\n'));
  t.after(() => fs.rmSync(workflowDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));

  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const startResponse = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflow_name: workflowName, run_id: runId, inputs: {} })
  });
  assert.equal(startResponse.status, 202);

  const processFile = path.join(runDir, 'runtime-process.json');
  for (let i = 0; i < 50 && !fs.existsSync(processFile); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(fs.existsSync(processFile), 'detached resume did not persist its process metadata');
  const runtimePid = JSON.parse(fs.readFileSync(processFile, 'utf8')).pid;

  const cancelResponse = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(cancelResponse.status, 200);
  const cancelled = await cancelResponse.json();
  assert.equal(cancelled.operation, 'cancel');
  assert.equal(cancelled.status, 'ok');
  assert.equal(cancelled.latest_runtime.run.status, 'cancelled');
  assert.equal(cancelled.run_detail.run.liveness, 'cancelled');
  assert.ok(!fs.existsSync(processFile), 'cancellation left stale process metadata');
  assert.throws(() => process.kill(runtimePid, 0), /ESRCH/);
  const events = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8');
  assert.match(events, /"event":"run.cancelled"/);
  assert.match(events, /"owned_processes_enumerated":true/);
});

test('web server exposes approval pause, decide, and resume via the control plane', async (t) => {
  const runId = `web-approval-${Date.now()}`;
  const approvalRunDir = path.join(process.cwd(), '.agent-runs', 'approval-smoke', runId);
  fs.rmSync(approvalRunDir, { recursive: true, force: true });
  const workflowRunDir = path.join(process.cwd(), '.agent-runs', 'approval-smoke', runId);
  t.after(() => fs.rmSync(approvalRunDir, { recursive: true, force: true }));

  // A throwaway approval workflow written to the project-local discovery
  // root (.tesseraft/workflows, gitignored) so the control-plane resolves it
  // by name without editing any committed workflow definition file.
  const workflowDir = path.join(process.cwd(), '.tesseraft', 'workflows', 'approval-smoke');
  fs.rmSync(workflowDir, { recursive: true, force: true });
  fs.mkdirSync(workflowDir, { recursive: true });
  t.after(() => fs.rmSync(workflowDir, { recursive: true, force: true }));
  const workflowFile = path.join(workflowDir, 'workflow.edn');
  fs.writeFileSync(workflowFile, [
    '{:api-version "tesseraft.workflow/v1" :kind :workflow :metadata {:name "approval-smoke"}',
    ' :defaults {:max-rounds 1 :state-timeout "1m"}',
    ' :policies {:require-timeouts true :require-max-rounds true}',
    ' :initial :start',
    ' :states {:start {:type :timer :duration "1ms" :next :gate}',
    '          :gate {:type :approval :title "Gate" :message "Approve." :timeout "1m"',
    '                 :artifact {:path "design/design.md" :kind "design-doc"}',
    '                 :transitions [{:when {:decision "approve"} :next :done}',
    '                                {:when {:decision "changes-requested"} :next :revise}]}',
    '          :revise {:type :timer :duration "1ms" :next :failed}',
    '          :done {:type :terminal :status :success}',
    '          :failed {:type :terminal :status :failure}}}'
  ].join('\n'));

  const server = createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  // Start the workflow; the background resume loops until it parks at the
  // :gate approval node (blocked stops run-until-done!). Poll for blocked.
  const startResponse = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflow_name: 'approval-smoke', run_id: runId, inputs: {} })
  });
  assert.equal(startResponse.status, 202);
  const parked = await waitForRunStatus(base, runId, 'blocked');
  assert.equal(parked.state, 'gate');

  // Approvals list exposes the pending request.
  const approvalsResponse = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/approvals`);
  assert.equal(approvalsResponse.status, 200);
  const approvals = await approvalsResponse.json();
  assert.ok(approvals.approvals.length >= 1);
  const approvalId = approvals.approvals[0].approval_id;

  // P0.2 presentation contract: the durable request record carries a
  // materialized presentation (question/artifacts/decisions/routing) so the
  // UI renders the decision screen from the record instead of hard-coded
  // labels. Synthesized here because the node authored no `:presentation`.
  const pending = approvals.approvals[0];
  assert.equal(pending.routing?.kind, 'self');
  assert.ok(Array.isArray(pending.artifacts) && pending.artifacts.length >= 1);
  assert.equal(pending.artifacts[0].path, 'design/design.md');
  assert.ok(Array.isArray(pending.decisions) && pending.decisions.length === 2);
  const approveDecision = pending.decisions.find((d) => d.decision === 'approve');
  const changesDecision = pending.decisions.find((d) => d.decision === 'changes-requested');
  assert.ok(approveDecision, 'expected an approve decision option');
  assert.ok(changesDecision, 'expected a changes-requested decision option');
  assert.equal(approveDecision.next, 'done');
  assert.equal(changesDecision.next, 'revise');

  // Add a line-anchored comment on the referenced artifact.
  const commentResponse = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'design/design.md', body: 'Tighten scope?', anchor: { start_line: 3, end_line: 5 } })
  });
  assert.equal(commentResponse.status, 200);
  const comment = await commentResponse.json();
  assert.equal(comment.comment.path, 'design/design.md');
  assert.deepEqual(comment.comment.anchor, { start_line: 3, end_line: 5 });

  // List comments.
  const listResponse = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/comments?path=${encodeURIComponent('design/design.md')}`);
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json();
  assert.equal(listed.comments.length, 1);
  assert.match(listed.comments[0].body, /Tighten scope/);

  // Regression R2-1: appending a SECOND comment on the same artifact must
  // preserve the first comment and return both, in order. Previously the
  // append used `(when (fs/exists? cf) (read-json cf) [])`, which dropped the
  // [] fallback so `existing` was nil on a missing file — masked for the
  // first comment by `(vec nil)`, but never actually validated for append.
  const secondCommentResponse = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'design/design.md', body: 'Second nit: timeout too short?' })
  });
  assert.equal(secondCommentResponse.status, 200);
  const secondComment = await secondCommentResponse.json();
  assert.equal(secondComment.comment.path, 'design/design.md');

  const listAfterSecond = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/comments?path=${encodeURIComponent('design/design.md')}`);
  assert.equal(listAfterSecond.status, 200);
  const listedAfterSecond = await listAfterSecond.json();
  assert.equal(listedAfterSecond.comments.length, 2);
  assert.match(listedAfterSecond.comments[0].body, /Tighten scope/);
  assert.match(listedAfterSecond.comments[1].body, /Second nit/);

  // Unsafe path is rejected.
  const unsafeResponse = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '../../etc/passwd', body: 'x' })
  });
  assert.ok(unsafeResponse.status >= 400);

  // Decide approve -> run advances to :done.
  const decideResponse = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approve', summary: 'LGTM' })
  });
  assert.equal(decideResponse.status, 200);
  const decided = await decideResponse.json();
  assert.equal(decided.operation, 'decide');
  assert.equal(decided.decision, 'approve');

  const doneRun = await waitForRunStatus(base, runId, 'done');
  assert.equal(doneRun.state, 'done');

  // A second decide on the same approval is rejected (idempotent-ish).
  const replay = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approve' })
  });
  assert.ok(replay.status >= 400);
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
  assert.equal(initialBody.settings.color_scheme, 'classic');
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

  const badScheme = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ color_scheme: 'cyberpunk' })
  });
  assert.equal(badScheme.status, 400);
  assert.equal((await badScheme.json()).error.code, 'bad_request');
  assert.equal(fs.existsSync(configFile), false, 'invalid schemes must not mutate settings');

  const write = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pi_default_provider: 'openai',
      pi_default_model: 'gpt-4o-mini',
      github_token: 'ghp_secretvalue1234',
      jira_token: 'jira-token-abcd',
      default_repo_root: '/tmp/my-repo',
      color_scheme: 'matrix'
    })
  });
  assert.equal(write.status, 200);
  const written = await write.json();
  assert.equal(written.settings.source, 'project');
  assert.equal(written.settings.pi_default_provider, 'openai');
  assert.equal(written.settings.pi_default_model, 'gpt-4o-mini');
  assert.equal(written.settings.default_repo_root, '/tmp/my-repo');
  assert.equal(written.settings.color_scheme, 'matrix');
  // Tokens must be masked — only present + last 4 preview, never full value.
  assert.equal(written.settings.github_token.present, true);
  assert.equal(written.settings.github_token.preview, '1234');
  assert.equal(written.settings.jira_token.present, true);
  assert.equal(written.settings.jira_token.preview, 'abcd');

  const stored = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(stored.github_token, 'ghp_secretvalue1234');
  assert.equal(stored.jira_token, 'jira-token-abcd');
  assert.equal(stored.color_scheme, 'matrix');

  const matrixGet = await fetch(`${base}/api/settings`).then((response) => response.json());
  assert.equal(matrixGet.settings.color_scheme, 'matrix');

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

test('control-plane comment add appends a second comment to the same artifact (R2-1)', () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.agent-runs', 'comment-append-'));
  const runDir = path.join(root, 'wf', 'append-run');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state.edn'), '{:workflow {:name "wf" :version "v1"} :run {:id "append-run" :status "blocked" :state :gate}}');
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), '');
  fs.mkdirSync(path.join(runDir, 'design'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'design', 'design.md'), '# Design\n');
  const artifact = 'design/design.md';

  try {
    const first = JSON.parse(execFileSync('./bin/tesseraft', ['control-plane', '--workspace-root', root, '--runs-root', 'wf', 'comment', 'add', 'append-run', '--path', artifact, '--body', 'First comment on the artifact'], { encoding: 'utf8' }));
    assert.equal(first.comment.path, artifact);
    assert.match(first.comment.body, /First comment/);

    const second = JSON.parse(execFileSync('./bin/tesseraft', ['control-plane', '--workspace-root', root, '--runs-root', 'wf', 'comment', 'add', 'append-run', '--path', artifact, '--body', 'Second comment on the artifact'], { encoding: 'utf8' }));
    assert.equal(second.comment.path, artifact);
    assert.match(second.comment.body, /Second comment/);

    const listed = JSON.parse(execFileSync('./bin/tesseraft', ['control-plane', '--workspace-root', root, '--runs-root', 'wf', 'comments', 'append-run', '--path', artifact], { encoding: 'utf8' }));
    assert.equal(listed.comments.length, 2);
    assert.match(listed.comments[0].body, /First comment/);
    assert.match(listed.comments[1].body, /Second comment/);

    // The persisted comment file on disk holds both, in order. comments-file
    // maps <run-dir>/comments/<safe-path>/.json (the safe path becomes a dir
    // and .json the file name), so design/design.md -> comments/design/design.md/.json.
    const persisted = JSON.parse(fs.readFileSync(path.join(runDir, 'comments', artifact, '.json'), 'utf8'));
    assert.ok(Array.isArray(persisted));
    assert.equal(persisted.length, 2);
    assert.match(persisted[0].body, /First comment/);
    assert.match(persisted[1].body, /Second comment/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project abstraction: routeApi + read-only HTTP + masked connections (design §4.6)', async () => {
  // routeApi project entries (covered above for the pure router; here also via
  // the live server for GET surfaces that never write to disk).
  const server = createServer(createFakePiSessionAdapter());
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    // GET /api/projects returns a non-empty list (implicit default synthesized).
    const listRes = await fetch(`${base}/api/projects`);
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.ok(Array.isArray(list.projects) && list.projects.length >= 1);
    assert.ok(list.projects.some((p) => p.project_id === 'default'), 'default project present');

    // GET /api/projects/default returns the aggregate without raw tokens.
    const detailRes = await fetch(`${base}/api/projects/default`);
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json();
    assert.equal(detail.project_id, 'default');
    // settings tokens must be masked objects, never raw strings.
    if (detail.settings && detail.settings.github_token) {
      assert.equal(typeof detail.settings.github_token, 'object');
      assert.ok(!('preview' in detail.settings.github_token) || typeof detail.settings.github_token.preview !== 'string' || detail.settings.github_token.preview.length <= 4);
      assert.ok(!('token' in detail.settings.github_token));
    }

    // GET /api/projects/<malformed> is a 400 (bad_request), not a 500.
    const badRes = await fetch(`${base}/api/projects/Bad-Id`);
    assert.ok(badRes.status === 400 || badRes.status === 404);

    // PUT connections with a raw token payload is rejected (400) without
    // shelling out, so no secret ever reaches the control plane.
    const rawTokenRes = await fetch(`${base}/api/projects/default/connections`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jira: { token: 'ghp_supersecret' } })
    });
    assert.equal(rawTokenRes.status, 400);
    const rawTokenBody = await rawTokenRes.json();
    assert.match(rawTokenBody.error.message, /credential/i);
  } finally {
    await close(server);
  }
});

test('project abstraction: control-plane CRUD + credential-ref validation against a temp workspace', () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.agent-runs', 'project-crud-'));
  try {
    const cp = (args) => JSON.parse(execFileSync('./bin/tesseraft', ['control-plane', '--workspace-root', root, ...args], { encoding: 'utf8' }));

    // List synthesizes the implicit default when no manifests exist.
    const listed = cp(['projects']);
    assert.ok(listed.projects.some((p) => p.project_id === 'default'));

    // Create a project with connection credential-refs.
    const created = cp(['project', 'create', 'acme', '--name', 'Acme', '--jira-credential-ref', 'env:JIRA_TOKEN', '--github-credential-ref', 'env:GITHUB_TOKEN']);
    assert.equal(created.project_id, 'acme');
    assert.equal(created.connections.jira['credential-ref'], 'env:JIRA_TOKEN');

    // Duplicate create exits nonzero (control plane emits an :error body).
    let dupThrew = false;
    try { cp(['project', 'create', 'acme']); } catch { dupThrew = true; }
    assert.equal(dupThrew, true);

    // Get returns the persisted manifest (no raw tokens present).
    const got = cp(['project', 'acme']);
    assert.equal(got.name, 'Acme');
    assert.equal(got.connections.github['credential-ref'], 'env:GITHUB_TOKEN');

    // Connections endpoint returns masked state and never the raw token.
    const conns = cp(['project', 'connections', 'acme']);
    assert.ok(conns.connections.jira || conns.connections.github);

    // Migrate the default project from legacy settings works only when no
    // default manifest exists yet.
    const migrated = cp(['project', 'migrate']);
    assert.equal(migrated.project_id, 'default');
    assert.match(String(migrated['migrated-from'] || ''), /legacy-settings/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project abstraction: path-confinement rejects runs_root and workspace_root escapes (review issues 1 & 2)', () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.agent-runs', 'project-confinement-'));
  try {
    const cp = (args) => {
      try {
        return { out: JSON.parse(execFileSync('./bin/tesseraft', ['control-plane', '--workspace-root', root, ...args], { encoding: 'utf8', stdio: 'pipe' })), threw: false };
      } catch (e) {
        return { out: JSON.parse(String(e.stdout || '{}')), threw: true, stderr: String(e.stderr || '') };
      }
    };

    // runs_root traversal escapes are rejected and not persisted.
    const rr = cp(['project', 'create', 'escape-runs', '--runs-root', '../../../tmp/escape']);
    assert.equal(rr.threw, true, 'runs_root escape must exit nonzero');
    assert.equal(rr.out.status, 400, rr.out);
    assert.match(rr.out.error.message, /runs_root/);
    assert.ok(!fs.existsSync(path.join(root, '.tesseraft', 'projects', 'escape-runs.json')), 'escaped runs_root manifest must not be written');

    // workspace_root relative escape is rejected and not persisted.
    const wr = cp(['project', 'create', 'escape-ws-rel', '--workspace-root', '../etc/passwd']);
    assert.equal(wr.threw, true, 'relative workspace_root escape must exit nonzero');
    assert.equal(wr.out.status, 400, wr.out);
    assert.match(wr.out.error.message, /workspace_root/);
    assert.ok(!fs.existsSync(path.join(root, '.tesseraft', 'projects', 'escape-ws-rel.json')), 'escaped workspace_root manifest must not be written');

    // workspace_root absolute escape is rejected and not persisted.
    const wa = cp(['project', 'create', 'escape-ws-abs', '--workspace-root', '/tmp/escape']);
    assert.equal(wa.threw, true, 'absolute workspace_root escape must exit nonzero');
    assert.equal(wa.out.status, 400, wa.out);
    assert.match(wa.out.error.message, /workspace_root/);
    assert.ok(!fs.existsSync(path.join(root, '.tesseraft', 'projects', 'escape-ws-abs.json')), 'absolute escaped workspace_root manifest must not be written');

    // Sanity: a legitimately scoped project still creates.
    const ok = cp(['project', 'create', 'ok-proj', '--runs-root', '.agent-runs']);
    assert.equal(ok.threw, false, ok.out && ok.out.error);
    assert.equal(ok.out.project_id, 'ok-proj');
    assert.ok(fs.existsSync(path.join(root, '.tesseraft', 'projects', 'ok-proj.json')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project abstraction: HTTP create rejects path escapes with 400 and honors nested discovery.workflow-roots (review issues 1, 2, 3)', async () => {
  const server = createServer(createFakePiSessionAdapter());
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    // POST /api/projects with an escaping runs_root returns 400, never 201.
    const escapeRes = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: 'http-escape', runs_root: '../../../tmp/escape' })
    });
    assert.equal(escapeRes.status, 400, 'escaped runs_root must be 400, not 201');
    const escapeBody = await escapeRes.json();
    assert.match(escapeBody.error.message, /runs_root|workspace_root|path/i, escapeBody);
    // A follow-up GET must 404 (no manifest created).
    const gone = await fetch(`${base}/api/projects/http-escape`);
    assert.equal(gone.status, 404, 'escaped project must not have been persisted');

    // POST with the design-doc nested discovery shape is honored.
    const nested = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: 'nested-discovery', name: 'Nested', discovery: { 'workflow-roots': ['examples/smoke'] } })
    });
    assert.equal(nested.status, 201, 'nested discovery create should succeed');
    const nestedBody = await nested.json();
    assert.deepEqual(nestedBody.discovery['workflow-roots'], ['examples/smoke'], 'nested discovery.workflow-roots must be honored');

    // A follow-up GET confirms the nested roots were persisted.
    const refetch = await fetch(`${base}/api/projects/nested-discovery`);
    assert.equal(refetch.status, 200);
    const refetched = await refetch.json();
    assert.deepEqual(refetched.discovery['workflow-roots'], ['examples/smoke']);
  } finally {
    await close(server);
    // Clean up created manifests so listProjects synthesizes the implicit
    // default for later tests (default is only implicit when no manifests exist).
    const projectsDir = path.join(process.cwd(), '.tesseraft', 'projects');
    for (const id of ['nested-discovery', 'http-escape']) {
      fs.rmSync(path.join(projectsDir, `${id}.json`), { force: true });
    }
  }
});
