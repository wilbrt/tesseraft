import fs from 'node:fs';
import path from 'node:path';
import express, { type Router } from 'express';
import { errorBody, jsonResponse } from '../lib/http.js';
import { ROOT_DIR, WORKSPACE_ROOT } from '../lib/paths.js';
import type { PiSessionAdapter } from '../lib/piSessionAdapter.js';
import { createBrowseRouter } from './browse.js';
import { createCapabilitiesRouter } from './capabilities.js';
import { createPiSessionsRouter } from './piSessions.js';
import { createProjectsRouter } from './projects.js';
import { createRunsRouter } from './runs.js';
import { createSettingsRouter } from './settings.js';
import { createStudioRouter } from './studio.js';
import { createWorkflowsRouter } from './workflows.js';

export type ApiRouterOptions = { piSessionAdapter?: PiSessionAdapter; browserAllowedProjectRoots?: string[] };

export const createApiRouter = (options: ApiRouterOptions = {}): Router => {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));
  router.get('/health', (_req, res) => jsonResponse(res, 200, {
    ok: true,
    status: 'ready',
    workspace_root: WORKSPACE_ROOT,
    checks: { static_assets: fs.existsSync(path.join(ROOT_DIR, 'web', 'static', 'index.html')) }
  }));
  router.use(createPiSessionsRouter(options.piSessionAdapter));
  router.use(createBrowseRouter());
  router.use(createCapabilitiesRouter());
  router.use(createProjectsRouter(options.browserAllowedProjectRoots));
  router.use(createSettingsRouter());
  router.use(createWorkflowsRouter());
  router.use(createStudioRouter());
  router.use(createRunsRouter());
  router.use((req, res) => {
    const status = req.method === 'GET' ? 404 : 405;
    jsonResponse(res, status, errorBody(status, status === 404 ? 'not_found' : 'method_not_allowed', status === 404 ? 'API route not found' : 'Only GET, POST, PUT, and DELETE are supported for API routes'));
  });
  return router;
};
