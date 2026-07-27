import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const bbJson = (script) => JSON.parse(execFileSync('bb', ['-e', script], { cwd: repoRoot, encoding: 'utf8' }));
const q = (value) => JSON.stringify(value);

const writeManifest = (root, projectId, connections) => {
  const dir = path.join(root, '.tesseraft', 'projects');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${projectId}.json`), JSON.stringify({
    project_id: projectId,
    name: projectId,
    workspace_root: root,
    runs_root: '.agent-runs',
    discovery: { 'workflow-roots': ['examples'] },
    connections
  }, null, 2));
};

test('WT4 work-tracker-diagnosis classifies the raw durable source into five distinct states', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt4-diagnosis-'));
  try {
    writeManifest(root, 'wt4-absent', {});
    const absent = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/work-tracker-diagnosis {:workspace-root ${q(root)}} "wt4-absent")))
`);
    assert.equal(absent.state, 'absent');
    assert.equal(absent.provider, null);
    assert.equal(absent.source, 'manifest');

    writeManifest(root, 'wt4-incomplete', {
      'work-tracker': { provider: 'plane', 'credential-ref': 'env:WT4_PLANE', config: { 'api-base-url': 'https://plane.example' } }
    });
    const incomplete = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/work-tracker-diagnosis {:workspace-root ${q(root)}} "wt4-incomplete")))
`);
    assert.equal(incomplete.state, 'incomplete');
    assert.equal(incomplete.provider, 'plane');
    assert.match(incomplete.message, /Missing work-tracker config fields/);

    writeManifest(root, 'wt4-invalid-provider', {
      'work-tracker': { provider: 'acme-unregistered', 'credential-ref': 'env:WT4_ACME', config: {} }
    });
    const invalidProvider = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/work-tracker-diagnosis {:workspace-root ${q(root)}} "wt4-invalid-provider")))
`);
    assert.equal(invalidProvider.state, 'invalid');
    assert.match(invalidProvider.message, /Unsupported work-tracker provider/);

    writeManifest(root, 'wt4-invalid-url', {
      'work-tracker': { provider: 'jira', 'credential-ref': 'env:WT4_JIRA', config: { 'base-url': 'not-a-url', 'project-key': 'WT4' } }
    });
    const invalidUrl = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/work-tracker-diagnosis {:workspace-root ${q(root)}} "wt4-invalid-url")))
`);
    assert.equal(invalidUrl.state, 'invalid');
    assert.match(invalidUrl.message, /base-url must be an http\(s\) URL/);

    writeManifest(root, 'wt4-unresolved-env', {
      'work-tracker': { provider: 'github-issues', 'credential-ref': 'env:WT4_UNSET_TOKEN_SENTINEL', config: { repository: 'owner/repo' } }
    });
    const unresolvedEnv = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/work-tracker-diagnosis {:workspace-root ${q(root)}} "wt4-unresolved-env")))
`);
    assert.equal(unresolvedEnv.state, 'unresolved');
    assert.equal(unresolvedEnv['credential-state'], 'absent');
    assert.match(unresolvedEnv.message, /owned by this project/);

    writeManifest(root, 'wt4-unresolved-ci', {
      'work-tracker': { provider: 'github-issues', 'credential-ref': 'github-actions:secrets.WT4_TOKEN', config: { repository: 'owner/repo' } }
    });
    const unresolvedCi = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/work-tracker-diagnosis {:workspace-root ${q(root)}} "wt4-unresolved-ci")))
