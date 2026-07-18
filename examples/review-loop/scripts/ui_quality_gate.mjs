#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const parseArgs = (argv) => {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) values[arg.slice(2)] = argv[index + 1], index += 1;
  }
  return values;
};

const readStdin = async () => {
  if (process.stdin.isTTY) return null;
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.trim() ? JSON.parse(text) : null;
};

const cliArgs = parseArgs(process.argv.slice(2));
const request = await readStdin();
const run = request?.run || {};
const inputs = request?.inputs || {};
const runDir = path.resolve(cliArgs['run-dir'] || run.dir || '');
const worktreeRoot = path.resolve(cliArgs['worktree-root'] || run['worktree-dir'] || inputs['repo-root'] || '.');
const round = Number(cliArgs.round || run.round || 1);
const serverArtifact = path.join(runDir, 'manual-testing', `test-server-${round}.json`);
const targetUrl = cliArgs.url || JSON.parse(fs.readFileSync(serverArtifact, 'utf8')).url;
const session = `review-loop-ui-gate-${String(run.id || path.basename(runDir)).replace(/[^A-Za-z0-9_-]/g, '-')}-${round}`;
const screenshotDir = path.join(runDir, 'manual-testing', 'screenshots', `round-${round}`);
const evidencePath = path.join(runDir, 'manual-testing', `ui-evidence-${round}.json`);
const issuesPath = path.join(runDir, 'manual-testing', `ui-gate-issues-${round}.json`);
fs.mkdirSync(screenshotDir, { recursive: true });

const browserCandidates = [
  process.env.AGENT_BROWSER_BIN,
  path.join(worktreeRoot, 'node_modules', '.bin', 'agent-browser'),
  path.join(path.resolve(inputs['repo-root'] || worktreeRoot), 'node_modules', '.bin', 'agent-browser'),
  path.resolve(process.cwd(), 'node_modules', '.bin', 'agent-browser'),
  path.resolve(process.cwd(), '..', '..', 'node_modules', '.bin', 'agent-browser')
].filter(Boolean);
const browserBin = browserCandidates.find((candidate) => fs.existsSync(candidate));
if (!browserBin) throw new Error(`agent-browser was not found; checked: ${browserCandidates.join(', ')}`);

const macBrave = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const configuredBrowserExecutable = process.env.AGENT_BROWSER_EXECUTABLE_PATH;
const selectedBrowserExecutable = configuredBrowserExecutable
  || (process.platform === 'darwin' && fs.existsSync(macBrave) ? macBrave : null);
const executableStrategy = configuredBrowserExecutable
  ? 'environment'
  : selectedBrowserExecutable
    ? 'darwin-brave-fallback'
    : 'agent-browser-default';
const commandTimeoutMs = Number(process.env.TESSERAFT_UI_BROWSER_COMMAND_TIMEOUT_MS || 20000);
if (!Number.isFinite(commandTimeoutMs) || commandTimeoutMs <= 0) {
  throw new Error('TESSERAFT_UI_BROWSER_COMMAND_TIMEOUT_MS must be a positive number');
}

const versionOf = (command) => {
  if (!command) return null;
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 });
  return result.status === 0 ? (result.stdout || result.stderr || '').trim() : null;
};

const browserDiagnostics = {
  agent_browser_bin: browserBin,
  agent_browser_version: versionOf(browserBin),
  executable_strategy: executableStrategy,
  executable_path: selectedBrowserExecutable,
  executable_version: versionOf(selectedBrowserExecutable),
  command_timeout_ms: commandTimeoutMs,
  platform: `${process.platform}-${process.arch}`
};

const runBrowser = (args, { allowFailure = false } = {}) => {
  const launchOptions = selectedBrowserExecutable ? ['--executable-path', selectedBrowserExecutable] : [];
  const result = spawnSync(browserBin, ['--session', session, ...launchOptions, '--color-scheme', 'dark', ...args], {
    cwd: worktreeRoot,
    encoding: 'utf8',
    timeout: commandTimeoutMs,
    env: { ...process.env, NO_PROXY: [process.env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',') }
  });
  if (!allowFailure && result.status !== 0) {
    const detail = result.error?.message || (result.stderr || result.stdout || '').trim() || `status ${result.status}`;
    throw new Error(`agent-browser ${args.join(' ')} failed: ${detail}`);
  }
  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    error: result.error?.message || null
  };
};

const evalJson = (expression) => {
  const output = runBrowser(['eval', expression]).stdout;
  const parsed = JSON.parse(output);
  return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
};

const screenshot = (name, full = true) => {
  const file = path.join(screenshotDir, name);
  runBrowser(['screenshot', ...(full ? ['--full'] : []), file]);
  return path.relative(runDir, file);
};

