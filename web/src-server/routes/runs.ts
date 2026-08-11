import express, { type Request, type Response, type Router } from 'express';
import { makeGitUserAuthor } from '../lib/approvals.js';
import { runControlPlane, runControlPlaneOperation, runRuntime, startRuntimeOperation, type ControlPlaneResult } from '../lib/cli.js';
import { errorBody, jsonResponse } from '../lib/http.js';
import { controlPlaneGet, decodedParam, deprecatedDefaultProjectRoute, operationResultBody, projectIdParam } from './routing.js';

type JsonRecord = Record<string, unknown>;
type Mutation = 'step' | 'resume' | 'cancel';

const refreshedRun = (runId: string, projectId?: string): Promise<ControlPlaneResult> => runControlPlane([...(projectId ? ['--project-id', projectId] : []), 'run', runId]);
const operationResult = (body: unknown): JsonRecord | null => {
  const result = operationResultBody(body);
  return result && typeof result === 'object' ? result as JsonRecord : null;
};
const inspectRuntime = async (runDir: string): Promise<unknown> => {
  const inspected = await runRuntime(['inspect', '--run-dir', runDir, '--format', 'json']);
  return inspected.status === 200 ? inspected.body : null;
};
const snapshot = async (runId: string, projectId?: string): Promise<unknown> => {
  const args = projectId ? ['--project-id', projectId] : [];
  const [detail, events, artifacts, runs] = await Promise.all([
    runControlPlane([...args, 'run', runId]), runControlPlane([...args, 'events', runId]),
    runControlPlane([...args, 'artifacts', runId]), runControlPlane([...args, 'runs'])
  ]);
  if (detail.status !== 200) return detail.body;
  const field = (body: unknown, key: string, fallback: unknown): unknown => body && typeof body === 'object' && key in body ? (body as JsonRecord)[key] : fallback;
  return { run_id: runId, run: field(detail.body, 'run', null), events: field(events.body, 'events', []), artifacts: field(artifacts.body, 'artifacts', []), runs: field(runs.body, 'runs', []) };
};

const startRun = async (req: Request, res: Response, projectId?: string): Promise<void> => {
  const body = (req.body || {}) as JsonRecord;
  const started = await runControlPlaneOperation({ operation: 'run.start', project_id: projectId, payload: body });
  if (started.status !== 200) return jsonResponse(res, started.status, started.body);
  const result = operationResult(started.body);
  const run = result?.run && typeof result.run === 'object' ? result.run as JsonRecord : null;
  const runId = typeof run?.id === 'string' ? run.id : body.run_id;
  const runDir = typeof run?.dir === 'string' ? run.dir : undefined;
  const maxSteps = typeof result?.max_steps === 'number' ? result.max_steps : 100;
  if (typeof runId !== 'string' || !runDir) return jsonResponse(res, 502, errorBody(502, 'bad_gateway', 'Run operation did not return a run id and directory'));
  const background = startRuntimeOperation({ operation: 'run.resume', payload: { run_dir: runDir, max_steps: maxSteps } });
  const detail = await refreshedRun(runId, projectId);
  jsonResponse(res, 202, { operation: 'start', status: 'running', code: 'background_started', run_id: runId, background, result, latest_runtime: await inspectRuntime(runDir), run_detail: detail.status === 200 ? detail.body : null });
};

const mutateRun = async (req: Request, res: Response, runId: string, operation: Mutation, projectId?: string): Promise<void> => {
  const body = (req.body || {}) as JsonRecord;
  if (operation === 'resume') {
    const prepared = await runControlPlaneOperation({ operation: 'run.resume.prepare', project_id: projectId, payload: { ...body, run_id: runId } });
    if (prepared.status !== 200) return jsonResponse(res, prepared.status, prepared.body);
    const target = operationResult(prepared.body);
    const runDir = typeof target?.run_dir === 'string' ? target.run_dir : undefined;
    const maxSteps = typeof target?.max_steps === 'number' ? target.max_steps : undefined;
    if (!runDir || !maxSteps) return jsonResponse(res, 502, errorBody(502, 'bad_gateway', 'Resume operation did not return a run directory and max_steps'));
    const background = startRuntimeOperation({ operation: 'run.resume', payload: { run_dir: runDir, max_steps: maxSteps } });
    const detail = await refreshedRun(runId, projectId);
    return jsonResponse(res, 202, { operation, status: 'running', code: 'background_started', run_id: runId, background, latest_runtime: await inspectRuntime(runDir), run_detail: detail.status === 200 ? detail.body : null });
  }
  const result = await runControlPlaneOperation({ operation: `run.${operation}`, project_id: projectId, payload: { ...body, run_id: runId } });
  if (result.status !== 200) return jsonResponse(res, result.status, result.body);
  const detail = await refreshedRun(runId, projectId);
  jsonResponse(res, 200, { operation, status: 'ok', run_id: runId, result: operationResult(result.body), run_detail: detail.status === 200 ? detail.body : null });
};