`);
    assert.equal(unresolvedCi.state, 'unresolved');

    writeManifest(root, 'wt4-ready', {
      'work-tracker': { provider: 'plane', 'credential-ref': 'env:WT4_PLANE_READY', config: { 'api-base-url': 'https://plane.example', 'workspace-slug': 'ws', 'project-id': 'pid' } }
    });
    const ready = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/work-tracker-diagnosis {:workspace-root ${q(root)} :credential-resolver (fn [_ ref] {:present true :state "present" :value "WT4_READY_SECRET_SENTINEL"})} "wt4-ready")))
`);
    assert.equal(ready.state, 'ready');
    assert.equal(ready['credential-state'], 'present');
    assert.equal(ready.config, undefined, 'diagnosis never returns config values');
    assert.doesNotMatch(JSON.stringify(ready), /WT4_READY_SECRET_SENTINEL/, 'diagnosis never returns a credential value');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WT4 work-tracker-diagnosis reports raw-secret-bearing trackers as invalid without leaking the secret', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt4-secret-'));
  try {
    writeManifest(root, 'wt4-raw-secret', {
      'work-tracker': { provider: 'plane', 'credential-ref': 'env:WT4_X', config: { 'api-base-url': 'https://plane.example', 'workspace-slug': 'ws', 'project-id': 'pid', nested: [{ access_token: 'WT4_RAW_SECRET_SENTINEL' }] } }
    });
    const diagnosed = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/work-tracker-diagnosis {:workspace-root ${q(root)}} "wt4-raw-secret")))
`);
    assert.equal(diagnosed.state, 'invalid');
    assert.doesNotMatch(JSON.stringify(diagnosed), /WT4_RAW_SECRET_SENTINEL/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WT4 doctor report adds two static work-tracker checks with correct status/state mapping and project isolation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt4-doctor-'));
  try {
    writeManifest(root, 'wt4-doc-a', {
      'work-tracker': { provider: 'jira', 'credential-ref': 'env:WT4_DOC_A', config: { 'base-url': 'https://jira.example', 'project-key': 'WT4' } }
    });
    writeManifest(root, 'wt4-doc-b', {});

    const doctorA = bbJson(`
(require '[tesseraft.control-plane.doctor :as doctor]) (require '[cheshire.core :as json])
(println (json/generate-string (doctor/doctor-report {:workspace-root ${q(root)} :credential-resolver (fn [_ ref] {:present true :state "present" :value "WT4_DOCTOR_SECRET_SENTINEL"})} "wt4-doc-a")))
`);
    assert.equal(doctorA.checks.length, 12);
    const configCheckA = doctorA.checks.find((c) => c.id === 'work-tracker-config');
    const credentialCheckA = doctorA.checks.find((c) => c.id === 'work-tracker-credential');
    assert.ok(configCheckA && credentialCheckA, 'both tracker checks are present');
    assert.equal(configCheckA.mode, 'static');
    assert.equal(credentialCheckA.mode, 'static');
    assert.equal(configCheckA.state, 'ready');
    assert.equal(configCheckA.status, 'ready');
    assert.equal(doctorA.work_tracker.state, 'ready');
    assert.equal(doctorA.work_tracker.provider, 'jira');
    assert.equal(doctorA.work_tracker.source, 'manifest');
    assert.doesNotMatch(JSON.stringify(doctorA), /WT4_DOCTOR_SECRET_SENTINEL/, 'resolved tracker credential is scrubbed from doctor JSON');

    const doctorB = bbJson(`
(require '[tesseraft.control-plane.doctor :as doctor]) (require '[cheshire.core :as json])
(println (json/generate-string (doctor/doctor-report {:workspace-root ${q(root)}} "wt4-doc-b")))
`);
    const configCheckB = doctorB.checks.find((c) => c.id === 'work-tracker-config');
    assert.equal(configCheckB.state, 'absent');
    assert.equal(configCheckB.status, 'not-configured');
    assert.equal(doctorB.work_tracker.state, 'absent');
    assert.equal(doctorB.work_tracker.provider, null, "project B's tracker diagnosis is independent of project A");

    // wt4-doc-c: invalid config (missing jira project-key), but a
    // credential-ref that resolves. The two checks must diverge in the
    // opposite direction from wt4-doc-a's unresolved-credential case,
    // proving work-tracker-config and work-tracker-credential are not
    // clones of the same combined diagnosis (WT4-R1-02).
    writeManifest(root, 'wt4-doc-c', {
      'work-tracker': { provider: 'jira', 'credential-ref': 'env:WT4_DOC_C', config: { 'base-url': 'https://jira.example' } }
    });
    const doctorC = bbJson(`
