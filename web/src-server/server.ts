#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const STATIC_DIR = path.join(ROOT_DIR, 'web', 'static');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 7341;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml; charset=utf-8'
};

type ApiRoute = string[] | { badRequest: string } | { notFound: true } | null;
type ControlPlaneResult = { status: number; body: unknown };
type RuntimeResult = { status: number; body: unknown; exitCode: number | null; stderr: string };
type ParsedArgs = { host: string; port: number; help?: boolean };
type JsonRecord = Record<string, unknown>;

const jsonResponse = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
};

const errorBody = (status: number, code: string, message: string, details: Record<string, unknown> = {}) => (
  { status, error: { code, message, details } }
);

const safeDecode = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return null;
  }
};

const statusFromControlPlane = (data: unknown, fallback: number): number => {
  if (data && typeof data === 'object' && 'status' in data && typeof data.status === 'number') return data.status;
  return fallback;
};

const hasControlPlaneError = (data: unknown): boolean => (
  Boolean(data && typeof data === 'object' && 'error' in data)
);

const tesseraftBin = (): string => path.join(ROOT_DIR, 'bin', 'tesseraft');

export const runControlPlane = (args: string[], options: { timeout?: number } = {}): Promise<ControlPlaneResult> => {
  return new Promise((resolve) => {
    execFile(tesseraftBin(), ['control-plane', ...args], {
      cwd: ROOT_DIR,
      timeout: options.timeout || 15000,
      maxBuffer: 10 * 1024 * 1024
    }, (error, stdout, stderr) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout || '{}');
      } catch (parseError) {
        const message = parseError instanceof Error ? parseError.message : String(parseError);
        resolve({
          status: 502,
          body: errorBody(502, 'bad_gateway', 'Control-plane returned invalid JSON', {
            message,
            stderr: String(stderr || '').trim(),
            exit_code: error && typeof error.code === 'number' ? error.code : null
          })
        });
        return;
      }

      if (error || hasControlPlaneError(parsed)) {
        resolve({
          status: statusFromControlPlane(parsed, error && error.code === 2 ? 400 : 500),
          body: hasControlPlaneError(parsed) ? parsed : errorBody(500, 'control_plane_error', 'Control-plane command failed', {
            stderr: String(stderr || '').trim(),
            exit_code: error && typeof error.code === 'number' ? error.code : null
          })
        });
        return;
      }

      resolve({ status: 200, body: parsed });
    });
  });
};

const runRuntime = (args: string[], options: { timeout?: number } = {}): Promise<RuntimeResult> => new Promise((resolve) => {
  execFile(tesseraftBin(), ['run', ...args], {
    cwd: ROOT_DIR,
    timeout: options.timeout || 30000,
    maxBuffer: 10 * 1024 * 1024
  }, (error, stdout, stderr) => {
    const exitCode = error && typeof error.code === 'number' ? error.code : null;
    let parsed: unknown = null;
    if (String(stdout || '').trim()) {
      try {
        parsed = JSON.parse(stdout);
      } catch (parseError) {
        const message = parseError instanceof Error ? parseError.message : String(parseError);
        resolve({
          status: 502,
          body: errorBody(502, 'bad_gateway', 'Runtime returned invalid JSON', { message, stderr: String(stderr || '').trim(), exit_code: exitCode }),
          exitCode,
          stderr: String(stderr || '').trim()
        });
        return;
      }
    }

    if (error) {
      resolve({
        status: 502,
        body: errorBody(502, 'runtime_error', 'Runtime command failed', { stderr: String(stderr || '').trim(), exit_code: exitCode }),
        exitCode,
        stderr: String(stderr || '').trim()
      });
      return;
    }

    resolve({ status: 200, body: parsed || {}, exitCode, stderr: String(stderr || '').trim() });
  });
});

