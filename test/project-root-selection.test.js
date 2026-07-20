import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const workflowEdn = (name, title) => [
  '{:api-version "tesseraft.workflow/v1"',
  ' :kind :workflow',
  ` :metadata {:name "${name}" :title "${title}"}`,
  ' :initial :done',
  ' :states {:done {:type :terminal}}}'
].join('\n');

const writeWorkflow = (root, name, title) => {
  const dir = path.join(root, '.tesseraft', 'workflows', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflow.edn'), workflowEdn(name, title));
};

const cpResult = (args) => {
  try {
    return {
      out: JSON.parse(execFileSync('./bin/tesseraft', ['control-plane', ...args], { encoding: 'utf8', stdio: 'pipe' })),
      threw: false,
      stderr: ''
    };
  } catch (error) {
    return {
      out: JSON.parse(String(error.stdout || '{}')),
      threw: true,
      stderr: String(error.stderr || '')
    };
  }
};

test('implicit project discovery selects nearest ancestor descriptor from nested directory', () => {
  const tempParent = path.join(process.cwd(), '.agent-runs');
  fs.mkdirSync(tempParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempParent, 'nearest-project-descriptor-'));
  const outer = path.join(root, 'outer-project');
  const nested = path.join(outer, 'packages', 'inner-project');
  const start = path.join(nested, 'src', 'feature');
  const sibling = path.join(root, 'sibling-project');
  const home = path.join(root, 'fake-home');

  try {
    writeWorkflow(outer, 'outer-demo', 'Outer Demo');
    writeWorkflow(nested, 'inner-demo', 'Inner Demo');
    writeWorkflow(sibling, 'sibling-demo', 'Sibling Demo');
    writeWorkflow(home, 'home-demo', 'Home Demo');
    fs.mkdirSync(start, { recursive: true });

    fs.writeFileSync(path.join(outer, '.tesseraft', 'project.json'), JSON.stringify({
      schema_version: 1,
      project_id: 'outer-project',
      name: 'Outer Project',
      runs_root: 'runs',
      discovery: { workflow_roots: ['.tesseraft/workflows'] }
    }, null, 2));
    fs.writeFileSync(path.join(nested, '.tesseraft', 'project.json'), JSON.stringify({
      schema_version: 1,
      project_id: 'inner-project',
      name: 'Inner Project',
      runs_root: 'runs',
      discovery: { workflow_roots: ['.tesseraft/workflows'] }
    }, null, 2));
    fs.writeFileSync(path.join(sibling, '.tesseraft', 'project.json'), JSON.stringify({
      schema_version: 1,
      project_id: 'sibling-project',
      name: 'Sibling Project',
      runs_root: 'runs',
      discovery: { workflow_roots: ['.tesseraft/workflows'] }
    }, null, 2));
    fs.writeFileSync(path.join(home, '.tesseraft', 'project.json'), JSON.stringify({
      schema_version: 1,
      project_id: 'home-project',
      name: 'Home Project',
      runs_root: 'runs',
      discovery: { workflow_roots: ['.tesseraft/workflows'] }
    }, null, 2));

    const project = JSON.parse(execFileSync('./bin/tesseraft', [
      'control-plane',
      '--workspace-root', start,
      '--tesseraft-home', home,
      'project', 'default'
    ], { encoding: 'utf8' }));

    assert.equal(project.project_id, 'inner-project', 'nested start directory should resolve the nearest ancestor project descriptor');
    assert.equal(project.workspace_root, path.resolve(nested), 'descriptor parent should be reported as the canonical project root');
    assert.equal(project.source, 'descriptor', 'implicit discovery should report descriptor as the selected project source');
    assert.equal(project.runs_root, 'runs', 'runs_root should remain project-relative to the descriptor root');

    const workflows = JSON.parse(execFileSync('./bin/tesseraft', [
      'control-plane',
      '--workspace-root', start,
      '--tesseraft-home', home,
      'workflows'
    ], { encoding: 'utf8' })).workflows;
    const names = workflows.map((workflow) => workflow.name);

    assert.ok(names.includes('inner-demo'), `nearest descriptor project should discover inner-demo; got ${names.join(',')}`);
    assert.ok(!names.includes('outer-demo'), 'nearest nested descriptor must win over the outer descriptor');
    assert.ok(!names.includes('sibling-demo'), 'descriptor discovery must not inspect sibling repositories');
    assert.ok(!names.includes('home-demo'), 'descriptor discovery must not inspect the user home directory');
    assert.equal(workflows.find((workflow) => workflow.name === 'inner-demo')?.source, 'project');
    assert.ok(
      workflows.find((workflow) => workflow.name === 'inner-demo')?.path.startsWith('.tesseraft/workflows/inner-demo/'),
      `workflow path should be relative to selected project root; got ${workflows.find((workflow) => workflow.name === 'inner-demo')?.path}`
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('explicit project root without descriptor returns validation diagnostic instead of fallback', () => {
  const tempParent = path.join(process.cwd(), '.agent-runs');
  fs.mkdirSync(tempParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempParent, 'explicit-project-root-missing-descriptor-'));
  const invocation = path.join(root, 'invocation-workspace');
  const selected = path.join(root, 'selected-without-descriptor');

  try {
    writeWorkflow(invocation, 'fallback-demo', 'Fallback Demo');
    fs.mkdirSync(path.join(selected, '.tesseraft'), { recursive: true });

    const result = cpResult([
      '--workspace-root', invocation,
      '--project-root', selected,
      'workflows'
    ]);

    assert.equal(result.threw, true, 'explicit project root without .tesseraft/project.json must exit nonzero');
    assert.equal(result.out.status, 400, result.out);
    assert.equal(result.out.error?.code, 'invalid_project_descriptor', result.out);
    assert.match(result.out.error?.message || '', /project\.json|descriptor/i);
    assert.equal(result.out.error?.details?.project_root, path.resolve(selected));
    assert.equal(result.out.error?.details?.descriptor_path, path.join(path.resolve(selected), '.tesseraft', 'project.json'));
    assert.ok(!JSON.stringify(result.out).includes('fallback-demo'), 'error response must not include fallback workspace workflows');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('explicit local project root selects descriptor project instead of invocation workspace', () => {
  const tempParent = path.join(process.cwd(), '.agent-runs');
  fs.mkdirSync(tempParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempParent, 'explicit-project-root-'));
  const invocation = path.join(root, 'invocation-workspace');
  const selected = path.join(root, 'selected-project');

  try {
    writeWorkflow(invocation, 'invocation-demo', 'Invocation Demo');
    writeWorkflow(selected, 'selected-demo', 'Selected Demo');
    fs.writeFileSync(path.join(selected, '.tesseraft', 'project.json'), JSON.stringify({
      schema_version: 1,
      project_id: 'selected-root',
      name: 'Selected Root',
      runs_root: 'runs',
      discovery: { workflow_roots: ['.tesseraft/workflows'] }
    }, null, 2));

    const output = execFileSync('./bin/tesseraft', [
      'control-plane',
      '--workspace-root', invocation,
      '--project-root', selected,
      'workflows'
    ], { encoding: 'utf8' });
    const workflows = JSON.parse(output).workflows;
    const names = workflows.map((workflow) => workflow.name);

    assert.ok(names.includes('selected-demo'), `explicit project root should discover selected-demo; got ${names.join(',')}`);
    assert.ok(!names.includes('invocation-demo'), 'explicit project root must not use invocation workspace workflows');
    assert.equal(workflows.find((workflow) => workflow.name === 'selected-demo')?.source, 'project');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