(require '[tesseraft.control-plane.doctor :as doctor]) (require '[cheshire.core :as json])
(println (json/generate-string (doctor/doctor-report {:workspace-root ${q(root)} :credential-resolver (fn [_ ref] {:present true :state "present" :value "WT4_DOCTOR_SECRET_SENTINEL"})} "wt4-doc-c")))
`);
    const configCheckC = doctorC.checks.find((c) => c.id === 'work-tracker-config');
    const credentialCheckC = doctorC.checks.find((c) => c.id === 'work-tracker-credential');
    assert.equal(configCheckC.state, 'incomplete');
    assert.equal(configCheckC.status, 'invalid');
    assert.match(configCheckC.summary, /Missing work-tracker config fields/);
    assert.equal(credentialCheckC.state, 'ready');
    assert.equal(credentialCheckC.status, 'ready');
    assert.notEqual(configCheckC.summary, credentialCheckC.summary, 'the two checks report distinct concerns');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WT4 doctor status mapping treats incomplete/invalid as invalid and absent/unresolved as non-failure not-configured', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt4-mapping-'));
  try {
    writeManifest(root, 'wt4-map-incomplete', {
      'work-tracker': { provider: 'github-issues', 'credential-ref': 'env:WT4_MAP', config: {} }
    });
    writeManifest(root, 'wt4-map-unresolved', {
      'work-tracker': { provider: 'github-issues', 'credential-ref': 'env:WT4_MAP_UNSET_SENTINEL', config: { repository: 'owner/repo' } }
    });

    const incompleteDoctor = bbJson(`
(require '[tesseraft.control-plane.doctor :as doctor]) (require '[cheshire.core :as json])
(println (json/generate-string (doctor/doctor-report {:workspace-root ${q(root)}} "wt4-map-incomplete")))
`);
    const incompleteCheck = incompleteDoctor.checks.find((c) => c.id === 'work-tracker-config');
    const incompleteCredentialCheck = incompleteDoctor.checks.find((c) => c.id === 'work-tracker-credential');
    assert.equal(incompleteCheck.state, 'incomplete');
    assert.equal(incompleteCheck.status, 'invalid');
    // The credential-ref itself is syntactically valid here, so the
    // credential check classifies independently of the config's missing
    // `repository` field.
    assert.equal(incompleteCredentialCheck.state, 'unresolved');
    assert.equal(incompleteCredentialCheck.status, 'not-configured');

    const unresolvedDoctor = bbJson(`