export const routeApi = (pathname: string, searchParams: URLSearchParams = new URLSearchParams()): ApiRoute => {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api') return null;

  if (parts.length === 2 && parts[1] === 'workflows') return ['workflows'];
  if (parts.length === 3 && parts[1] === 'workflows') {
    const name = safeDecode(parts[2]);
    return name === null ? { badRequest: 'Malformed workflow name' } : ['workflow', name];
  }
  if (parts.length === 4 && parts[1] === 'workflows' && parts[3] === 'graph') {
    const name = safeDecode(parts[2]);
    return name === null ? { badRequest: 'Malformed workflow name' } : ['graph', name];
  }
  if (parts.length === 2 && parts[1] === 'runs') return ['runs'];
  if (parts.length === 3 && parts[1] === 'runs') {
    const runId = safeDecode(parts[2]);
    return runId === null ? { badRequest: 'Malformed run id' } : ['run', runId];
  }
  if (parts.length === 4 && parts[1] === 'runs' && parts[3] === 'events') {
    const runId = safeDecode(parts[2]);
    return runId === null ? { badRequest: 'Malformed run id' } : ['events', runId];
  }
  if (parts.length === 4 && parts[1] === 'runs' && parts[3] === 'artifacts') {
    const runId = safeDecode(parts[2]);
    return runId === null ? { badRequest: 'Malformed run id' } : ['artifacts', runId];
  }
  if (parts.length === 5 && parts[1] === 'runs' && parts[3] === 'artifact') {
    const runId = safeDecode(parts[2]);
    const artifactPath = safeDecode(parts[4]);
    if (runId === null) return { badRequest: 'Malformed run id' };
    if (artifactPath === null) return { badRequest: 'Malformed artifact path' };
    return ['artifact', runId, artifactPath];
  }
  if (parts.length === 4 && parts[1] === 'runs' && parts[3] === 'artifact') {
    const runId = safeDecode(parts[2]);
    const artifactPath = searchParams.get('path');
    if (runId === null) return { badRequest: 'Malformed run id' };
    if (!artifactPath) return { badRequest: 'Missing artifact path' };
    return ['artifact', runId, artifactPath];
  }

  return { notFound: true };
};

const readJsonBody = (req: IncomingMessage, limit = 64 * 1024): Promise<JsonRecord> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > limit) {
      reject(Object.assign(new Error('JSON body is too large'), { status: 413, code: 'payload_too_large' }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('error', reject);
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) {
      resolve({});
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(Object.assign(new Error('JSON body must be an object'), { status: 400, code: 'bad_request' }));
        return;
      }
      resolve(parsed as JsonRecord);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reject(Object.assign(new Error(`Invalid JSON body: ${message}`), { status: 400, code: 'bad_request' }));
    }
  });
});

const runDetailPath = (body: unknown): string | null => {
  if (!body || typeof body !== 'object' || !('run' in body)) return null;
  const run = (body as { run?: { path?: unknown } }).run;
  return run && typeof run.path === 'string' ? run.path : null;
};

const workflowPath = (body: unknown): string | null => {
  if (!body || typeof body !== 'object' || !('workflow' in body)) return null;
  const workflow = (body as { workflow?: { path?: unknown } }).workflow;
  return workflow && typeof workflow.path === 'string' ? workflow.path : null;
};

const refreshedRun = async (runId: string): Promise<ControlPlaneResult> => runControlPlane(['run', runId]);

const inspectRuntime = async (runDir: string): Promise<unknown> => {
  const inspected = await runRuntime(['inspect', '--run-dir', runDir, '--format', 'json']);
  return inspected.status === 200 ? inspected.body : null;
};

const mutationResponse = async (operation: string, runId: string, cli: RuntimeResult, runDir?: string): Promise<{ status: number; body: unknown }> => {
  const detail = await refreshedRun(runId);
  return {
    status: cli.status,
    body: {
      operation,
      status: cli.status === 200 ? 'ok' : 'error',
      run_id: runId,
      cli: { exit_code: cli.exitCode, stderr: cli.stderr || undefined, result: cli.body },
      latest_runtime: runDir ? await inspectRuntime(runDir) : null,
      run_detail: detail.status === 200 ? detail.body : null
    }
  };
};

