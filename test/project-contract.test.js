import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

const isIgnored = (relativePath) => {
  try {
    execFileSync('git', ['check-ignore', relativePath], { cwd: repoRoot, stdio: 'pipe' });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
};

test('portable project descriptor is versionable while local Tesseraft state stays ignored', () => {
  assert.equal(isIgnored('.tesseraft/project.json'), false, 'repository-owned portable descriptor must be committable');
  assert.equal(isIgnored('.tesseraft/projects/local.json'), true, 'legacy/local project state remains ignored');
  assert.equal(isIgnored('.tesseraft/credentials.json'), true, 'local credentials remain ignored');
  assert.equal(isIgnored('.tesseraft/runs/example/state.edn'), true, 'local run state remains ignored');
});

test('portable descriptor and user-local registry schemas publish separate ownership contracts', () => {
  const descriptorSchemaPath = path.join(repoRoot, 'schemas', 'portable-project-descriptor.schema.json');
  const registrySchemaPath = path.join(repoRoot, 'schemas', 'user-project-registry.schema.json');
  assert.equal(fs.existsSync(descriptorSchemaPath), true, 'portable descriptor schema must exist');
  assert.equal(fs.existsSync(registrySchemaPath), true, 'user-local registry schema must exist');

  const descriptorSchema = JSON.parse(fs.readFileSync(descriptorSchemaPath, 'utf8'));
  const registrySchema = JSON.parse(fs.readFileSync(registrySchemaPath, 'utf8'));

  assert.deepEqual(descriptorSchema.required, ['version', 'project_id'], 'portable descriptor requires versioned identity only');
  assert.equal(descriptorSchema.properties.workspace_root, undefined, 'portable descriptor must not define machine-specific workspace_root');
  assert.equal(descriptorSchema.additionalProperties, false, 'portable descriptor rejects unknown machine-local fields');
  assert.deepEqual(registrySchema.required, ['version', 'projects'], 'user registry requires version and projects map');
  assert.ok(registrySchema.properties.projects?.additionalProperties?.required?.includes('workspace_root'), 'registry entries own machine-local workspace roots');
  assert.equal(registrySchema.properties.projects.additionalProperties.properties.workspace_root.minLength, 1, 'registry workspace_root must be nonblank');

  const producedRegistry = {
    version: 1,
    projects: {
      'schema-produced': {
        name: 'Schema Produced',
        workspace_root: path.join(repoRoot, '.agent-runs', 'schema-produced-root'),
        runs_root: 'runs',
        discovery: { 'workflow-roots': ['.tesseraft/workflows'] },
        source: 'registration'
      }
    }
  };
  const entrySchema = registrySchema.properties.projects.additionalProperties;
  const entry = producedRegistry.projects['schema-produced'];
  assert.equal(producedRegistry.version, registrySchema.properties.version.const, 'produced registry declares the published version');
  assert.deepEqual(Object.keys(producedRegistry).sort(), ['projects', 'version'], 'produced registry has only schema fields');
  assert.deepEqual(Object.keys(entry).sort(), Object.keys(entrySchema.properties).sort(), 'produced registry entry uses only schema-owned fields');
  assert.equal(entry.workspace_root.length >= entrySchema.properties.workspace_root.minLength, true, 'produced registry entry has a nonblank root');
  assert.equal(entry.connections, undefined, 'produced registry entry must not include descriptor-owned connections');
});
