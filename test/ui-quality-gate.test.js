import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const waitForServerUrl = (child) => new Promise((resolve, reject) => {
  let output = '';
  const timer = setTimeout(() => reject(new Error(`server URL timeout: ${output}`)), 10000);
  const onData = (chunk) => {
    output += chunk.toString();
    const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) {
      clearTimeout(timer);
      resolve(match[0]);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.once('exit', (code) => {
    clearTimeout(timer);
    reject(new Error(`server exited before URL with ${code}: ${output}`));
  });
});

test('rendered UI gate captures required states and rejects clipping/width waste', { timeout: 90000 }, async (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseraft-ui-quality-'));
  const server = spawn(process.execPath, ['web/server.js', '--host', '127.0.0.1', '--port', '0'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TESSERAFT_PI_ADAPTER: 'fake' }
  });
  t.after(() => {
    if (!server.killed) server.kill('SIGTERM');
    fs.rmSync(runDir, { recursive: true, force: true });
  });
  const url = await waitForServerUrl(server);
  const raw = execFileSync(process.execPath, [
    'examples/review-loop/scripts/ui_quality_gate.mjs',
    '--url', url, '--run-dir', runDir, '--worktree-root', process.cwd(), '--round', '1'
  ], { cwd: process.cwd(), encoding: 'utf8', timeout: 60000 });
  const result = JSON.parse(raw);
  assert.equal(result.status, 'pass', raw);

  const evidence = JSON.parse(fs.readFileSync(path.join(runDir, result.evidence_file), 'utf8'));
  const requiredChecks = ['desktop-screenshot', 'compact-screenshot', 'mobile-screenshot', 'overlay-open-screenshot', 'settings-width-utilization', 'classic-dark-navigation', 'matrix-theme', 'matrix-controls', 'console-clean', 'primary-task'];
  assert.deepEqual(requiredChecks.filter((id) => !evidence.checks.some((entry) => entry.id === id && entry.passed)), []);
  assert.equal(evidence.geometry.project_menu.visible, true);
  assert.equal(evidence.geometry.project_menu.within_viewport, true);
  assert.equal(evidence.geometry.project_menu.pointer_target, true);
  assert.deepEqual(evidence.geometry.project_menu.clipping_ancestors, []);
  assert.ok(evidence.geometry.settings_desktop.width_utilization >= 0.75, evidence.geometry.settings_desktop);
  assert.equal(evidence.geometry.classic_dark_navigation.prefers_dark, true);
  assert.equal(evidence.geometry.classic_dark_navigation.readable, true);
  assert.equal(evidence.geometry.matrix_theme.root_scheme, 'matrix');
  assert.equal(evidence.geometry.matrix_theme.app_scheme, 'matrix');
  assert.equal(evidence.geometry.matrix_theme.near_black, true);
  assert.equal(evidence.geometry.matrix_theme.green_foreground, true);
  assert.equal(evidence.geometry.matrix_controls.wizard.readable, true);
  assert.ok(evidence.geometry.matrix_controls.wizard.controls.some((control) => control.selector === '.wizard-fill .required' && control.visible && control.contrast >= 4.5));
  assert.equal(evidence.geometry.matrix_controls.studio.readable, true);
  assert.ok(evidence.geometry.matrix_controls.studio.controls.some((control) => control.selector === '.lint-list li.lint-error' && control.visible && control.contrast >= 4.5));
  assert.equal(evidence.geometry.matrix_controls.readable, true);
  assert.equal(evidence.geometry.settings_mobile.horizontal_overflow, false);
  assert.deepEqual(evidence.findings, []);
  assert.equal(evidence.browser.agent_browser_version, 'agent-browser 0.32.0');
  assert.ok(evidence.browser.executable_strategy);
  assert.ok(evidence.browser.command_timeout_ms > 0);
  assert.deepEqual(evidence.screenshots.map((shot) => shot.id), [
    'desktop', 'desktop-project-menu-open', 'desktop-settings', 'compact-settings', 'mobile-settings'
  ]);
  for (const shot of evidence.screenshots) {
    const bytes = fs.readFileSync(path.join(runDir, shot.path));
    assert.ok(bytes.length > 1000, `${shot.id} screenshot is unexpectedly small`);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }
});