const handleStartRun = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const body = await readJsonBody(req);
  const workflowName = body.workflow_name;
  const runId = body.run_id;
  const inputs = body.inputs ?? {};
  if (typeof workflowName !== 'string' || workflowName.trim() === '') {
    jsonResponse(res, 400, errorBody(400, 'bad_request', 'workflow_name is required'));
    return;
  }
  if (typeof runId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(runId)) {
    jsonResponse(res, 400, errorBody(400, 'bad_request', 'run_id is required and may contain only letters, numbers, dot, underscore, and dash'));
    return;
  }
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || Object.values(inputs).some((value) => typeof value !== 'string')) {
    jsonResponse(res, 400, errorBody(400, 'bad_request', 'inputs must be an object of string values'));
    return;
  }

  const existing = await refreshedRun(runId);
  if (existing.status === 200) {
    jsonResponse(res, 409, errorBody(409, 'conflict', 'Run id already exists', { run_id: runId }));
    return;
  }

  const workflow = await runControlPlane(['workflow', workflowName]);
  if (workflow.status !== 200) {
    jsonResponse(res, workflow.status, workflow.body);
    return;
  }
  const filePath = workflowPath(workflow.body);
  if (!filePath) {
    jsonResponse(res, 502, errorBody(502, 'bad_gateway', 'Workflow detail did not include a path'));
    return;
  }

  const args = ['start', filePath, '--run-id', runId, '--format', 'json'];
  for (const [key, value] of Object.entries(inputs as Record<string, string>)) args.push('--input', `${key}=${value}`);
  const cli = await runRuntime(args);
  const runDir = cli.body && typeof cli.body === 'object' ? (cli.body as { run?: { dir?: unknown } }).run?.dir : undefined;
  const result = await mutationResponse('start', runId, cli, typeof runDir === 'string' ? runDir : undefined);
  jsonResponse(res, result.status, result.body);
};

const handleExistingRunMutation = async (req: IncomingMessage, res: ServerResponse, runId: string, operation: 'step' | 'resume'): Promise<void> => {
  const body = await readJsonBody(req);
  const detail = await refreshedRun(runId);
  if (detail.status !== 200) {
    jsonResponse(res, detail.status, detail.body);
    return;
  }
  const runDir = runDetailPath(detail.body);
  if (!runDir) {
    jsonResponse(res, 502, errorBody(502, 'bad_gateway', 'Run detail did not include a path'));
    return;
  }

  const args = operation === 'step'
    ? ['step', '--run-dir', runDir, '--format', 'json']
    : ['resume', '--run-dir', runDir, '--max-steps', String(body.max_steps), '--format', 'json'];
  if (operation === 'resume' && (!Number.isInteger(body.max_steps) || (body.max_steps as number) < 1 || (body.max_steps as number) > 1000)) {
    jsonResponse(res, 400, errorBody(400, 'bad_request', 'max_steps must be an integer from 1 to 1000'));
    return;
  }

  const cli = await runRuntime(args);
  if (operation === 'resume' && cli.status !== 200 && /Exceeded max steps/i.test(cli.stderr)) {
    const latest = await inspectRuntime(runDir);
    const refreshed = await refreshedRun(runId);
    jsonResponse(res, 422, {
      operation,
      status: 'guarded',
      code: 'max_steps_exceeded',
      run_id: runId,
      cli: { exit_code: cli.exitCode, stderr: cli.stderr },
      latest_runtime: latest,
      run_detail: refreshed.status === 200 ? refreshed.body : null
    });
    return;
  }

  const result = await mutationResponse(operation, runId, cli, runDir);
  jsonResponse(res, result.status, result.body);
};

