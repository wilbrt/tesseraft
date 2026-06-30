import { execFile, spawn } from 'node:child_process';
import { ROOT_DIR, tesseraftBin } from './paths.js';
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
  execFile(tesseraftBin(), ['control-plane', ...args], { cwd: ROOT_DIR, timeout: options.timeout || 15000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
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

export const startRuntime = (args: string[]): BackgroundRuntime => {
  const child = spawn(tesseraftBin(), ['run', ...args], { cwd: ROOT_DIR, detached: true, stdio: 'ignore' });
  child.unref();
  return { pid: child.pid };
};

export const runRuntime = (args: string[], options: { timeout?: number } = {}): Promise<RuntimeResult> => new Promise((resolve) => {
  execFile(tesseraftBin(), ['run', ...args], { cwd: ROOT_DIR, timeout: options.timeout || 30000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
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
