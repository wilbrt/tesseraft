import fs from 'node:fs';
import express, { type Request, type Response, type Router } from 'express';
import { runControlPlane, runControlPlaneOperation } from '../lib/cli.js';
import { errorBody, jsonResponse } from '../lib/http.js';
import { canonicalRoots, isWithinAny } from '../lib/pathConfinement.js';
import { operationResultBody, projectIdParam } from './routing.js';

type JsonRecord = Record<string, unknown>;

const RAW_SECRET_KEYS = new Set(['token', 'apikey', 'accesstoken', 'password', 'secret']);
const containsRawSecret = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsRawSecret);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as JsonRecord).some(([key, nested]) => {
    const normalized = key.toLowerCase().replace(/[_-]/g, '');
    return RAW_SECRET_KEYS.has(normalized) || normalized.endsWith('token') || containsRawSecret(nested);
  });
};

const readableCanonicalRoot = (value: unknown): { root?: string; error?: string } => {
  if (typeof value !== 'string' || value.trim() === '') return { error: 'project_root is required for browser project registration' };
  try { return { root: fs.realpathSync(value.trim()) }; }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
};

export const createProjectsRouter = (configuredRoots: string[] = []): Router => {
  const router = express.Router();
  const allowedRoots = canonicalRoots(configuredRoots);
  const requireAllowedRoot = (res: Response, value: unknown): string | null => {
    const resolved = readableCanonicalRoot(value);
    if (!resolved.root) { jsonResponse(res, 400, errorBody(400, 'bad_request', resolved.error || 'project_root is not readable')); return null; }
    if (allowedRoots.length === 0 || !isWithinAny(resolved.root, allowedRoots)) {
      jsonResponse(res, 400, errorBody(400, 'project_root_not_allowed', 'project_root is outside the configured browser project roots', { project_root: resolved.root, allowed_roots: allowedRoots }));
      return null;
    }
    return resolved.root;
  };

  router.get('/projects', (_req, res, next) => { void runControlPlane(['projects']).then((r) => jsonResponse(res, r.status, r.body)).catch(next); });
  router.post('/projects', (req, res, next) => {
    const root = requireAllowedRoot(res, req.body?.project_root);
    if (root) void runControlPlaneOperation({ operation: 'project.register', payload: { project_root: root } }).then((r) => jsonResponse(res, r.status === 200 ? 201 : r.status, r.status === 200 ? operationResultBody(r.body) : r.body)).catch(next);
  });
  router.get('/projects/:projectId', (req, res, next) => { const id = projectIdParam(req, res); if (id) void runControlPlane(['project', id]).then((r) => jsonResponse(res, r.status, r.body)).catch(next); });
  router.put('/projects/:projectId', (req, res, next) => { const id = projectIdParam(req, res); if (id) void runControlPlaneOperation({ operation: 'project.update', project_id: id, payload: req.body || {} }).then((r) => jsonResponse(res, r.status, r.status === 200 ? operationResultBody(r.body) : r.body)).catch(next); });
  router.delete('/projects/:projectId', (req, res, next) => { const id = projectIdParam(req, res); if (id) void runControlPlaneOperation({ operation: 'project.delete', project_id: id }).then((r) => jsonResponse(res, r.status, r.status === 200 ? operationResultBody(r.body) : r.body)).catch(next); });
  router.get('/projects/:projectId/doctor', (req, res, next) => { const id = projectIdParam(req, res); if (id) void runControlPlane(['--project-id', id, 'doctor'], { timeout: 12000 }).then((r) => jsonResponse(res, r.status, r.body)).catch(next); });
  router.get('/projects/:projectId/connections', (req, res, next) => { const id = projectIdParam(req, res); if (id) void runControlPlane(['project', 'connections', id]).then((r) => jsonResponse(res, r.status, r.body)).catch(next); });
  router.put('/projects/:projectId/connections', (req, res, next) => {
    const id = projectIdParam(req, res);
    if (!id) return;
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'connections update body must be an object'));
    if (containsRawSecret(req.body)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Raw secret payloads are not accepted; provide a credential_ref instead'));
    void runControlPlaneOperation({ operation: 'project.connections.update', project_id: id, payload: { connections: req.body } }).then((r) => jsonResponse(res, r.status, r.status === 200 ? operationResultBody(r.body) : r.body)).catch(next);
  });
  return router;
};