(require '[tesseraft.control-plane.doctor :as doctor]) (require '[cheshire.core :as json])
(println (json/generate-string (doctor/doctor-report {:workspace-root ${q(root)}} "wt4-map-unresolved")))
`);
    // The config/provider is fully valid here (registered provider, all
    // required fields present); only the credential-ref fails to resolve.
    // `unresolved` is therefore a credential-only concern: work-tracker-config
    // must report `ready` and work-tracker-credential must report `unresolved`
    // -- the two checks must NOT be clones of each other (WT4-R1-02).
    const unresolvedConfigCheck = unresolvedDoctor.checks.find((c) => c.id === 'work-tracker-config');
    const unresolvedCredentialCheck = unresolvedDoctor.checks.find((c) => c.id === 'work-tracker-credential');
    assert.equal(unresolvedConfigCheck.state, 'ready');
    assert.equal(unresolvedConfigCheck.status, 'ready');
    assert.equal(unresolvedCredentialCheck.state, 'unresolved');
    assert.equal(unresolvedCredentialCheck.status, 'not-configured', 'unresolved is an explicit non-failure state');
    assert.notEqual(unresolvedConfigCheck.summary, unresolvedCredentialCheck.summary, 'the two checks report distinct concerns');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WT4 doctor report diagnoses a project whose workspace_root differs from the control workspace root (WT4-R1-01)', () => {
  const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt4-cw-'));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt4-pw-'));
  try {
    writeManifest(controlRoot, 'wt4-cross-root', {
      'work-tracker': { provider: 'jira', 'credential-ref': 'env:WT4_CROSS_ROOT_SENTINEL', config: { 'base-url': 'https://jira.example', 'project-key': 'WT4' } }
    });
    // Point the manifest's workspace_root at a *different* directory from the
    // control workspace root passed to bb below, matching the reported repro:
    // the legacy manifest that backs work-tracker-diagnosis always lives
    // under `<control workspace-root>/.tesseraft/projects/<id>.json`, not
    // under the project's own workspace_root.
    const manifestPath = path.join(controlRoot, '.tesseraft', 'projects', 'wt4-cross-root.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.workspace_root = projectRoot;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const diagnosis = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/work-tracker-diagnosis {:workspace-root ${q(controlRoot)}} "wt4-cross-root")))
`);
    assert.equal(diagnosis.state, 'unresolved', 'work-tracker-diagnosis finds the tracker at the control-scoped manifest path');
    assert.equal(diagnosis.provider, 'jira');

    const doctor = bbJson(`
(require '[tesseraft.control-plane.doctor :as doctor]) (require '[cheshire.core :as json])
(println (json/generate-string (doctor/doctor-report {:workspace-root ${q(controlRoot)}} "wt4-cross-root")))
`);
    assert.equal(doctor.work_tracker.state, 'unresolved', 'doctor must not lose the tracker when project workspace_root differs from the control workspace root');
    assert.equal(doctor.work_tracker.provider, 'jira');
    const credentialCheck = doctor.checks.find((c) => c.id === 'work-tracker-credential');
    assert.equal(credentialCheck.state, 'unresolved');
  } finally {
    fs.rmSync(controlRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('WT4 work-tracker-diagnosis reports an unreadable durable source as invalid, not absent (WT4-R1-04)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-wt4-unreadable-'));
  try {
    const dir = path.join(root, '.tesseraft', 'projects');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'wt4-corrupt.json'), '{not valid json');

    const diagnosed = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/work-tracker-diagnosis {:workspace-root ${q(root)}} "wt4-corrupt")))
`);
    assert.equal(diagnosed.state, 'invalid');
    assert.match(diagnosed.message, /not readable JSON/);

    const configDiagnosed = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/work-tracker-config-diagnosis {:workspace-root ${q(root)}} "wt4-corrupt")))
`);
    assert.equal(configDiagnosed.state, 'invalid');
    const credentialDiagnosed = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/work-tracker-credential-diagnosis {:workspace-root ${q(root)}} "wt4-corrupt")))
`);
    assert.equal(credentialDiagnosed.state, 'invalid');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WT4 work-tracker-providers exposes Plane/Jira/GitHub Issues field metadata in a stable order with no credential values', () => {
  const cliResult = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(println (json/generate-string (cp/list-work-tracker-providers)))
`);
  assert.deepEqual(cliResult.providers.map((p) => p.provider), ['github-issues', 'jira', 'plane']);
  const plane = cliResult.providers.find((p) => p.provider === 'plane');
  assert.deepEqual(plane.fields.map((f) => f.name), ['api-base-url', 'workspace-slug', 'project-id']);
  assert.ok(plane.fields.every((f) => f.required === true));
  assert.equal(plane.credential_ref.required, true);
  assert.doesNotMatch(JSON.stringify(cliResult), /credential.?value|token|secret/i);

  const cliArgsResult = JSON.parse(execFileSync('bb', ['-e', '(require (quote [tesseraft.control-plane.cli :as cli]) (quote [cheshire.core :as json])) (println (json/generate-string (cli/project-command {:workspace-root "."} ["work-tracker-providers"])))'], { cwd: repoRoot, encoding: 'utf8' }));
  assert.deepEqual(cliArgsResult.providers.map((p) => p.provider), ['github-issues', 'jira', 'plane']);

  const registered = bbJson(`
(require '[tesseraft.control-plane.core :as cp]) (require '[cheshire.core :as json])
(cp/register-work-tracker-provider! "wt4-acme-tracker" {:required #{:project} :optional #{:metadata}})
(println (json/generate-string (cp/list-work-tracker-providers)))
`);
  const acme = registered.providers.find((p) => p.provider === 'wt4-acme-tracker');
  assert.ok(acme, 'runtime-registered package providers appear in the listing');
  assert.deepEqual(acme.fields.map((f) => f.name).sort(), ['metadata', 'project']);
});
