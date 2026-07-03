import type { Request, Response, Router } from 'express';
import express from 'express';
import { runControlPlane, runRuntime, startRuntime, type ControlPlaneResult, type RuntimeResult } from '../lib/cli.js';
import { errorBody, jsonResponse, safeDecode } from '../lib/http.js';
import { createConfiguredPiSessionAdapter, type PiSessionAdapter } from '../lib/piSessionAdapter.js';

type ApiRoute = string[] | { badRequest: string } | { notFound: true } | null;
type JsonRecord = Record<string, unknown>;

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

const runSnapshot = async (runId: string): Promise<unknown> => {
  const [detail, events, artifacts, runs] = await Promise.all([
    runControlPlane(['run', runId]),
    runControlPlane(['events', runId]),
    runControlPlane(['artifacts', runId]),
    runControlPlane(['runs'])
  ]);
  if (detail.status !== 200) return detail.body;
  return {
    run_id: runId,
    run: detail.body && typeof detail.body === 'object' && 'run' in detail.body ? (detail.body as { run?: unknown }).run : null,
    events: events.status === 200 && events.body && typeof events.body === 'object' && 'events' in events.body ? (events.body as { events?: unknown[] }).events || [] : [],
    artifacts: artifacts.status === 200 && artifacts.body && typeof artifacts.body === 'object' && 'artifacts' in artifacts.body ? (artifacts.body as { artifacts?: unknown[] }).artifacts || [] : [],
    runs: runs.status === 200 && runs.body && typeof runs.body === 'object' && 'runs' in runs.body ? (runs.body as { runs?: unknown[] }).runs || [] : []
  };
};

const mutationResponse = async (operation: string, runId: string, cli: RuntimeResult, runDir?: string): Promise<{ status: number; body: unknown }> => {
  const detail = await refreshedRun(runId);
  return { status: cli.status, body: { operation, status: cli.status === 200 ? 'ok' : 'error', run_id: runId, cli: { exit_code: cli.exitCode, stderr: cli.stderr || undefined, result: cli.body }, latest_runtime: runDir ? await inspectRuntime(runDir) : null, run_detail: detail.status === 200 ? detail.body : null } };
};

const readMaxSteps = (value: unknown, fallback: number): number | null => {
  if (value === undefined) return fallback;
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 1000 ? value as number : null;
};

const EMAIL_RE = /^\S+@\S+\.\S+$/;

const readGitUser = (value: unknown): { name: string; email: string } | undefined | 'invalid' => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const obj = value as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  const email = typeof obj.email === 'string' ? obj.email.trim() : '';
  if (name === '' && email === '') return undefined;
  if (name !== '' && email !== '' && EMAIL_RE.test(email)) return { name, email };
  return 'invalid';
};

const handleStartRun = async (req: Request, res: Response): Promise<void> => {
  const body = req.body as JsonRecord;
  const workflowName = body.workflow_name;
  const runId = body.run_id;
  const inputs = body.inputs ?? {};
  const maxSteps = readMaxSteps(body.max_steps, 100);
  const gitUser = readGitUser(body.git_user);
  if (typeof workflowName !== 'string' || workflowName.trim() === '') return jsonResponse(res, 400, errorBody(400, 'bad_request', 'workflow_name is required'));
  if (typeof runId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(runId)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'run_id is required and may contain only letters, numbers, dot, underscore, and dash'));
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || Object.values(inputs).some((value) => typeof value !== 'string')) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'inputs must be an object of string values'));
  if (maxSteps === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'max_steps must be an integer from 1 to 1000'));
  if (gitUser === 'invalid') return jsonResponse(res, 400, errorBody(400, 'bad_request', 'git_user requires both name and a valid email, or neither'));

  const existing = await refreshedRun(runId);
  if (existing.status === 200) return jsonResponse(res, 409, errorBody(409, 'conflict', 'Run id already exists', { run_id: runId }));

  const workflow = await runControlPlane(['workflow', workflowName]);
  if (workflow.status !== 200) return jsonResponse(res, workflow.status, workflow.body);
  const filePath = workflowPath(workflow.body);
  if (!filePath) return jsonResponse(res, 502, errorBody(502, 'bad_gateway', 'Workflow detail did not include a path'));

  const startArgs = ['start', filePath, '--run-id', runId, '--format', 'json'];
  for (const [key, value] of Object.entries(inputs as Record<string, string>)) startArgs.push('--input', `${key}=${value}`);
  if (gitUser) { startArgs.push('--git-user-name', gitUser.name, '--git-user-email', gitUser.email); }
  const started = await runRuntime(startArgs);
  const runDir = started.body && typeof started.body === 'object' ? (started.body as { run?: { dir?: unknown } }).run?.dir : undefined;
  if (started.status !== 200 || typeof runDir !== 'string') {
    const result = await mutationResponse('start', runId, started, typeof runDir === 'string' ? runDir : undefined);
    return jsonResponse(res, result.status, result.body);
  }

  const background = startRuntime(['resume', '--run-dir', runDir, '--max-steps', String(maxSteps), '--format', 'json']);
  const detail = await refreshedRun(runId);
  jsonResponse(res, 202, { operation: 'start', status: 'running', code: 'background_started', run_id: runId, background, cli: { exit_code: started.exitCode, result: started.body }, latest_runtime: await inspectRuntime(runDir), run_detail: detail.status === 200 ? detail.body : null });
};

