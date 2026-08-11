import express, { type Request, type Response, type Router } from 'express';
import { errorBody, jsonResponse, safeDecode } from '../lib/http.js';
import { createConfiguredPiSessionAdapter, type PiSessionAdapter } from '../lib/piSessionAdapter.js';

type JsonRecord = Record<string, unknown>;

const handleError = (res: Response, error: unknown): void => {
  const err = error as Error & { status?: number; code?: string };
  const status = err.status || 500;
  jsonResponse(res, status, errorBody(status, err.code || (status === 500 ? 'internal_error' : 'bad_request'), err.message || 'Pi session request failed'));
};

const optionalString = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const snapshot = async (adapter: PiSessionAdapter, sessionId: string): Promise<unknown | null> => {
  const session = await adapter.getSession(sessionId);
  if (!session) return null;
  return { session, messages: await adapter.listMessages(sessionId) || [] };
};

const stream = async (req: Request, res: Response, adapter: PiSessionAdapter, sessionId: string): Promise<void> => {
  if (!await snapshot(adapter, sessionId)) return jsonResponse(res, 404, errorBody(404, 'not_found', 'Pi session not found', { session_id: sessionId }));
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
  res.write(': connected\n\n');
  let closed = false;
  let inFlight = false;
  let lastPayload = '';
  let interval: ReturnType<typeof setInterval> | null = null;
  const close = (): void => { if (!closed) { closed = true; if (interval) clearInterval(interval); res.end(); } };
  const send = async (): Promise<void> => {
    if (closed) return;
    const current = await snapshot(adapter, sessionId);
    if (!current) return close();
    const payload = JSON.stringify(current);
    if (payload !== lastPayload) { lastPayload = payload; res.write(`event: snapshot\ndata: ${payload}\n\n`); }
    else res.write(': heartbeat\n\n');
  };
  const poll = (): void => {
    if (closed || inFlight) return;
    inFlight = true;
    void send().catch((error) => { if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`); }).finally(() => { inFlight = false; });
  };
  await send();
  if (!closed) interval = setInterval(poll, 1000);
  req.on('close', close);
};

export const createPiSessionsRouter = (adapter: PiSessionAdapter = createConfiguredPiSessionAdapter()): Router => {
  const router = express.Router();
  router.get('/pi-sessions', (_req, res, next) => { void adapter.listSessions().then((sessions) => jsonResponse(res, 200, { sessions })).catch(next); });
  router.post('/pi-sessions', async (req, res) => {
    try {
      const body = (req.body || {}) as JsonRecord;
      jsonResponse(res, 201, { session: await adapter.createSession({ id: optionalString(body.id), title: optionalString(body.title) }) });
    } catch (error) { handleError(res, error); }
  });
  router.get('/pi-sessions/:sessionId', (req, res, next) => {
    const sessionId = safeDecode(req.params.sessionId);
    if (sessionId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed Pi session id'));
    return void adapter.getSession(sessionId).then((session) => session ? jsonResponse(res, 200, { session }) : jsonResponse(res, 404, errorBody(404, 'not_found', 'Pi session not found', { session_id: sessionId }))).catch(next);
  });
  router.post('/pi-sessions/:sessionId/prompts', async (req, res, next) => {
    try {
      const sessionId = safeDecode(req.params.sessionId);
      if (sessionId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed Pi session id'));
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
      if (!prompt) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'prompt is required'));
      const result = await adapter.sendPrompt(sessionId, prompt);
      return result ? jsonResponse(res, 200, result) : jsonResponse(res, 404, errorBody(404, 'not_found', 'Pi session not found', { session_id: sessionId }));
    } catch (error) { next(error); }
  });
  router.get('/pi-sessions/:sessionId/events', (req, res, next) => {
    const sessionId = safeDecode(req.params.sessionId);
    const raw = Array.isArray(req.query.after) ? req.query.after[0] : req.query.after;
    if (sessionId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed Pi session id'));
    const after = raw === undefined ? undefined : Number(raw);
    if (after !== undefined && (!Number.isInteger(after) || after < 0)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'after must be a non-negative integer'));
    return void adapter.listEvents(sessionId, after).then((events) => events ? jsonResponse(res, 200, { session_id: sessionId, events }) : jsonResponse(res, 404, errorBody(404, 'not_found', 'Pi session not found', { session_id: sessionId }))).catch(next);
  });
  router.get('/pi-sessions/:sessionId/stream', (req, res, next) => {
    const sessionId = safeDecode(req.params.sessionId);
    if (sessionId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed Pi session id'));
    return void stream(req, res, adapter, sessionId).catch(next);
  });
  return router;
};
