import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, parseArgs } from '../web/dist-server/server.js';
import {
  createConfiguredPiSessionAdapter,
  createFakePiSessionAdapter,
  derivePiChatMessages,
  PiSettingsResolutionError
} from '../web/dist-server/lib/piSessionAdapter.js';

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

const withEnvironment = async (updates, action) => {
  const previous = Object.fromEntries(Object.keys(updates).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return await action(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const waitForRunStatus = async (base, projectId, runId, expected, attempts = 100) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(`${base}/api/projects/${projectId}/runs/${runId}`);
    if (response.status === 200) {
      const body = await response.json();
      if (body.run?.status === expected) return body.run;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Run ${runId} did not reach ${expected}`);
};

const writeDescriptor = (root, projectId, workflowRoots = ['.tesseraft/workflows']) => {
  fs.mkdirSync(path.join(root, '.tesseraft'), { recursive: true });
  fs.writeFileSync(path.join(root, '.tesseraft', 'project.json'), JSON.stringify({
    version: 2,
    project_id: projectId,
    name: 'Web API Project',
    runs_root: 'runs',
    discovery: { workflow_roots: workflowRoots }
  }, null, 2));
};

const writeSmokeWorkflow = (root) => {
  const workflowDir = path.join(root, '.tesseraft', 'workflows', 'web-smoke');
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(path.join(workflowDir, 'workflow.edn'), [
    '{:api-version "tesseraft.workflow/v1" :kind :workflow',
    ' :metadata {:name "web-smoke" :title "Web smoke"}',
    ' :defaults {:max-rounds 1 :state-timeout "1m"}',
    ' :policies {:require-timeouts true :require-max-rounds true}',
    ' :initial :start',
    ' :states {:start {:type :deterministic :handler :noop/succeed :runtime {:timeout "10s"} :next :done}',
    '          :done {:type :terminal :status :success}}}'
  ].join('\n'));
};

test('parseArgs validates bind options and requires an explicit exposure acknowledgement', () => {
  assert.deepEqual(parseArgs(['--port', '0']), {
    host: '127.0.0.1',
    port: 0,
    acknowledgeRemoteExposure: false
  });
  assert.deepEqual(parseArgs(['--host', '0.0.0.0', '--acknowledge-remote-exposure']), {
    host: '0.0.0.0',
    port: 7341,
    acknowledgeRemoteExposure: true
  });
  assert.throws(() => parseArgs(['--port', '70000']), /Invalid --port/);
  assert.throws(() => parseArgs(['--unknown']), /Unknown option/);
});

test('built web wrapper starts and serves the React shell', async () => {
  const child = spawn(process.execPath, ['web/server.js', '--host', '127.0.0.1', '--port', '0'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`web wrapper did not start: ${stderr}`)), 10000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`web wrapper exited with ${code}: ${stderr}`)); });
      child.stdout.on('data', (chunk) => {
        const match = String(chunk).match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
      });
    });
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Tesseraft Local Web UI/);
  } finally {
    child.kill('SIGTERM');
  }
});

test('server exposes static assets, health, catalogs, browsing, and JSON errors', async (t) => {
  const server = createServer({ piSessionAdapter: createFakePiSessionAdapter() });
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  const indexText = await index.text();
  const assetPath = indexText.match(/src="([^\"]+\.js)"/)?.[1];
  assert.ok(assetPath, 'the built shell references a JavaScript asset');
  const asset = await fetch(`${base}${assetPath}`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type') || '', /javascript/);

  const health = await fetch(`${base}/api/health`).then((response) => response.json());
  assert.equal(health.status, 'ready');
  assert.equal(health.checks.static_assets, true);

  const capabilities = await fetch(`${base}/api/capabilities`).then((response) => response.json());
  assert.ok(capabilities.handlers.some((handler) => handler.id === 'noop/succeed'));
  assert.deepEqual(capabilities.executors.map((executor) => executor.id), ['claude-code', 'opencode-cli', 'pi-cli', 'pi-sdk']);
  assert.deepEqual(capabilities.work_trackers.map((provider) => provider.provider), ['github-issues', 'jira', 'plane']);
  assert.doesNotMatch(JSON.stringify(capabilities), /credential.?value|access.?token|password/i);

  const providers = await fetch(`${base}/api/work-tracker-providers`).then((response) => response.json());
  assert.deepEqual(providers.providers.map((provider) => provider.provider), ['github-issues', 'jira', 'plane']);
  assert.ok(providers.providers.every((provider) => provider.fields.length > 0));

  const browse = await fetch(`${base}/api/browse?path=web`).then((response) => response.json());
  assert.ok(browse.entries.some((entry) => entry.name === 'src' && entry.is_dir));
  const escaped = await fetch(`${base}/api/browse?path=${encodeURIComponent('../')}`);
  assert.equal(escaped.status, 400);

  const malformed = await fetch(`${base}/api/workflows/%E0%A4%A/graph`);
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'bad_request');
  const missing = await fetch(`${base}/api/no-such-route`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'not_found');
});

test('fake Pi adapter and HTTP routes preserve semantic chat messages', async (t) => {
  const configured = createConfiguredPiSessionAdapter({ TESSERAFT_PI_ADAPTER: 'fake' });
  await configured.createSession({ id: 'configured-fake' });
  const configuredPrompt = await configured.sendPrompt('configured-fake', 'hello');
  assert.deepEqual(configuredPrompt.messages.map((message) => message.role), ['system', 'user', 'assistant']);

  const messages = derivePiChatMessages([
    { id: 'e1', session_id: 's', sequence: 1, created_at: '2026-01-01T00:00:00Z', event: 'prompt.sent', role: 'user', text: 'Hello' },
    { id: 'e2', session_id: 's', sequence: 2, created_at: '2026-01-01T00:00:01Z', event: 'message_update', text: 'Hel', data: { sdk_event: { assistantMessageEvent: { delta: 'Hel' } } } },
    { id: 'e3', session_id: 's', sequence: 3, created_at: '2026-01-01T00:00:02Z', event: 'message_update', text: 'lo', data: { sdk_event: { assistantMessageEvent: { delta: 'lo' } } } }
  ]);
  assert.deepEqual(messages.map((message) => [message.role, message.text]), [['user', 'Hello'], ['assistant', 'Hello']]);

  const server = createServer({ piSessionAdapter: createFakePiSessionAdapter() });
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  const created = await fetch(`${base}/api/pi-sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'api-pi', title: 'API Pi' })
  });
  assert.equal(created.status, 201);
  const prompted = await fetch(`${base}/api/pi-sessions/api-pi/prompts`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Summarize' })
  });
  assert.equal(prompted.status, 200);
  assert.deepEqual((await prompted.json()).messages.map((message) => message.role), ['system', 'user', 'assistant']);
  const events = await fetch(`${base}/api/pi-sessions/api-pi/events?after=1`).then((response) => response.json());
  assert.deepEqual(events.events.map((event) => event.sequence), [2, 3]);
});

