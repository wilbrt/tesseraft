import express, { type Router } from 'express';
import { runControlPlane } from '../lib/cli.js';
import { jsonResponse } from '../lib/http.js';

export const createCapabilitiesRouter = (): Router => {
  const router = express.Router();
  router.get('/work-tracker-providers', (_req, res, next) => {
    void runControlPlane(['project', 'work-tracker-providers']).then((result) => jsonResponse(res, result.status, result.body)).catch(next);
  });
  router.get('/capabilities', (_req, res, next) => {
    void runControlPlane(['capabilities']).then((result) => jsonResponse(res, result.status, result.body)).catch(next);
  });
  return router;
};
