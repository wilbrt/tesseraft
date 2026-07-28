import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const workflow = path.join(repoRoot, 'examples', 'work-item-to-pr', 'workflow.edn');
const fixturesDir = path.join(repoRoot, 'examples', 'work-item-to-pr', 'fixtures');

const providers = [
  { provider: 'plane', fixture: 'plane-project.json', itemId: 'PLANE-42' },
  { provider: 'jira', fixture: 'jira-project.json', itemId: 'JIRA-42' },
  { provider: 'github-issues', fixture: 'github-issues-project.json', itemId: '42' }
];

function runCli(args, options = {}) {
  return execFileSync(path.join(repoRoot, 'bin', 'tesseraft'), args, {
    cwd: repoRoot,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', options.allowFailure ? 'pipe' : 'inherit']
  });
}

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8'));
}

function runDir(runId) {
  return path.join(repoRoot, '.agent-runs', 'work-item-to-pr', runId);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function startMockRun({ provider, fixtureName, itemId }) {
  const runId = `generic-${provider}-mock`;
  const projectContext = fixture(fixtureName);
  fs.rmSync(runDir(runId), { recursive: true, force: true });
  runCli([
    'start', workflow,
    '--executor', 'mock',
    '--run-id', runId,
    '--project-id', projectContext.project_id,
    '--project-context', JSON.stringify(projectContext),
    '--input', `item-id=${itemId}`,
    '--input', 'repo-root=.',
    '--input', 'base-branch=main',
    '--format', 'json'
  ]);
  return { runId, dir: runDir(runId), projectContext };
}

function step(runDirPath, allowFailure = false) {
  try {
    return {
      ok: true,
      out: runCli(['step', '--run-dir', runDirPath, '--format', 'json'], { allowFailure })
    };
  } catch (error) {
    if (!allowFailure) throw error;
    return {
      ok: false,
      out: `${error.stdout || ''}${error.stderr || ''}`
    };
  }
}

function assertNoFiles(runDirPath, relativeFiles) {
  for (const rel of relativeFiles) {
    assert.equal(fs.existsSync(path.join(runDirPath, rel)), false, `${rel} must not exist`);
  }
}

test('generic work-item-to-pr graph consumes one normalized boundary for Plane, Jira, and GitHub Issues fixtures', () => {
  for (const entry of providers) {
    const { runId, dir, projectContext } = startMockRun({ provider: entry.provider, fixtureName: entry.fixture, itemId: entry.itemId });

    step(dir);
    const item = readJson(path.join(dir, 'work-tracker', 'item.json'));
    assert.equal(item.schema_version, 1);
    assert.equal(item.provider, entry.provider);
    assert.equal(item.project.id, projectContext.project_id);
    assert.equal(item.identifier, entry.itemId);
    assert.equal(item.title, 'Mock work item');
    assert.equal(item.description, 'Mock dry-run work item');
    assert.equal(item.state.name, 'Mock');
    assert.equal(item.priority, 'none');
    assert.deepEqual(item.assignees, []);
    assert.deepEqual(item.labels, [{ name: 'mock' }]);

    step(dir);
    assertNoFiles(dir, ['pr/pr.json', 'worktree/path.txt']);

    step(dir);
    const designPrompt = fs.readFileSync(path.join(dir, 'prompts', 'generated', 'design-3.md'), 'utf8');
    assert.match(designPrompt, /Normalized work item artifact/);
    assert.match(designPrompt, /identifier/);
    assert.doesNotMatch(designPrompt, /credential-ref|api-base-url|workspace-slug|project-id|project-key|WT6I_|private-sentinel/i);

    // Continue only through PR draft; the next state is create-pr, the first PR side-effect node.
    for (let i = 0; i < 4; i += 1) step(dir);
    const state = fs.readFileSync(path.join(dir, 'state.edn'), 'utf8');
    assert.match(state, /:state :create-pr/, `${runId} should stop with create-pr pending`);
    assert.equal(fs.existsSync(path.join(dir, 'pr', 'pr-title.txt')), true);
    assert.equal(fs.existsSync(path.join(dir, 'pr', 'pr-body.md')), true);
    assert.equal(fs.existsSync(path.join(dir, 'pr', 'pr.json')), false, 'mock bounded run must stop before PR artifact');

    const generated = fs.readdirSync(path.join(dir, 'prompts', 'generated'))
      .map((name) => fs.readFileSync(path.join(dir, 'prompts', 'generated', name), 'utf8'))
      .join('\n');
    assert.doesNotMatch(generated, /WT6I_[A-Z_]+TOKEN|private-sentinel|credential-ref|api-base-url|workspace-slug|project-key/i);
  }
});

test('missing tracker fails at the real fetch preflight before branch, agent, push, or PR effects', () => {
  const runId = 'generic-no-tracker';
  const projectContext = fixture('no-tracker-project.json');
  fs.rmSync(runDir(runId), { recursive: true, force: true });
  runCli([
    'start', workflow,
    '--run-id', runId,
    '--project-id', projectContext.project_id,
    '--project-context', JSON.stringify(projectContext),
    '--input', 'item-id=NO-TRACKER-1',
    '--input', 'repo-root=.',
    '--format', 'json'
  ]);
  const dir = runDir(runId);
  const result = step(dir, true);
  assert.equal(result.ok, false, 'real missing-tracker fetch should fail the node');
  const item = readJson(path.join(dir, 'work-tracker', 'item.json'));
  assert.equal(item.status, 'error');
  assert.equal(item.category, 'missing_tracker');
  const state = fs.readFileSync(path.join(dir, 'state.edn'), 'utf8');
  assert.match(state, /:status "failed"/);
  assert.match(state, /:state :fetch-work-item/);
  assertNoFiles(dir, [
    'worktree/path.txt',
    'design/status.json',
    'design/design.md',
    'execution/status-1.json',
    'pr/pr-title.txt',
    'pr/pr-body.md',
    'pr/pr.json'
  ]);
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  assert.match(events, /missing_tracker/);
  assert.doesNotMatch(events, /credential|Authorization|http|github\/create-pr|git\/ensure-branch/i);
});

test('GitHub Issues tracker selection stays distinct from GitHub PR transport and legacy Jira example remains present', () => {
  const project = fixture('github-issues-project.json');
  assert.equal(project.connections['work-tracker'].provider, 'github-issues');
  assert.equal(project.connections['work-tracker']['credential-ref'], 'env:WT6I_GITHUB_ISSUES_TRACKER_TOKEN');
  assert.equal(project.connections.github['credential-ref'], 'env:WT6I_GITHUB_PR_TOKEN');
  assert.notEqual(project.connections['work-tracker']['credential-ref'], project.connections.github['credential-ref']);
  const legacyJiraWorkflow = path.join(repoRoot, 'examples', 'jira-to-pr', 'workflow.edn');
  assert.equal(fs.existsSync(legacyJiraWorkflow), true);
  assert.equal(fs.existsSync(workflow), true);
  runCli(['lint', legacyJiraWorkflow, '--format', 'json']);
});

// Keep a small static regression around template data flow: agent prompts may
// point at the normalized artifact but must not interpolate the raw artifact or
// provider-specific remote scope fields directly into prompt text.
test('work-item prompt templates name only normalized allowlisted fields', () => {
  const promptDir = path.join(repoRoot, 'examples', 'work-item-to-pr', 'prompts');
  const templates = fs.readdirSync(promptDir).filter((name) => name.endsWith('.tmpl'));
  assert.ok(templates.length >= 6);
  for (const name of templates) {
    const text = fs.readFileSync(path.join(promptDir, name), 'utf8');
    for (const field of ['identifier', 'title', 'description', 'state.name', 'priority', 'assignees', 'labels', 'url']) {
      assert.match(text, new RegExp(field.replace('.', '\\.')));
    }
    assert.doesNotMatch(text, /{{\s*artifacts|{{\s*inputs\.(tracker|provider|credential)|remote\.(workspace_slug|project_id|project_key|repository)/);
  }
});
