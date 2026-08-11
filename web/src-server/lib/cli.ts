import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT_DIR, WORKSPACE_ROOT, tesseraftBin } from './paths.js';
import { errorBody } from './http.js';

export type ControlPlaneResult = { status: number; body: unknown };
export type RuntimeResult = { status: number; body: unknown; exitCode: number | null; stderr: string };
export type BackgroundRuntime = { pid?: number };

const statusFromControlPlane = (data: unknown, fallback: number): number => {
  if (data && typeof data === 'object' && 'status' in data && typeof data.status === 'number') return data.status;
  return fallback;
};

const hasControlPlaneError = (data: unknown): boolean => Boolean(data && typeof data === 'object' && 'error' in data);

export const runControlPlane = (args: string[], options: { timeout?: number } = {}): Promise<ControlPlaneResult> => new Promise((resolve) => {
  execFile(tesseraftBin(), ['control-plane', ...args], { cwd: WORKSPACE_ROOT, timeout: options.timeout || 15000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout || '{}');
    } catch (parseError) {
      const message = parseError instanceof Error ? parseError.message : String(parseError);
      resolve({ status: 502, body: errorBody(502, 'bad_gateway', 'Control-plane returned invalid JSON', { message, stderr: String(stderr || '').trim(), exit_code: error && typeof error.code === 'number' ? error.code : null }) });
      return;
    }

    if (error || hasControlPlaneError(parsed)) {
      resolve({ status: statusFromControlPlane(parsed, error && error.code === 2 ? 400 : 500), body: hasControlPlaneError(parsed) ? parsed : errorBody(500, 'control_plane_error', 'Control-plane command failed', { stderr: String(stderr || '').trim(), exit_code: error && typeof error.code === 'number' ? error.code : null }) });
      return;
    }

    resolve({ status: 200, body: parsed });
  });
});

export const runControlPlaneOperation = (request: unknown, options: { timeout?: number } = {}): Promise<ControlPlaneResult> => new Promise((resolve) => {
  const child = spawn(tesseraftBin(), ['control-plane', 'apply', '--input', '-'], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, TESSERAFT_INSTALL_ROOT: ROOT_DIR },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const timer = setTimeout(() => child.kill('SIGTERM'), options.timeout || 15000);
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.on('error', (error) => {
    clearTimeout(timer);
    resolve({ status: 500, body: errorBody(500, 'control_plane_error', 'Control-plane operation could not start', { message: error.message }) });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    const output = Buffer.concat(stdout).toString('utf8');
    const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(output || '{}');
    } catch (error) {
      resolve({ status: 502, body: errorBody(502, 'bad_gateway', 'Control-plane returned invalid JSON', {
        message: error instanceof Error ? error.message : String(error), stderr: errorOutput, exit_code: code
      }) });
      return;
    }
    if (code !== 0 || hasControlPlaneError(parsed)) {
      resolve({ status: statusFromControlPlane(parsed, code === 2 ? 400 : 500), body: parsed });
      return;
    }
    resolve({ status: 200, body: parsed });
  });
  child.stdin.end(JSON.stringify(request));
});

export const startRuntime = (args: string[]): BackgroundRuntime => {
  const child = spawn(tesseraftBin(), ['run', ...args], { cwd: WORKSPACE_ROOT, detached: true, stdio: 'ignore' });
  child.unref();
  return { pid: child.pid };
};

export const startRuntimeOperation = (request: unknown): BackgroundRuntime => {
  const child = spawn(tesseraftBin(), ['run', 'apply', '--input', '-'], {
    cwd: WORKSPACE_ROOT, detached: true, stdio: ['pipe', 'ignore', 'ignore']
  });
  child.stdin.end(JSON.stringify(request));
  child.unref();
  return { pid: child.pid };
};