const streamRun = async (req: Request, res: Response, runId: string, projectId?: string): Promise<void> => {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
  res.write(': connected\n\n');
  let closed = false; let inFlight = false; let last = ''; let interval: ReturnType<typeof setInterval> | null = null;
  const close = (): void => { if (!closed) { closed = true; if (interval) clearInterval(interval); res.end(); } };
  const send = async (): Promise<void> => {
    if (closed) return;
    const current = await snapshot(runId, projectId); const payload = JSON.stringify(current);
    if (payload !== last) { last = payload; res.write(`event: snapshot\ndata: ${payload}\n\n`); } else res.write(': heartbeat\n\n');
    const run = current && typeof current === 'object' ? (current as { run?: { status?: unknown } }).run : null;
    if (run && typeof run.status === 'string' && ['done', 'failed', 'error', 'cancelled'].includes(run.status)) close();
  };
  const poll = (): void => { if (!closed && !inFlight) { inFlight = true; void send().catch((error) => { if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`); }).finally(() => { inFlight = false; }); } };
  await send(); if (!closed) interval = setInterval(poll, 1000); req.on('close', close);
};

const registerMutations = (router: Router, prefix: string, scoped: boolean): void => {
  const project = (req: Request, res: Response): string | undefined | null => scoped ? projectIdParam(req, res) : undefined;
  router.post(`${prefix}/runs`, (req, res, next) => { const id = project(req, res); if (id !== null) void startRun(req, res, id).catch(next); });
  router.get(`${prefix}/runs/:runId/stream`, (req, res, next) => { const id = project(req, res); const runId = decodedParam(req, res, 'runId', 'run id'); if (id !== null && runId) void streamRun(req, res, runId, id).catch(next); });
  router.delete(`${prefix}/runs/:runId`, (req, res, next) => {
    const id = project(req, res); const runId = decodedParam(req, res, 'runId', 'run id'); if (id === null || !runId) return;
    void runControlPlaneOperation({ operation: 'run.delete', project_id: id, payload: { run_id: runId } }).then((r) => jsonResponse(res, r.status, r.status === 200 ? operationResult(r.body) : r.body)).catch(next);
  });
  router.post(`${prefix}/runs/:runId/approvals/:approvalId`, (req, res, next) => {
    const id = project(req, res); const runId = decodedParam(req, res, 'runId', 'run id'); const approvalId = decodedParam(req, res, 'approvalId', 'approval id');
    if (id === null || !runId || !approvalId) return;
    void makeGitUserAuthor(req).then((author) => runControlPlaneOperation({ operation: 'run.decide', project_id: id, payload: { ...(req.body || {}), run_id: runId, approval_id: approvalId, author } })).then(async (r) => {
      if (r.status !== 200) return jsonResponse(res, r.status, r.body);
      const detail = await refreshedRun(runId, id);
      jsonResponse(res, 200, { operation: 'decide', status: 'ok', run_id: runId, approval_id: approvalId, decision: req.body?.decision, result: operationResult(r.body), run_detail: detail.status === 200 ? detail.body : null });
    }).catch(next);
  });
  router.post(`${prefix}/runs/:runId/comments`, (req, res, next) => {
    const id = project(req, res); const runId = decodedParam(req, res, 'runId', 'run id'); if (id === null || !runId) return;
    void makeGitUserAuthor(req).then((author) => runControlPlaneOperation({ operation: 'run.comment.add', project_id: id, payload: { ...(req.body || {}), run_id: runId, author } })).then((r) => jsonResponse(res, r.status, r.body)).catch(next);
  });
  router.post(`${prefix}/runs/:runId/:operation`, (req, res, next) => {
    const id = project(req, res); const runId = decodedParam(req, res, 'runId', 'run id'); const operation = req.params.operation;
    if (id === null || !runId) return;
    if (!['step', 'resume', 'cancel'].includes(operation)) return jsonResponse(res, 404, errorBody(404, 'not_found', 'API route not found'));
    void mutateRun(req, res, runId, operation as Mutation, id).catch(next);
  });
};

export const createRunsRouter = (): Router => {
  const router = express.Router();
  const legacy = (args: string[]) => (req: Request, res: Response, next: (error?: unknown) => void): void => { deprecatedDefaultProjectRoute(res); controlPlaneGet(args)(req, res, next); };
  router.get('/runs', legacy(['runs']));
  router.get('/runs/:runId', (req, res, next) => { const id = decodedParam(req, res, 'runId', 'run id'); if (id) legacy(['run', id])(req, res, next); });
  for (const [suffix, command] of [['events', 'events'], ['artifacts', 'artifacts'], ['approvals', 'approvals']] as const) router.get(`/runs/:runId/${suffix}`, (req, res, next) => { const id = decodedParam(req, res, 'runId', 'run id'); if (id) legacy([command, id])(req, res, next); });
  router.get('/runs/:runId/artifact', (req, res, next) => { const id = decodedParam(req, res, 'runId', 'run id'); const p = typeof req.query.path === 'string' ? req.query.path : ''; if (id && p) legacy(['artifact', id, p])(req, res, next); else if (id) jsonResponse(res, 400, errorBody(400, 'bad_request', 'Missing artifact path')); });
  router.get('/runs/:runId/approval/:approvalId', (req, res, next) => { const id = decodedParam(req, res, 'runId', 'run id'); const approval = decodedParam(req, res, 'approvalId', 'approval id'); if (id && approval) legacy(['approval', id, approval])(req, res, next); });
  router.get('/runs/:runId/comments', (req, res, next) => { const id = decodedParam(req, res, 'runId', 'run id'); if (id) legacy(['comments', id, '--path', typeof req.query.path === 'string' ? req.query.path : ''])(req, res, next); });

  router.get('/projects/:projectId/runs', (req, res, next) => { const id = projectIdParam(req, res); if (id) controlPlaneGet(['--project-id', id, 'runs'])(req, res, next); });
  for (const [suffix, command] of [['', 'run'], ['/events', 'events'], ['/artifacts', 'artifacts'], ['/approvals', 'approvals']] as const) router.get(`/projects/:projectId/runs/:runId${suffix}`, (req, res, next) => { const id = projectIdParam(req, res); const run = decodedParam(req, res, 'runId', 'run id'); if (id && run) controlPlaneGet(['--project-id', id, command, run])(req, res, next); });
  router.get('/projects/:projectId/runs/:runId/artifact', (req, res, next) => { const id = projectIdParam(req, res); const run = decodedParam(req, res, 'runId', 'run id'); const p = typeof req.query.path === 'string' ? req.query.path : ''; if (id && run && p) controlPlaneGet(['--project-id', id, 'artifact', run, p])(req, res, next); else if (id && run) jsonResponse(res, 400, errorBody(400, 'bad_request', 'Missing artifact path')); });
  router.get('/projects/:projectId/runs/:runId/approval/:approvalId', (req, res, next) => { const id = projectIdParam(req, res); const run = decodedParam(req, res, 'runId', 'run id'); const approval = decodedParam(req, res, 'approvalId', 'approval id'); if (id && run && approval) controlPlaneGet(['--project-id', id, 'approval', run, approval])(req, res, next); });
  router.get('/projects/:projectId/runs/:runId/comments', (req, res, next) => { const id = projectIdParam(req, res); const run = decodedParam(req, res, 'runId', 'run id'); if (id && run) controlPlaneGet(['--project-id', id, 'comments', run, '--path', typeof req.query.path === 'string' ? req.query.path : ''])(req, res, next); });
  registerMutations(router, '', false); registerMutations(router, '/projects/:projectId', true);
  return router;
};