const viewportGeometryExpression = `JSON.stringify((() => ({
  viewport: { width: window.innerWidth, height: window.innerHeight },
  horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  scroll_width: document.documentElement.scrollWidth,
  client_width: document.documentElement.clientWidth
}))())`;

const menuGeometryExpression = `JSON.stringify((() => {
  const menu = document.querySelector('[data-testid="project-selector-menu"]');
  if (!menu) return { visible: false, within_viewport: false, pointer_target: false, clipping_ancestors: ['missing-menu'] };
  const rect = menu.getBoundingClientRect();
  const clipping = [];
  for (let ancestor = menu.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (!['visible', 'clip'].includes(style.overflowX) || !['visible', 'clip'].includes(style.overflowY)) {
      const box = ancestor.getBoundingClientRect();
      if (rect.left < box.left || rect.right > box.right || rect.top < box.top || rect.bottom > box.bottom) clipping.push(ancestor.className || ancestor.tagName);
    }
  }
  const centerX = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
  const centerY = Math.max(0, Math.min(window.innerHeight - 1, rect.top + Math.min(rect.height / 2, 24)));
  const hit = document.elementFromPoint(centerX, centerY);
  return {
    visible: rect.width > 0 && rect.height > 0,
    within_viewport: rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
    pointer_target: Boolean(hit && menu.contains(hit)),
    clipping_ancestors: clipping,
    rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
  };
})())`;

const settingsGeometryExpression = `JSON.stringify((() => {
  const main = document.querySelector('main');
  const panel = document.querySelector('.settings-panel');
  if (!main || !panel) return { visible: false, width_utilization: 0, horizontal_overflow: true };
  const mainRect = main.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  return {
    visible: panelRect.width > 0 && panelRect.height > 0,
    main_width: mainRect.width,
    panel_width: panelRect.width,
    width_utilization: mainRect.width > 0 ? panelRect.width / mainRect.width : 0,
    unused_right_px: Math.max(0, mainRect.right - panelRect.right),
    horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
  };
})())`;

const contrastExpression = (selectors) => `JSON.stringify((() => {
  const rgb = (value) => (value.match(/\\d+(?:\\.\\d+)?/g) || []).slice(0, 3).map(Number);
  const luminance = (channels) => {
    const values = channels.map((channel) => channel / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
  };
  const opaqueBackground = (element) => {
    for (let current = element; current; current = current.parentElement) {
      const channels = (getComputedStyle(current).backgroundColor.match(/\\d+(?:\\.\\d+)?/g) || []).map(Number);
      if (channels.length >= 3 && (channels.length < 4 || channels[3] > 0)) return channels.slice(0, 3);
    }
    return [255, 255, 255];
  };
  const inspect = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return { selector, visible: false, contrast: 0 };
    const style = getComputedStyle(element);
    const foreground = rgb(style.color);
    const background = opaqueBackground(element);
    const lighter = Math.max(luminance(foreground), luminance(background));
    const darker = Math.min(luminance(foreground), luminance(background));
    return { selector, visible: element.getBoundingClientRect().width > 0, foreground, background, contrast: (lighter + 0.05) / (darker + 0.05) };
  };
  const controls = ${JSON.stringify(selectors)}.map(inspect);
  return { prefers_dark: matchMedia('(prefers-color-scheme: dark)').matches, controls, readable: controls.every((control) => control.visible && control.contrast >= 4.5) };
})())`;

const matrixThemeExpression = `JSON.stringify((() => {
  const rgb = (value) => (value.match(/\\d+(?:\\.\\d+)?/g) || []).slice(0, 3).map(Number);
  const root = document.documentElement;
  const panel = document.querySelector('.settings-panel');
  const save = document.querySelector('.settings-primary .settings-actions button');
  const background = rgb(getComputedStyle(root).backgroundColor);
  const panelBackground = panel ? rgb(getComputedStyle(panel).backgroundColor) : [];
  const text = panel ? rgb(getComputedStyle(panel).color) : [];
  const accent = save ? rgb(getComputedStyle(save).backgroundColor) : [];
  const nearBlack = (channels) => channels.length === 3 && Math.max(...channels) <= 24;
  const matrixGreen = (channels) => channels.length === 3 && channels[1] >= 140 && channels[1] > channels[0] && channels[1] > channels[2];
  return {
    root_scheme: root.dataset.colorScheme || null,
    app_scheme: document.querySelector('.app-shell')?.getAttribute('data-color-scheme') || null,
    background, panel_background: panelBackground, text, accent,
    near_black: nearBlack(background) && nearBlack(panelBackground),
    green_foreground: matrixGreen(text) && matrixGreen(accent)
  };
})())`;

