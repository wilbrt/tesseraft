import type { Request, Response, Router } from 'express';
import express from 'express';
import { runControlPlane, runRuntime, type ControlPlaneResult, type RuntimeResult } from '../lib/cli.js';
import { errorBody, jsonResponse, safeDecode } from '../lib/http.js';

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

const mutationResponse = async (operation: string, runId: string, cli: RuntimeResult, runDir?: string): Promise<{ status: number; body: unknown }> => {
  const detail = await refreshedRun(runId);
  return { status: cli.status, body: { operation, status: cli.status === 200 ? 'ok' : 'error', run_id: runId, cli: { exit_code: cli.exitCode, stderr: cli.stderr || undefined, result: cli.body }, latest_runtime: runDir ? await inspectRuntime(runDir) : null, run_detail: detail.status === 200 ? detail.body : null } };
};

const handleStartRun = async (req: Request, res: Response): Promise<void> => {
  const body = req.body as JsonRecord;
  const workflowName = body.workflow_name;
  const runId = body.run_id;
  const inputs = body.inputs ?? {};
  if (typeof workflowName !== 'string' || workflowName.trim() === '') return jsonResponse(res, 400, errorBody(400, 'bad_request', 'workflow_name is required'));
  if (typeof runId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(runId)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'run_id is required and may contain only letters, numbers, dot, underscore, and dash'));
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || Object.values(inputs).some((value) => typeof value !== 'string')) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'inputs must be an object of string values'));

  const existing = await refreshedRun(runId);
  if (existing.status === 200) return jsonResponse(res, 409, errorBody(409, 'conflict', 'Run id already exists', { run_id: runId }));

  const workflow = await runControlPlane(['workflow', workflowName]);
  if (workflow.status !== 200) return jsonResponse(res, workflow.status, workflow.body);
  const filePath = workflowPath(workflow.body);
  if (!filePath) return jsonResponse(res, 502, errorBody(502, 'bad_gateway', 'Workflow detail did not include a path'));

  const args = ['start', filePath, '--run-id', runId, '--format', 'json'];
  for (const [key, value] of Object.entries(inputs as Record<string, string>)) args.push('--input', `${key}=${value}`);
  const cli = await runRuntime(args);
  const runDir = cli.body && typeof cli.body === 'object' ? (cli.body as { run?: { dir?: unknown } }).run?.dir : undefined;
  const result = await mutationResponse('start', runId, cli, typeof runDir === 'string' ? runDir : undefined);
  jsonResponse(res, result.status, result.body);
};

const handleExistingRunMutation = async (req: Request, res: Response, runId: string, operation: 'step' | 'resume'): Promise<void> => {
  const body = req.body as JsonRecord;
  const detail = await refreshedRun(runId);
  if (detail.status !== 200) return jsonResponse(res, detail.status, detail.body);
  const runDir = runDetailPath(detail.body);
  if (!runDir) return jsonResponse(res, 502, errorBody(502, 'bad_gateway', 'Run detail did not include a path'));
  if (operation === 'resume' && (!Number.isInteger(body.max_steps) || (body.max_steps as number) < 1 || (body.max_steps as number) > 1000)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'max_steps must be an integer from 1 to 1000'));

  const args = operation === 'step' ? ['step', '--run-dir', runDir, '--format', 'json'] : ['resume', '--run-dir', runDir, '--max-steps', String(body.max_steps), '--format', 'json'];
  const cli = await runRuntime(args);
  if (operation === 'resume' && cli.status !== 200 && /Exceeded max steps/i.test(cli.stderr)) {
    const latest = await inspectRuntime(runDir);
    const refreshed = await refreshedRun(runId);
    return jsonResponse(res, 422, { operation, status: 'guarded', code: 'max_steps_exceeded', run_id: runId, cli: { exit_code: cli.exitCode, stderr: cli.stderr }, latest_runtime: latest, run_detail: refreshed.status === 200 ? refreshed.body : null });
  }

  const result = await mutationResponse(operation, runId, cli, runDir);
  jsonResponse(res, result.status, result.body);
};

export const createApiRouter = (): Router => {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  router.post('/runs', (req, res, next) => { void handleStartRun(req, res).catch(next); });
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
