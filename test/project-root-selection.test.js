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
