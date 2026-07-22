import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();

function cp(args) {
  return JSON.parse(execFileSync('bb', ['-m', 'tesseraft.control-plane.cli', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }));
}

function mode(pathname) {
  return fs.statSync(pathname).mode & 0o777;
}

test('SC-005 migrates flat legacy local credentials without mutating source and is repeatable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-sc005-'));
  const home = path.join(root, 'home');
  const legacy = path.join(root, 'legacy-credentials.json');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ 'github/main': 'sc005-github', 'jira/main': 'sc005-jira' }, null, 2));
  const legacyBefore = fs.readFileSync(legacy, 'utf8');

  const first = cp(['--tesseraft-home', home, 'credentials', 'migrate', '--legacy-file', legacy]);
  assert.equal(first.status, 201);
  assert.equal(first.state, 'migrated');
  assert.equal(first.credentials_count, 2);
  assert.equal(first.credentials_file, path.join(home, 'credentials.json'));
  assert.equal(fs.readFileSync(legacy, 'utf8'), legacyBefore, 'legacy source bytes must be preserved');

  const dest = path.join(home, 'credentials.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(dest, 'utf8')), {
    version: 1,
    credentials: { 'github/main': 'sc005-github', 'jira/main': 'sc005-jira' }
  });
  if (process.platform !== 'win32') assert.equal(mode(dest), 0o600, 'destination must be owner-only when POSIX permissions are available');

  const destBefore = fs.readFileSync(dest, 'utf8');
  const repeat = cp(['--tesseraft-home', home, 'credentials', 'migrate', '--legacy-file', legacy]);
  assert.equal(repeat.status, 200);
  assert.equal(repeat.state, 'unchanged');
  assert.equal(fs.readFileSync(legacy, 'utf8'), legacyBefore, 'repeat migration must preserve legacy source bytes');
  assert.equal(fs.readFileSync(dest, 'utf8'), destBefore, 'repeat migration must not rewrite an identical destination');
});

test('SC-005 local credential migration preserves source bytes when destination writing fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-sc005-write-failure-'));
  const blockedHome = path.join(root, 'blocked-home');
  const legacy = path.join(root, 'legacy.json');
  fs.writeFileSync(blockedHome, 'not a directory');
  fs.writeFileSync(legacy, JSON.stringify({ token: 'write-failure-sentinel' }));
  const legacyBefore = fs.readFileSync(legacy, 'utf8');

  let writeFailure;
  try {
    cp(['--tesseraft-home', blockedHome, 'credentials', 'migrate', '--legacy-file', legacy]);
  } catch (error) {
    writeFailure = JSON.parse(String(error.stdout));
  }
  assert.equal(writeFailure?.error?.code, 'migration_failed');
  assert.equal(fs.readFileSync(legacy, 'utf8'), legacyBefore, 'write failure must preserve legacy source bytes');
  assert.equal(fs.existsSync(path.join(blockedHome, 'credentials.json')), false, 'write failure must not create destination data');
});

test('SC-005 local credential migration refuses invalid legacy input and destination conflicts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-sc005-invalid-'));
  const home = path.join(root, 'home');
  const invalidLegacy = path.join(root, 'invalid.json');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(invalidLegacy, JSON.stringify({ version: 1, credentials: { token: 'already-versioned' } }));

  let invalidFailure;
  try {
    cp(['--tesseraft-home', home, 'credentials', 'migrate', '--legacy-file', invalidLegacy]);
  } catch (error) {
    invalidFailure = JSON.parse(String(error.stdout));
  }
  assert.equal(invalidFailure?.error?.code, 'invalid_local_credential_store');
  assert.equal(fs.existsSync(path.join(home, 'credentials.json')), false, 'invalid input must not create a destination');

  const legacy = path.join(root, 'legacy.json');
  const dest = path.join(home, 'credentials.json');
  fs.writeFileSync(legacy, JSON.stringify({ token: 'new-value' }));
  fs.writeFileSync(dest, JSON.stringify({ version: 1, credentials: { token: 'existing-value' } }));
  const legacyBefore = fs.readFileSync(legacy, 'utf8');
  const destBefore = fs.readFileSync(dest, 'utf8');

  let conflictFailure;
  try {
    cp(['--tesseraft-home', home, 'credentials', 'migrate', '--legacy-file', legacy]);
  } catch (error) {
    conflictFailure = JSON.parse(String(error.stdout));
  }
  assert.equal(conflictFailure?.error?.code, 'conflict');
  assert.equal(fs.readFileSync(legacy, 'utf8'), legacyBefore, 'conflict must preserve legacy source bytes');
  assert.equal(fs.readFileSync(dest, 'utf8'), destBefore, 'conflict must not overwrite destination');
});