export const runRuntimeOperation = (request: unknown, options: { timeout?: number } = {}): Promise<RuntimeResult> => new Promise((resolve) => {
  const child = spawn(tesseraftBin(), ['run', 'apply', '--input', '-'], { cwd: WORKSPACE_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const timer = setTimeout(() => child.kill('SIGTERM'), options.timeout || 30000);
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.on('close', (code) => {
    clearTimeout(timer);
    const stderrText = Buffer.concat(stderr).toString('utf8').trim();
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(stdout).toString('utf8') || '{}'); }
    catch { return resolve({ status: 502, body: errorBody(502, 'bad_gateway', 'Runtime returned invalid JSON'), exitCode: code, stderr: stderrText }); }
    const status = statusFromControlPlane(parsed, code === 0 ? 200 : 400);
    resolve({ status: code === 0 && !hasControlPlaneError(parsed) ? 200 : status, body: parsed, exitCode: code, stderr: stderrText });
  });
  child.on('error', (error) => {
    clearTimeout(timer);
    resolve({ status: 500, body: errorBody(500, 'runtime_error', error.message), exitCode: null, stderr: error.message });
  });
  child.stdin.end(JSON.stringify(request));
});

export type LintResult = { ok: boolean; errors: unknown[]; warnings: unknown[]; diagnostics: unknown[]; status: number; body: unknown };

export const runLint = async (filePath: string, options: { workspaceRoot?: string; tesseraftHome?: string; timeout?: number } = {}): Promise<LintResult> => new Promise((resolve) => {
  const args = ['lint', filePath, '--format', 'json'];
  const env = { ...process.env };
  if (options.workspaceRoot) env.TESSERAFT_WORKSPACE_ROOT = options.workspaceRoot;
  if (options.tesseraftHome) env.TESSERAFT_HOME = options.tesseraftHome;
  execFile(tesseraftBin(), args, { cwd: options.workspaceRoot ? path.resolve(options.workspaceRoot) : WORKSPACE_ROOT, timeout: options.timeout || 15000, maxBuffer: 10 * 1024 * 1024, env }, (error, stdout, stderr) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout || '{}');
    } catch {
      resolve({ ok: false, errors: [], warnings: [], diagnostics: [], status: 502, body: errorBody(502, 'bad_gateway', 'Linter returned invalid JSON', { stderr: String(stderr || '').trim(), exit_code: error && typeof error.code === 'number' ? error.code : null }) });
      return;
    }
    const body = parsed as { ok?: boolean; errors?: unknown[]; warnings?: unknown[]; diagnostics?: unknown[] };
    resolve({ ok: Boolean(body.ok), errors: body.errors || [], warnings: body.warnings || [], diagnostics: body.diagnostics || [], status: 200, body: parsed });
  });
});

export const runRuntime = (args: string[], options: { timeout?: number } = {}): Promise<RuntimeResult> => new Promise((resolve) => {
  execFile(tesseraftBin(), ['run', ...args], { cwd: WORKSPACE_ROOT, timeout: options.timeout || 30000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
    const exitCode = error && typeof error.code === 'number' ? error.code : null;
    let parsed: unknown = null;
    if (String(stdout || '').trim()) {
      try {
        parsed = JSON.parse(stdout);
      } catch (parseError) {
        const message = parseError instanceof Error ? parseError.message : String(parseError);
        resolve({ status: 502, body: errorBody(502, 'bad_gateway', 'Runtime returned invalid JSON', { message, stderr: String(stderr || '').trim(), exit_code: exitCode }), exitCode, stderr: String(stderr || '').trim() });
        return;
      }
    }

    if (error) {
      resolve({ status: 502, body: errorBody(502, 'runtime_error', 'Runtime command failed', { stderr: String(stderr || '').trim(), exit_code: exitCode }), exitCode, stderr: String(stderr || '').trim() });
      return;
    }

    resolve({ status: 200, body: parsed || {}, exitCode, stderr: String(stderr || '').trim() });
  });
});