test('Pi settings failures are stable actionable JSON errors', async (t) => {
  const adapter = {
    createSession: async () => { throw new PiSettingsResolutionError('acme', 'missing', 'no catalog entry'); },
    listSessions: async () => [], getSession: async () => null, sendPrompt: async () => null,
    listMessages: async () => [], listEvents: async () => [], streamEvents: async () => {}
  };
  const server = createServer({ piSessionAdapter: adapter });
  const port = await listen(server);
  t.after(() => close(server));
  const response = await fetch(`http://127.0.0.1:${port}/api/pi-sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'pi_settings_resolution');
  assert.match(body.error.message, /acme/);
  assert.match(body.error.message, /pi auth/);
});

test('v2 project APIs isolate durable config and scoped runs', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-web-v2-'));
  const home = path.join(sandbox, 'home');
  const allowed = path.join(sandbox, 'projects');
  const project = path.join(allowed, 'alpha');
  const projectId = 'web-alpha';
  const runId = `web-run-${Date.now()}`;
  fs.mkdirSync(project, { recursive: true });
  writeDescriptor(project, projectId);
  writeSmokeWorkflow(project);

  await withEnvironment({ TESSERAFT_HOME: home }, async () => {
    const server = createServer({
      piSessionAdapter: createFakePiSessionAdapter(),
      browserAllowedProjectRoots: [allowed]
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;
    try {
      const outside = await fetch(`${base}/api/projects`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project_root: sandbox })
      });
      assert.equal(outside.status, 400);
      assert.equal((await outside.json()).error.code, 'project_root_not_allowed');

      const registered = await fetch(`${base}/api/projects`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project_root: project })
      });
      assert.equal(registered.status, 201);
      const registeredBody = await registered.json();
      assert.equal(registeredBody.project_id, projectId);
      assert.equal(registeredBody.workspace_root, fs.realpathSync(project));

      const registry = JSON.parse(fs.readFileSync(path.join(home, 'projects', 'registry.json'), 'utf8'));
      assert.deepEqual(registry, { version: 2, projects: { [projectId]: { workspace_root: fs.realpathSync(project) } } });

      const detail = await fetch(`${base}/api/projects/${projectId}`).then((response) => response.json());
      assert.equal(detail.project_id, projectId);
      assert.equal(detail.source, 'registration');

      const secret = await fetch(`${base}/api/projects/${projectId}/connections`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 'work-tracker': { token: 'must-not-persist' } })
      });
      assert.equal(secret.status, 400);
      assert.doesNotMatch(fs.readFileSync(path.join(project, '.tesseraft', 'project.json'), 'utf8'), /must-not-persist/);

      const connections = await fetch(`${base}/api/projects/${projectId}/connections`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          'code-host': { provider: 'github', 'auth-mode': 'ambient' },
          'work-tracker': {
            provider: 'plane', 'schema-version': 1, 'credential-ref': 'env:PLANE_TOKEN',
            config: { 'api-base-url': 'https://plane.example', 'workspace-slug': 'ws', 'project-id': 'project' }
          }
        })
      });
      assert.equal(connections.status, 200);
      assert.equal((await connections.json()).connections['work-tracker'].provider, 'plane');

      const preferences = await fetch(`${base}/api/settings`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ color_scheme: 'matrix', editor_layout: 'compact' })
      });
      assert.equal(preferences.status, 200);
      assert.equal((await preferences.json()).settings.color_scheme, 'matrix');
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'preferences.json'), 'utf8')), {
        version: 1, preferences: { color_scheme: 'matrix', editor_layout: 'compact' }
      });

      const identity = await fetch(`${base}/api/projects/${projectId}/git-user`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Tess Bot', email: 'tess@example.com' })
      });
      assert.equal(identity.status, 200);
      assert.equal((await identity.json()).git_user.source, 'project-override');
      const identityStore = JSON.parse(fs.readFileSync(path.join(home, 'git-identities.json'), 'utf8'));
      assert.deepEqual(identityStore.projects[projectId], { name: 'Tess Bot', email: 'tess@example.com' });

      const started = await fetch(`${base}/api/projects/${projectId}/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflow_name: 'web-smoke', run_id: runId, inputs: {} })
      });
      assert.equal(started.status, 202);
      assert.equal((await started.json()).run_id, runId);
      const run = await waitForRunStatus(base, projectId, runId, 'done');
      assert.equal(run.state, 'done');

      const events = await fetch(`${base}/api/projects/${projectId}/runs/${runId}/events`).then((response) => response.json());
      assert.ok(events.events.some((event) => event.event === 'run.finished'));
      const artifacts = await fetch(`${base}/api/projects/${projectId}/runs/${runId}/artifacts`).then((response) => response.json());
      assert.ok(artifacts.artifacts.some((artifact) => artifact.path === 'events.jsonl'));

      const removedRun = await fetch(`${base}/api/projects/${projectId}/runs/${runId}`, { method: 'DELETE' });
      assert.equal(removedRun.status, 200);
      assert.equal((await removedRun.json()).deleted, true);
      const unregistered = await fetch(`${base}/api/projects/${projectId}`, { method: 'DELETE' });
      assert.equal(unregistered.status, 200);
      assert.equal((await unregistered.json()).deleted, true);
      assert.equal(fs.existsSync(path.join(project, '.tesseraft', 'project.json')), true);
    } finally {
      await close(server);
    }
  });
  fs.rmSync(sandbox, { recursive: true, force: true });
});
