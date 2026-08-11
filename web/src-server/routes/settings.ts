import express, { type Request, type Response, type Router } from 'express';
import { runControlPlane, runControlPlaneOperation } from '../lib/cli.js';
import { errorBody, jsonResponse } from '../lib/http.js';
import { operationResultBody, projectIdParam } from './routing.js';

type JsonRecord = Record<string, unknown>;

const getSettings = async (res: Response, projectId?: string): Promise<void> => {
  const result = await runControlPlane([...(projectId ? ['--project-id', projectId] : []), 'settings', 'get']);
  jsonResponse(res, result.status, result.body);
};

const setSettings = async (req: Request, res: Response, projectId?: string): Promise<void> => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'preferences update body must be an object'));
  const result = await runControlPlaneOperation({ operation: 'preferences.update', project_id: projectId, payload: { preferences: req.body } });
  jsonResponse(res, result.status, result.status === 200 ? operationResultBody(result.body) : result.body);
};

const getGitUser = async (res: Response, projectId?: string): Promise<void> => {
  const result = await runControlPlane([...(projectId ? ['--project-id', projectId] : []), 'git-user']);
  jsonResponse(res, result.status, result.body);
};

const setGitUser = async (req: Request, res: Response, projectId?: string): Promise<void> => {
  const body = (req.body || {}) as JsonRecord;
  const result = await runControlPlaneOperation({ operation: 'git-identity.update', project_id: projectId, payload: { ...body, scope: projectId ? 'project' : 'user' } });
  jsonResponse(res, result.status, result.status === 200 ? operationResultBody(result.body) : result.body);
};

export const createSettingsRouter = (): Router => {
  const router = express.Router();
  router.get('/settings', (_req, res, next) => { void getSettings(res).catch(next); });
  router.put('/settings', (req, res, next) => { void setSettings(req, res).catch(next); });
  router.get('/git-user', (_req, res, next) => { void getGitUser(res).catch(next); });
  router.put('/git-user', (req, res, next) => { void setGitUser(req, res).catch(next); });
  router.get('/projects/:projectId/settings', (req, res, next) => { const id = projectIdParam(req, res); if (id) void getSettings(res, id).catch(next); });
  router.put('/projects/:projectId/settings', (req, res, next) => { const id = projectIdParam(req, res); if (id) void setSettings(req, res, id).catch(next); });
  router.get('/projects/:projectId/git-user', (req, res, next) => { const id = projectIdParam(req, res); if (id) void getGitUser(res, id).catch(next); });
  router.put('/projects/:projectId/git-user', (req, res, next) => { const id = projectIdParam(req, res); if (id) void setGitUser(req, res, id).catch(next); });
  return router;
};