const handlePostApi = async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> => {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api') return false;
  if (parts.length === 2 && parts[1] === 'runs') {
    await handleStartRun(req, res);
    return true;
  }
  if (parts.length === 4 && parts[1] === 'runs' && (parts[3] === 'step' || parts[3] === 'resume')) {
    const runId = safeDecode(parts[2]);
    if (runId === null) jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed run id'));
    else await handleExistingRunMutation(req, res, runId, parts[3] as 'step' | 'resume');
    return true;
  }
  jsonResponse(res, 404, errorBody(404, 'not_found', 'API route not found'));
  return true;
};

const handleApi = async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> => {
  if (req.method === 'POST') {
    try {
      return await handlePostApi(req, res, pathname);
    } catch (error) {
      const err = error as Error & { status?: number; code?: string };
      jsonResponse(res, err.status || 500, errorBody(err.status || 500, err.code || 'internal_error', err.message));
      return true;
    }
  }
  if (req.method !== 'GET') {
    jsonResponse(res, 405, errorBody(405, 'method_not_allowed', 'Only GET and POST are supported for API routes'));
    return true;
  }

  const routed = routeApi(pathname, new URL(req.url || '/', 'http://127.0.0.1').searchParams);
  if (routed === null) return false;
  if ('badRequest' in routed) {
    jsonResponse(res, 400, errorBody(400, 'bad_request', routed.badRequest));
    return true;
  }
  if ('notFound' in routed) {
    jsonResponse(res, 404, errorBody(404, 'not_found', 'API route not found'));
    return true;
  }

  const result = await runControlPlane(routed);
  jsonResponse(res, result.status, result.body);
  return true;
};

const staticPath = (pathname: string): string | null => {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const decoded = safeDecode(requested);
  if (decoded === null) return null;
  const resolved = path.resolve(STATIC_DIR, `.${decoded}`);
  if (!resolved.startsWith(STATIC_DIR + path.sep) && resolved !== STATIC_DIR) return null;
  return resolved;
};

const serveStatic = (req: IncomingMessage, res: ServerResponse, pathname: string): void => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    jsonResponse(res, 405, errorBody(405, 'method_not_allowed', 'Only GET and HEAD are supported for static assets'));
    return;
  }

  const filePath = staticPath(pathname);
  if (!filePath) {
    jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed static asset path'));
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      jsonResponse(res, 404, errorBody(404, 'not_found', 'Resource not found'));
      return;
    }
    const type = CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': data.length });
    if (req.method === 'HEAD') res.end();
    else res.end(data);
  });
};

export const createServer = (): http.Server => http.createServer(async (req, res) => {
  let parsed: URL;
  try {
    parsed = new URL(req.url || '/', 'http://127.0.0.1');
  } catch (_error) {
    jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed URL'));
    return;
  }

  try {
    const handled = await handleApi(req, res, parsed.pathname);
    if (!handled) serveStatic(req, res, parsed.pathname);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    jsonResponse(res, 500, errorBody(500, 'internal_error', 'Unhandled server error', { message }));
  }
});

export const parseArgs = (argv: string[]): ParsedArgs => {
  const opts: ParsedArgs = { host: DEFAULT_HOST, port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') {
      const value = argv[++i];
      if (value === undefined) throw new Error('Missing value for --port');
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid --port: ${value}`);
      opts.port = port;
    } else if (arg === '--host') {
      const value = argv[++i];
      if (value === undefined) throw new Error('Missing value for --host');
      opts.host = value;
    } else if (arg === '-h' || arg === '--help' || arg === 'help') {
      opts.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
};

const printUsage = (): void => {
  console.log('Usage: tesseraft web [--host 127.0.0.1] [--port <port>]');
  console.log('Serve the local read-only Tesseraft Web UI.');
};

export const main = (): void => {
  let opts: ParsedArgs;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    process.exit(2);
  }

  if (opts.help) {
    printUsage();
    process.exit(0);
  }

  const server = createServer();
  server.listen(opts.port, opts.host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : opts.port;
    console.log(`Tesseraft web UI listening on http://${opts.host}:${port}`);
  });
};

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) main();
