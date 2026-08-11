import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const q = JSON.stringify;

const bb = (form) => JSON.parse(execFileSync('bb', ['-e', form], {
  cwd: repoRoot,
  encoding: 'utf8'
}));

const invoke = (form) => {
  try { return { value: bb(form), threw: false }; }
  catch (error) { return { value: JSON.parse(String(error.stdout || '{}')), threw: true }; }
};

const writeDescriptor = (root, id, extra = {}) => {
  fs.mkdirSync(path.join(root, '.tesseraft'), { recursive: true });
  fs.writeFileSync(path.join(root, '.tesseraft', 'project.json'), JSON.stringify({
    version: 2,
    project_id: id,
    name: id,
    runs_root: 'runs',
    discovery: { workflow_roots: ['.tesseraft/workflows'] },
    ...extra
  }, null, 2));
};

const writeRegistry = (home, projects) => {
  fs.mkdirSync(path.join(home, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(home, 'projects', 'registry.json'), JSON.stringify({ version: 2, projects }, null, 2));
};

test('v2 registry rejects blank roots without rewriting durable bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-v2-registry-invalid-'));
  const home = path.join(root, 'home');
  writeRegistry(home, { alpha: { workspace_root: '   ' } });
  const registryPath = path.join(home, 'projects', 'registry.json');
  const before = fs.readFileSync(registryPath, 'utf8');
  const result = bb(`
(require '[cheshire.core :as json])
(require '[tesseraft.control-plane.core :as cp])
(try (cp/read-project-registry {:tesseraft-home ${q(home)}})
     (catch clojure.lang.ExceptionInfo e
       (println (json/generate-string {:code (name (:code (ex-data e))) :message (.getMessage e)}))))`);
  assert.equal(result.code, 'invalid-project-registry');
  assert.match(result.message, /workspace_root/);
  assert.equal(fs.readFileSync(registryPath, 'utf8'), before);
});

test('register and unregister use descriptor identity and mutate only registry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-v2-register-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'alpha');
  writeDescriptor(project, 'alpha', { name: 'Alpha' });
  const descriptorBefore = fs.readFileSync(path.join(project, '.tesseraft', 'project.json'), 'utf8');

  const registered = bb(`
(require '[cheshire.core :as json])
(require '[tesseraft.control-plane.core :as cp])
(println (json/generate-string (cp/create-project {:workspace-root ${q(root)} :tesseraft-home ${q(home)}} "alpha"
  {:workspace_root ${q(project)} :source "registration"})))`);
  assert.equal(registered.project_id, 'alpha');
  assert.equal(registered.workspace_root, path.resolve(project));
  assert.equal(registered.source, 'registration');
  const registry = JSON.parse(fs.readFileSync(path.join(home, 'projects', 'registry.json'), 'utf8'));
  assert.deepEqual(registry, { version: 2, projects: { alpha: { workspace_root: path.resolve(project) } } });
  assert.equal(fs.readFileSync(path.join(project, '.tesseraft', 'project.json'), 'utf8'), descriptorBefore);

  const removed = bb(`
(require '[cheshire.core :as json])
(require '[tesseraft.control-plane.core :as cp])
(println (json/generate-string (cp/unregister-project {:tesseraft-home ${q(home)}} "alpha")))`);
  assert.equal(removed.deleted, true);
  assert.equal(fs.existsSync(path.join(project, '.tesseraft', 'project.json')), true, 'unregister must preserve repository descriptor');
});

test('stale registrations fail closed and do not search for replacement roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-v2-stale-'));
  const home = path.join(root, 'home');
  writeRegistry(home, { alpha: { workspace_root: path.join(root, 'missing') } });
  const result = bb(`
(require '[cheshire.core :as json])
(require '[tesseraft.control-plane.core :as cp])
(println (json/generate-string (cp/resolve-project {:workspace-root ${q(root)} :tesseraft-home ${q(home)}} "alpha")))`);
  assert.equal(result.status, 409);
  assert.equal(result.error.code, 'stale_project_root');
  assert.equal(result.error.details.searched_for_replacement, false);
});

test('registry and descriptor identity mismatch fails closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-v2-conflict-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  writeDescriptor(project, 'beta');
  writeRegistry(home, { alpha: { workspace_root: project } });
  const result = bb(`
(require '[cheshire.core :as json])
(require '[tesseraft.control-plane.core :as cp])
(println (json/generate-string (cp/resolve-project {:workspace-root ${q(root)} :tesseraft-home ${q(home)}} "alpha")))`);
  assert.equal(result.status, 409);
  assert.equal(result.error.code, 'project_identity_conflict');
  assert.equal(result.error.details.descriptor_project_id, 'beta');
});

test('project update writes the v2 descriptor and never creates a shadow manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-v2-update-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'alpha');
  writeDescriptor(project, 'alpha');
  writeRegistry(home, { alpha: { workspace_root: project } });
  const updated = bb(`
(require '[cheshire.core :as json])
(require '[tesseraft.control-plane.core :as cp])
(println (json/generate-string (cp/update-project {:workspace-root ${q(root)} :tesseraft-home ${q(home)}} "alpha"
  {:name "Alpha Updated" :connections {:work-tracker {:provider "plane" :credential-ref "env:PLANE_TOKEN"
    :config {:api-base-url "https://plane.example" :workspace-slug "ws" :project-id "p"}}}})))`);
  assert.equal(updated.name, 'Alpha Updated');
  assert.equal(updated.connections['work-tracker'].provider, 'plane');
  const descriptor = JSON.parse(fs.readFileSync(path.join(project, '.tesseraft', 'project.json'), 'utf8'));
  assert.equal(descriptor.version, 2);
  assert.equal(descriptor.name, 'Alpha Updated');
  assert.equal(fs.existsSync(path.join(root, '.tesseraft', 'projects', 'alpha.json')), false);
});

test('two registered projects remain isolated for resolution and run roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-v2-isolation-'));
  const home = path.join(root, 'home');
  const alpha = path.join(root, 'alpha');
  const beta = path.join(root, 'beta');
  writeDescriptor(alpha, 'alpha', { runs_root: 'alpha-runs' });
  writeDescriptor(beta, 'beta', { runs_root: 'beta-runs' });
  writeRegistry(home, { alpha: { workspace_root: alpha }, beta: { workspace_root: beta } });
  const result = bb(`
(require '[cheshire.core :as json])
(require '[tesseraft.control-plane.core :as cp])
(let [o {:workspace-root ${q(root)} :tesseraft-home ${q(home)}}]
  (println (json/generate-string {:alpha (cp/project-scoped-opts o "alpha")
                                  :beta (cp/project-scoped-opts o "beta")})))`);
  assert.equal(result.alpha['workspace-root'], path.resolve(alpha));
  assert.equal(result.beta['workspace-root'], path.resolve(beta));
  assert.equal(result.alpha['runs-root'], 'alpha-runs');
  assert.equal(result.beta['runs-root'], 'beta-runs');
});
