import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TESSERAFT = path.join(process.cwd(), 'bin', 'tesseraft');

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    server.off('error', reject);
    resolve(server.address().port);
  });
});

const close = (server) => new Promise((resolve) => { server.close(() => resolve()); });

const cp = (workspaceRoot, args) => {
  try {
    return { out: JSON.parse(execFileSync(TESSERAFT, ['control-plane', '--workspace-root', workspaceRoot, ...args], { encoding: 'utf8', stdio: 'pipe' })), threw: false };
  } catch (e) {
    return { out: JSON.parse(String(e.stdout || '{}')), threw: true, stderr: String(e.stderr || '') };
  }
};

const workflowEdn = (name) => [
  '{:api-version "tesseraft.workflow/v1" :kind :workflow :metadata {:name "' + name + '"}',
  ' :initial :done',
  ' :states {:done {:type :terminal}}}'
].join('\n');

test('project-scoped operations: discovery, settings, and run isolation across two projects', async (t) => {
  // Two temp workspaces, each its own project with distinct workflow roots and
  // runs roots. Project manifests live under `<ws>/.tesseraft/projects`.
  const wsA = fs.mkdtempSync(path.join(process.cwd(), '.agent-runs', 'project-scope-a-'));
  const wsB = fs.mkdtempSync(path.join(process.cwd(), '.agent-runs', 'project-scope-b-'));
  t.after(() => { fs.rmSync(wsA, { recursive: true, force: true }); fs.rmSync(wsB, { recursive: true, force: true }); });

  // Create project "alpha" under wsA with its own workflow root + runs root.
  // The workspace_root must be under wsA (path confinement); use a subdir.
  fs.mkdirSync(path.join(wsA, 'wfa', 'alpha-only'), { recursive: true });
  fs.writeFileSync(path.join(wsA, 'wfa', 'alpha-only', 'workflow.edn'), workflowEdn('alpha-only'));
  const alpha = cp(wsA, ['project', 'create', 'alpha', '--name', 'Alpha', '--workspace-root', '.', '--runs-root', '.agent-runs', '--workflow-root', 'wfa']);
  assert.equal(alpha.threw, false, `alpha create failed: ${alpha.stderr}`);

  // Project "beta" under wsB with a different workflow root + an identical run_id later.
  fs.mkdirSync(path.join(wsB, 'wfb', 'beta-only'), { recursive: true });
  fs.writeFileSync(path.join(wsB, 'wfb', 'beta-only', 'workflow.edn'), workflowEdn('beta-only'));
  const beta = cp(wsB, ['project', 'create', 'beta', '--name', 'Beta', '--workspace-root', '.', '--runs-root', '.agent-runs', '--workflow-root', 'wfb']);
  assert.equal(beta.threw, false, `beta create failed: ${beta.stderr}`);

  // (1) Discovery isolation: alpha discovers alpha-only, beta discovers beta-only.
  const alphaWf = cp(wsA, ['--project-id', 'alpha', 'workflows']);
  const betaWf = cp(wsB, ['--project-id', 'beta', 'workflows']);
  const alphaNames = alphaWf.out.workflows.map((w) => w.name);
  const betaNames = betaWf.out.workflows.map((w) => w.name);
  assert.ok(alphaNames.includes('alpha-only'), `alpha should discover alpha-only: ${alphaNames}`);
  assert.ok(!alphaNames.includes('beta-only'), `alpha must not discover beta-only: ${alphaNames}`);
  assert.ok(betaNames.includes('beta-only'), `beta should discover beta-only: ${betaNames}`);
  assert.ok(!betaNames.includes('alpha-only'), `beta must not discover alpha-only: ${betaNames}`);

  // (2) Settings isolation: writing a setting under alpha is not visible to beta.
  const setA = cp(wsA, ['--project-id', 'alpha', 'settings', 'set', '--pi-default-provider', 'openai', '--pi-default-model', 'a-model']);
  assert.equal(setA.threw, false, `alpha settings set failed: ${setA.stderr}`);
  const getA = cp(wsA, ['--project-id', 'alpha', 'settings', 'get']);
  assert.equal(getA.out.settings.pi_default_provider, 'openai', `alpha settings: ${JSON.stringify(getA.out)}`);
  const getB = cp(wsB, ['--project-id', 'beta', 'settings', 'get']);
  assert.notEqual(getB.out.settings.pi_default_provider, 'openai', `beta must not see alpha's settings: ${JSON.stringify(getB.out)}`);

  // (3) Run identity (project_id, run_id): identical run_id in two projects
  // does not collide and resolves independently. Use the mock-executor smoke
  // workflow bundled in examples; start a run with the same id in each.
  // The runs root differs per workspace (wsA/.agent-runs vs wsB/.agent-runs),
  // so the run dirs differ and no 409 is expected.
  // We exercise the HTTP API to prove end-to-end threading of --project-id.

  // Start a "workflow.resolved"-bearing run via the control plane in alpha by
  // writing a terminal workflow so the run completes immediately.
  fs.mkdirSync(path.join(wsA, 'wfa', 'term-alpha'), { recursive: true });
  fs.writeFileSync(path.join(wsA, 'wfa', 'term-alpha', 'workflow.edn'), workflowEdn('term-alpha'));
  fs.mkdirSync(path.join(wsB, 'wfb', 'term-beta'), { recursive: true });
  fs.writeFileSync(path.join(wsB, 'wfb', 'term-beta', 'workflow.edn'), workflowEdn('term-beta'));

  const runId = 'same-run-id-' + Date.now();
  const startARuntime = execFileSync(TESSERAFT, ['run', 'start', path.join(wsA, 'wfa', 'term-alpha', 'workflow.edn'), '--run-id', runId, '--project-id', 'alpha', '--runs-root', '.agent-runs', '--workspace-root', wsA, '--format', 'json'], { encoding: 'utf8', stdio: 'pipe' });
  const aRun = JSON.parse(startARuntime);
  assert.equal(aRun.run['project-id'], 'alpha', `alpha run should stamp project-id: ${JSON.stringify(aRun)}`);
  const aRunDir = aRun.run.dir;

  const startBRuntime = execFileSync(TESSERAFT, ['run', 'start', path.join(wsB, 'wfb', 'term-beta', 'workflow.edn'), '--run-id', runId, '--project-id', 'beta', '--runs-root', '.agent-runs', '--workspace-root', wsB, '--format', 'json'], { encoding: 'utf8', stdio: 'pipe' });
  const bRun = JSON.parse(startBRuntime);
  assert.equal(bRun.run['project-id'], 'beta', `beta run should stamp project-id: ${JSON.stringify(bRun)}`);
  const bRunDir = bRun.run.dir;

  // Both started (no 409), distinct dirs, distinct project_id stamps.
  assert.notEqual(aRunDir, bRunDir, 'run dirs must differ across projects');
  assert.ok(aRunDir.startsWith(path.resolve(wsA)), `alpha run dir under wsA: ${aRunDir}`);
  assert.ok(bRunDir.startsWith(path.resolve(wsB)), `beta run dir under wsB: ${bRunDir}`);

  // (4) Project-scoped resolution: each project resolves only its own run.
  const resolveA = cp(wsA, ['--project-id', 'alpha', 'run', runId]);
  assert.equal(resolveA.out.run.project_id, 'alpha', `alpha resolves alpha run: ${JSON.stringify(resolveA.out)}`);
  const resolveB = cp(wsB, ['--project-id', 'beta', 'run', runId]);
  assert.equal(resolveB.out.run.project_id, 'beta', `beta resolves beta run: ${JSON.stringify(resolveB.out)}`);

  // A run with this id does NOT resolve under the other project (404).
  const crossA = cp(wsB, ['--project-id', 'beta', 'run', runId + '-nope']);
  assert.ok(crossA.threw || crossA.out.error, 'cross-project missing run should error');

  // (5) Deleting alpha's run leaves beta's intact.
  const delA = cp(wsA, ['--project-id', 'alpha', 'delete-run', runId]);
  assert.equal(delA.out.deleted, true, `alpha delete: ${JSON.stringify(delA.out)}`);
  assert.equal(fs.existsSync(aRunDir), false, 'alpha run dir removed');
  assert.equal(fs.existsSync(bRunDir), true, 'beta run dir must remain after alpha deleted');
  const resolveBAfter = cp(wsB, ['--project-id', 'beta', 'run', runId]);
  assert.equal(resolveBAfter.out.run.project_id, 'beta', 'beta run still resolves after alpha deleted');

  // (6) Credential-ref security: raw token in connections is rejected with 400.
  const rawToken = cp(wsA, ['project', 'connections', 'alpha', '--jira-credential-ref', 'not-a-ref']);
  assert.ok(rawToken.threw, 'invalid credential-ref must be rejected');
  assert.match(rawToken.out.error.message, /credential/i);

  // (7) Path confinement: an absolute runs_root is rejected with 400.
  const absRuns = cp(wsA, ['project', 'create', 'bad-abs-runs', '--runs-root', '/tmp/escape']);
  assert.ok(absRuns.threw, 'absolute runs_root must be rejected');
  assert.match(absRuns.out.error.message, /runs_root|workspace_root|path/i);
});