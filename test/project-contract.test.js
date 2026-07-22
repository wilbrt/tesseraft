import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();

const validateWithDraft202012 = (schema, instance) => {
  const payload = JSON.stringify({ schema, instance });
  const script = `
import json
import sys
from jsonschema import Draft202012Validator
payload = json.load(sys.stdin)
errors = sorted(Draft202012Validator(payload["schema"]).iter_errors(payload["instance"]), key=lambda error: list(error.path))
if errors:
    for error in errors:
        path = "/".join(str(part) for part in error.path)
        print(f"{path}: {error.message}")
    sys.exit(1)
`;
  try {
    execFileSync('python3', ['-c', script], { input: payload, encoding: 'utf8' });
    return { valid: true, output: '' };
  } catch (error) {
    return { valid: false, output: String(error.stdout || error.stderr || error.message) };
  }
};

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

  const producedValidation = validateWithDraft202012(registrySchema, producedRegistry);
  assert.equal(producedValidation.valid, true, `produced registry instance must validate against Draft 2020-12 schema: ${producedValidation.output}`);

  const whitespaceRootRegistry = {
    version: 1,
    projects: {
      'schema-produced': { workspace_root: '   ', source: 'registration' }
    }
  };
  const whitespaceValidation = validateWithDraft202012(registrySchema, whitespaceRootRegistry);
  assert.equal(whitespaceValidation.valid, false, 'Draft 2020-12 schema must reject whitespace-only registry workspace_root values');
});

test('SC-001 credential-ref schema accepts every supported store', () => {
  const schemaPath = path.join(repoRoot, 'schemas', 'credential-ref.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  for (const ref of ['env:GITHUB_TOKEN', 'tesseraft:github/main', 'github-actions:secrets.GITHUB_TOKEN']) {
    const validation = validateWithDraft202012(schema, ref);
    assert.equal(validation.valid, true, `credential-ref schema must accept ${ref}: ${validation.output}`);
  }
});

test('SC-003 project create/update reject nested raw-secret payloads before persistence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-sc003-project-writes-'));
  const manifestPath = path.join(root, '.tesseraft', 'projects', 'sc003-raw.json');
  const baseManifest = {
    project_id: 'sc003-raw',
    name: 'SC003 Raw Guard',
    workspace_root: root,
    runs_root: 'runs',
    discovery: { 'workflow-roots': ['examples'] },
    connections: { github: { 'credential-ref': 'env:SC003_SAFE_REF' } }
  };
  const runBb = (script) => execFileSync('bb', ['-e', script], { cwd: repoRoot, encoding: 'utf8' });
  try {
    const createOutput = runBb(`
(require '[tesseraft.control-plane.core :as cp])
(require '[cheshire.core :as json])
(let [result (cp/create-project {:workspace-root ${JSON.stringify(root)}} "raw-create" {:connections {:github {:metadata [{:access_token "SC003_CREATE_SECRET_SENTINEL"}]}}})]
  (println (json/generate-string result)))
`);
    const createResult = JSON.parse(createOutput);
    assert.equal(createResult.status, 400, `SC-003 create-project must reject nested access_token payloads: ${createOutput}`);
    assert.doesNotMatch(createOutput, /SC003_CREATE_SECRET_SENTINEL/);
    assert.equal(fs.existsSync(path.join(root, '.tesseraft', 'projects', 'raw-create.json')), false, 'rejected create must not persist a manifest');

    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const manifestBytes = JSON.stringify(baseManifest, null, 2);
    fs.writeFileSync(manifestPath, manifestBytes);
    const updateOutput = runBb(`
(require '[tesseraft.control-plane.core :as cp])
(require '[cheshire.core :as json])
(let [result (cp/update-project {:workspace-root ${JSON.stringify(root)}} "sc003-raw" {:connections {:jira {:credentials [{:api-key "SC003_UPDATE_API_KEY_SENTINEL" :Password "SC003_UPDATE_PASSWORD_SENTINEL"}]}}})]
  (println (json/generate-string result)))
`);
    const updateResult = JSON.parse(updateOutput);
    assert.equal(updateResult.status, 400, `SC-003 update-project must reject nested api-key/password payloads: ${updateOutput}`);
    assert.doesNotMatch(updateOutput, /SC003_UPDATE_API_KEY_SENTINEL|SC003_UPDATE_PASSWORD_SENTINEL/);
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestBytes, 'rejected update must leave existing manifest bytes unchanged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SC-005 local credential store publishes a versioned migration contract', () => {
  const credentialStoreSchemaPath = path.join(repoRoot, 'schemas', 'local-credential-store.schema.json');
  assert.equal(
    fs.existsSync(credentialStoreSchemaPath),
    true,
    'SC-005 local credential migration requires schemas/local-credential-store.schema.json'
  );

  const credentialStoreSchema = JSON.parse(fs.readFileSync(credentialStoreSchemaPath, 'utf8'));
  assert.equal(credentialStoreSchema.properties?.version?.const, 1, 'SC-005 local credential store schema must declare supported version 1');
  assert.ok(credentialStoreSchema.required?.includes('credentials'), 'SC-005 local credential store schema must require credentials');

  const producedStore = {
    version: 1,
    credentials: {
      'github/main': 'sc005-github-sentinel',
      'jira/main': 'sc005-jira-sentinel'
    }
  };
  const producedValidation = validateWithDraft202012(credentialStoreSchema, producedStore);
  assert.equal(
    producedValidation.valid,
    true,
    `SC-005 migrated credential store must validate as versioned credentials: ${producedValidation.output}`
  );
});