const handlePiError = (res: Response, error: unknown): void => {
  const err = error as Error & { status?: number; code?: string };
  const status = err.status || 500;
  const code = err.code || (status === 500 ? 'internal_error' : 'bad_request');
  jsonResponse(res, status, errorBody(status, code, err.message || 'Pi session request failed'));
};

const readOptionalString = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const handleCreatePiSession = async (req: Request, res: Response, adapter: PiSessionAdapter): Promise<void> => {
  try {
    const body = (req.body || {}) as JsonRecord;
    const session = await adapter.createSession({ id: readOptionalString(body.id), title: readOptionalString(body.title) });
    jsonResponse(res, 201, { session });
  } catch (error) {
    handlePiError(res, error);
  }
};

const handleSendPiPrompt = async (req: Request, res: Response, adapter: PiSessionAdapter, sessionId: string): Promise<void> => {
  const body = req.body as JsonRecord;
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'prompt is required'));
  const result = await adapter.sendPrompt(sessionId, prompt);
  if (!result) return jsonResponse(res, 404, errorBody(404, 'not_found', 'Pi session not found', { session_id: sessionId }));
  jsonResponse(res, 200, result);
};

const piSessionSnapshot = async (adapter: PiSessionAdapter, sessionId: string): Promise<unknown | null> => {
  const session = await adapter.getSession(sessionId);
  if (!session) return null;
  const messages = await adapter.listMessages(sessionId);
  return { session, messages: messages || [] };
};

const handlePiSessionStream = async (req: Request, res: Response, adapter: PiSessionAdapter, sessionId: string): Promise<void> => {
  const initial = await piSessionSnapshot(adapter, sessionId);
  if (!initial) return jsonResponse(res, 404, errorBody(404, 'not_found', 'Pi session not found', { session_id: sessionId }));

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  });
  res.write(': connected\n\n');
  let closed = false;
  let lastPayload = '';
  let interval: ReturnType<typeof setInterval> | null = null;

  const closeStream = (): void => {
    if (closed) return;
    closed = true;
    if (interval) clearInterval(interval);
    res.end();
  };
  const sendSnapshot = async (): Promise<void> => {
    if (closed) return;
    const snapshot = await piSessionSnapshot(adapter, sessionId);
    if (!snapshot) return closeStream();
    const payload = JSON.stringify(snapshot);
    if (payload !== lastPayload) {
      lastPayload = payload;
      res.write(`event: snapshot\ndata: ${payload}\n\n`);
    } else {
      res.write(': heartbeat\n\n');
    }
  };

  await sendSnapshot();
  if (!closed) interval = setInterval(() => { void sendSnapshot().catch((error) => res.write(`event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`)); }, 1000);
  req.on('close', closeStream);
};

const handleRunStream = async (req: Request, res: Response, runId: string): Promise<void> => {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  });
  res.write(': connected\n\n');
  let closed = false;
  let lastPayload = '';
  let interval: ReturnType<typeof setInterval> | null = null;

  const closeStream = (): void => {
    if (closed) return;
    closed = true;
    if (interval) clearInterval(interval);
    res.end();
  };
  const isTerminalSnapshot = (snapshot: unknown): boolean => {
    const run = snapshot && typeof snapshot === 'object' && 'run' in snapshot ? (snapshot as { run?: { status?: unknown } }).run : null;
    return Boolean(run && typeof run.status === 'string' && ['done', 'failed', 'error'].includes(run.status));
  };
  const sendSnapshot = async (): Promise<void> => {
    if (closed) return;
    const snapshot = await runSnapshot(runId);
    const payload = JSON.stringify(snapshot);
    if (payload !== lastPayload) {
      lastPayload = payload;
      res.write(`event: snapshot\ndata: ${payload}\n\n`);
    } else {
      res.write(': heartbeat\n\n');
    }
    if (isTerminalSnapshot(snapshot)) closeStream();
  };

  await sendSnapshot();
  if (!closed) interval = setInterval(() => { void sendSnapshot().catch((error) => res.write(`event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`)); }, 1000);
  req.on('close', closeStream);
};

