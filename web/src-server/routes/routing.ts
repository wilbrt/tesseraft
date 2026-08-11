import type { Request, Response } from 'express';
import { runControlPlane } from '../lib/cli.js';
import { errorBody, jsonResponse, safeDecode } from '../lib/http.js';

export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const deprecatedDefaultProjectRoute = (res: Response): void => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Link', '</api/projects/default>; rel="successor-version"');
};

export const decodedParam = (req: Request, res: Response, key: string, label: string): string | null => {
  const raw = req.params[key];
  const value = safeDecode(Array.isArray(raw) ? raw.join('/') : raw);
  if (value === null) jsonResponse(res, 400, errorBody(400, 'bad_request', `Malformed ${label}`));
  return value;
};

export const projectIdParam = (req: Request, res: Response): string | null => {
  const id = decodedParam(req, res, 'projectId', 'project id');
  if (id !== null && !PROJECT_ID_RE.test(id)) {
    jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed project id'));
    return null;
  }
  return id;
};

export const controlPlaneGet = (args: string[]) =>
  (_req: Request, res: Response, next: (error?: unknown) => void): void => {
    void runControlPlane(args).then((result) => jsonResponse(res, result.status, result.body)).catch(next);
  };

export const operationResultBody = (body: unknown): unknown => {
  if (!body || typeof body !== 'object' || !('result' in body)) return body;
  return (body as { result: unknown }).result;
};
