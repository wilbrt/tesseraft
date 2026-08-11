import express, { type Router } from 'express';
import { runControlPlane } from '../lib/cli.js';
import { jsonResponse } from '../lib/http.js';
import { controlPlaneGet, decodedParam, deprecatedDefaultProjectRoute, projectIdParam } from './routing.js';

export const createWorkflowsRouter = (): Router => {
  const router = express.Router();
  router.get('/workflows', (req, res, next) => { deprecatedDefaultProjectRoute(res); controlPlaneGet(['workflows'])(req, res, next); });
  router.get('/workflows/:name', (req, res, next) => { deprecatedDefaultProjectRoute(res); const name = decodedParam(req, res, 'name', 'workflow name'); if (name) controlPlaneGet(['workflow', name])(req, res, next); });
  router.get('/workflows/:name/graph', (req, res, next) => { deprecatedDefaultProjectRoute(res); const name = decodedParam(req, res, 'name', 'workflow name'); if (name) controlPlaneGet(['graph', name])(req, res, next); });
  router.get('/projects/:projectId/workflows', (req, res, next) => { const id = projectIdParam(req, res); if (id) void runControlPlane(['--project-id', id, 'workflows']).then((r) => jsonResponse(res, r.status, r.body)).catch(next); });
  router.get('/projects/:projectId/workflows/:name', (req, res, next) => {
    const id = projectIdParam(req, res); const name = decodedParam(req, res, 'name', 'workflow name');
    if (id && name) void runControlPlane(['--project-id', id, 'workflow', name]).then((r) => jsonResponse(res, r.status, r.body)).catch(next);
  });
  router.get('/projects/:projectId/workflows/:name/graph', (req, res, next) => {
    const id = projectIdParam(req, res); const name = decodedParam(req, res, 'name', 'workflow name');
    if (id && name) void runControlPlane(['--project-id', id, 'graph', name]).then((r) => jsonResponse(res, r.status, r.body)).catch(next);
  });
  return router;
};