const handleExistingRunMutation = async (req: Request, res: Response, runId: string, operation: 'step' | 'resume'): Promise<void> => {
  const body = req.body as JsonRecord;
  const detail = await refreshedRun(runId);
  if (detail.status !== 200) return jsonResponse(res, detail.status, detail.body);
  const runDir = runDetailPath(detail.body);
  if (!runDir) return jsonResponse(res, 502, errorBody(502, 'bad_gateway', 'Run detail did not include a path'));
  const maxSteps = readMaxSteps(body.max_steps, 100);
  if (operation === 'resume' && maxSteps === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'max_steps must be an integer from 1 to 1000'));

  if (operation === 'resume') {
    const background = startRuntime(['resume', '--run-dir', runDir, '--max-steps', String(maxSteps), '--format', 'json']);
    const refreshed = await refreshedRun(runId);
    return jsonResponse(res, 202, { operation, status: 'running', code: 'background_started', run_id: runId, background, latest_runtime: await inspectRuntime(runDir), run_detail: refreshed.status === 200 ? refreshed.body : null });
  }

  const cli = await runRuntime(['step', '--run-dir', runDir, '--format', 'json']);
  const result = await mutationResponse(operation, runId, cli, runDir);
  jsonResponse(res, result.status, result.body);
};

export const createApiRouter = (piSessionAdapter: PiSessionAdapter = createConfiguredPiSessionAdapter()): Router => {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  router.get('/pi-sessions', (req, res, next) => {
    void piSessionAdapter.listSessions().then((sessions) => jsonResponse(res, 200, { sessions })).catch(next);
  });
  router.post('/pi-sessions', (req, res, next) => { void handleCreatePiSession(req, res, piSessionAdapter).catch(next); });
  router.get('/pi-sessions/:sessionId', (req, res, next) => {
    const sessionId = safeDecode(req.params.sessionId);
    if (sessionId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed Pi session id'));
    return void piSessionAdapter.getSession(sessionId).then((session) => session ? jsonResponse(res, 200, { session }) : jsonResponse(res, 404, errorBody(404, 'not_found', 'Pi session not found', { session_id: sessionId }))).catch(next);
  });
  router.post('/pi-sessions/:sessionId/prompts', (req, res, next) => {
    const sessionId = safeDecode(req.params.sessionId);
    if (sessionId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed Pi session id'));
    return void handleSendPiPrompt(req, res, piSessionAdapter, sessionId).catch(next);
  });
  router.get('/pi-sessions/:sessionId/events', (req, res, next) => {
    const sessionId = safeDecode(req.params.sessionId);
    const afterValue = Array.isArray(req.query.after) ? req.query.after[0] : req.query.after;
    let after: number | undefined;
    if (sessionId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed Pi session id'));
    if (afterValue !== undefined) {
      const parsedAfter = Number(afterValue);
      if (!Number.isInteger(parsedAfter) || parsedAfter < 0) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'after must be a non-negative integer'));
      after = parsedAfter;
    }
    return void piSessionAdapter.listEvents(sessionId, after).then((events) => events ? jsonResponse(res, 200, { session_id: sessionId, events }) : jsonResponse(res, 404, errorBody(404, 'not_found', 'Pi session not found', { session_id: sessionId }))).catch(next);
  });
  router.get('/pi-sessions/:sessionId/stream', (req, res, next) => {
    const sessionId = safeDecode(req.params.sessionId);
    if (sessionId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed Pi session id'));
    return void handlePiSessionStream(req, res, piSessionAdapter, sessionId).catch(next);
  });

  router.post('/runs', (req, res, next) => { void handleStartRun(req, res).catch(next); });
  router.get('/runs/:runId/stream', (req, res, next) => {
    const runId = safeDecode(req.params.runId);
    if (runId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed run id'));
    return void handleRunStream(req, res, runId).catch(next);
  });
  router.post('/runs/:runId/:operation', (req, res, next) => {
    const runId = safeDecode(req.params.runId);
    const operation = req.params.operation;
    if (runId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed run id'));
    if (operation !== 'step' && operation !== 'resume') return jsonResponse(res, 404, errorBody(404, 'not_found', 'API route not found'));
    return void handleExistingRunMutation(req, res, runId, operation).catch(next);
  });

  router.use((req, res, next) => {
    if (req.method !== 'GET') return jsonResponse(res, 405, errorBody(405, 'method_not_allowed', 'Only GET and POST are supported for API routes'));
    const routed = routeApi(`/api${req.path}`, new URLSearchParams(req.url.split('?')[1] || ''));
    if (routed === null) return next();
    if ('badRequest' in routed) return jsonResponse(res, 400, errorBody(400, 'bad_request', routed.badRequest));
    if ('notFound' in routed) return jsonResponse(res, 404, errorBody(404, 'not_found', 'API route not found'));
    return void runControlPlane(routed).then((result) => jsonResponse(res, result.status, result.body)).catch(next);
  });

  return router;
};