const evidence = {
  version: 1,
  mode: 'executed',
  target_url: targetUrl,
  worktree_root: worktreeRoot,
  generated_at: new Date().toISOString(),
  browser: browserDiagnostics,
  screenshots: [],
  geometry: {},
  checks: [],
  console: { errors: '', messages: '' },
  findings: []
};

const check = (id, passed, details, screenshotPath = null) => {
  evidence.checks.push({ id, passed: Boolean(passed), details, ...(screenshotPath ? { screenshot: screenshotPath } : {}) });
  if (!passed) evidence.findings.push({
    source: 'ui-quality-gate', severity: 'major', category: 'usability', actionable: true,
    title: `UI quality check failed: ${id}`, details: typeof details === 'string' ? details : JSON.stringify(details),
    acceptance_criteria: `The deterministic ${id} check passes at its declared viewport.`, ...(screenshotPath ? { evidence: screenshotPath } : {})
  });
};

try {
  runBrowser(['open', targetUrl]);
  runBrowser(['wait', 'body']);

  runBrowser(['set', 'viewport', '1440', '900']);
  const desktopGeometry = evalJson(viewportGeometryExpression);
  const desktopShot = screenshot('desktop.png');
  evidence.screenshots.push({ id: 'desktop', width: 1440, height: 900, path: desktopShot, state: 'default' });
  evidence.geometry.desktop = desktopGeometry;
  check('desktop-screenshot', fs.statSync(path.join(runDir, desktopShot)).size > 0 && !desktopGeometry.horizontal_overflow, desktopGeometry, desktopShot);

  runBrowser(['click', '.project-selector-button']);
  runBrowser(['wait', '[data-testid="project-selector-menu"]']);
  const menuGeometry = evalJson(menuGeometryExpression);
  const menuShot = screenshot('desktop-project-menu-open.png', false);
  evidence.screenshots.push({ id: 'desktop-project-menu-open', width: 1440, height: 900, path: menuShot, state: 'project-menu-open' });
  evidence.geometry.project_menu = menuGeometry;
  check('overlay-open-screenshot', menuGeometry.visible && menuGeometry.within_viewport && menuGeometry.pointer_target && menuGeometry.clipping_ancestors.length === 0, menuGeometry, menuShot);
  runBrowser(['press', 'Escape']);

  runBrowser(['click', 'button[aria-label^="Settings:"]']);
  runBrowser(['wait', '.settings-panel']);
  runBrowser(['wait', '500']);
  runBrowser(['click', 'input[name="color-scheme"][value="classic"]']);
  runBrowser(['click', '.settings-primary .settings-actions button:first-child']);
  runBrowser(['wait', '.settings-panel .success']);
  runBrowser(['wait', 'html[data-color-scheme="classic"]']);
  runBrowser(['click', 'button[aria-label^="Workflows:"]']);
  const classicDarkNavigation = evalJson(contrastExpression(['.tabs button.active', '.tabs button.active span', '.project-selector-button', '.project-selector-caret']));
  evidence.geometry.classic_dark_navigation = classicDarkNavigation;
  check('classic-dark-navigation', classicDarkNavigation.prefers_dark && classicDarkNavigation.readable, classicDarkNavigation);

  runBrowser(['click', 'button[aria-label^="Settings:"]']);
  runBrowser(['wait', '.settings-panel']);
  runBrowser(['click', 'input[name="color-scheme"][value="matrix"]']);
  runBrowser(['click', '.settings-primary .settings-actions button:first-child']);
  runBrowser(['wait', '.settings-panel .success']);
  runBrowser(['wait', 'html[data-color-scheme="matrix"]']);
  const matrixTheme = evalJson(matrixThemeExpression);
  evidence.geometry.matrix_theme = matrixTheme;
  check('matrix-theme', matrixTheme.root_scheme === 'matrix' && matrixTheme.app_scheme === 'matrix' && matrixTheme.near_black && matrixTheme.green_foreground, matrixTheme);
  const settingsDesktop = evalJson(settingsGeometryExpression);
  const settingsShot = screenshot('desktop-settings.png');
  evidence.screenshots.push({ id: 'desktop-settings', width: 1440, height: 900, path: settingsShot, state: 'settings-matrix' });
  evidence.geometry.settings_desktop = settingsDesktop;
  check('settings-width-utilization', settingsDesktop.visible && settingsDesktop.width_utilization >= 0.75 && !settingsDesktop.horizontal_overflow, settingsDesktop, settingsShot);

  runBrowser(['set', 'viewport', '1024', '768']);
  const compactGeometry = evalJson(settingsGeometryExpression);
  const compactShot = screenshot('compact-settings.png');
  evidence.screenshots.push({ id: 'compact-settings', width: 1024, height: 768, path: compactShot, state: 'settings' });
  evidence.geometry.settings_compact = compactGeometry;
  check('compact-screenshot', compactGeometry.visible && compactGeometry.width_utilization >= 0.75 && !compactGeometry.horizontal_overflow, compactGeometry, compactShot);

  runBrowser(['set', 'viewport', '390', '844']);
  const mobileGeometry = evalJson(settingsGeometryExpression);
  const mobileShot = screenshot('mobile-settings.png');
  evidence.screenshots.push({ id: 'mobile-settings', width: 390, height: 844, path: mobileShot, state: 'settings' });
  evidence.geometry.settings_mobile = mobileGeometry;
  check('mobile-screenshot', mobileGeometry.visible && !mobileGeometry.horizontal_overflow, mobileGeometry, mobileShot);

  runBrowser(['set', 'viewport', '1440', '900']);
  runBrowser(['click', 'button[aria-label^="Runs:"]']);
  runBrowser(['click', '.header-start-button']);
  runBrowser(['wait', '.wizard-steps']);
  runBrowser(['click', '.wizard-workflow-list button']);
  runBrowser(['wait', '.wizard-fill .required']);
  const matrixWizardControls = evalJson(contrastExpression(['.project-selector-button', '.project-selector-caret', '.wizard-steps li[aria-current="true"]', '.wizard-steps li:not([aria-current="true"])', '.wizard-fill .required']));
  runBrowser(['click', '.wizard .modal-header button']);
  runBrowser(['click', 'button[aria-label^="Workflows:"]']);
  runBrowser(['wait', 'button[aria-label^="Edit "][aria-label$=" in Studio"]']);
  runBrowser(['click', 'button[aria-label^="Edit "][aria-label$=" in Studio"]']);
  runBrowser(['wait', '.studio-toolbar']);
  runBrowser(['eval', 'window.confirm = () => true']);
  runBrowser(['click', '.studio-toolbar button:nth-child(5)']);
  runBrowser(['click', '.studio-toolbar button:nth-child(3)']);
  runBrowser(['wait', '.lint-list li.lint-error']);
  const matrixStudioControls = evalJson(contrastExpression(['.studio-toolbar button:not(:disabled)', '.lint-list li.lint-error']));
  const matrixControls = {
    wizard: matrixWizardControls,
    studio: matrixStudioControls,
    readable: matrixWizardControls.readable && matrixStudioControls.readable
  };
  evidence.geometry.matrix_controls = matrixControls;
  check('matrix-controls', matrixControls.readable, matrixControls);

  evidence.console.errors = runBrowser(['errors'], { allowFailure: true }).stdout;
  evidence.console.messages = runBrowser(['console'], { allowFailure: true }).stdout;
  check('console-clean', evidence.console.errors.trim() === '', { errors: evidence.console.errors });
  check('primary-task', evidence.checks.filter((item) => ['overlay-open-screenshot', 'settings-width-utilization', 'classic-dark-navigation', 'matrix-theme', 'matrix-controls'].includes(item.id)).every((item) => item.passed), { exercised: ['open project selector', 'select Classic under system dark mode', 'select and save Matrix color scheme', 'open workflow wizard required-input state', 'open Workflow Studio and render an invalid lint result'] });
} catch (error) {
  evidence.findings.push({
    source: 'ui-quality-gate', severity: 'blocker', category: 'setup', actionable: true,
    title: 'Deterministic browser quality gate could not complete', details: error instanceof Error ? error.message : String(error),
    acceptance_criteria: 'The worktree-rooted browser gate completes and produces every required screenshot and geometry check.'
  });
} finally {
  runBrowser(['close'], { allowFailure: true });
}

const requiredChecks = ['desktop-screenshot', 'compact-screenshot', 'mobile-screenshot', 'overlay-open-screenshot', 'settings-width-utilization', 'classic-dark-navigation', 'matrix-theme', 'matrix-controls', 'console-clean', 'primary-task'];
const passed = evidence.findings.length === 0 && requiredChecks.every((id) => evidence.checks.some((item) => item.id === id && item.passed));
fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
if (!passed) fs.writeFileSync(issuesPath, `${JSON.stringify(evidence.findings, null, 2)}\n`);

process.stdout.write(`${JSON.stringify({
  status: passed ? 'pass' : 'fail',
  summary: passed ? 'deterministic UI geometry and screenshot gate passed' : 'deterministic UI quality gate found issues',
  evidence_file: path.relative(runDir, evidencePath),
  issues_file: passed ? null : path.relative(runDir, issuesPath)
})}\n`);
