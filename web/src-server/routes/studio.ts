import fs from 'node:fs';
import path from 'node:path';
import express, { type Router } from 'express';
import { runControlPlaneOperation } from '../lib/cli.js';
import { errorBody, jsonResponse, safeDecode } from '../lib/http.js';
import { ROOT_DIR, WORKSPACE_ROOT } from '../lib/paths.js';
import { resolveWithin } from '../lib/pathConfinement.js';
import { safeWriteJson, safeWriteText } from '../lib/safeWrite.js';
import { operationResultBody } from './routing.js';

type JsonRecord = Record<string, unknown>;
type StudioSidecar = { version: 1; status: string; draft?: JsonRecord; positions?: Record<string, { x: number; y: number }> };
const NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;
const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*\.(md\.tmpl|md|tmpl|txt)$/;
const workflowsRoot = (): string => path.join(WORKSPACE_ROOT, '.tesseraft', 'workflows');
const packageDir = (name: string): string => path.join(workflowsRoot(), name);
const workflowFile = (name: string): string => path.join(packageDir(name), 'workflow.edn');
const sidecarFile = (name: string): string => path.join(packageDir(name), 'studio-state.json');
const readableWorkflow = (name: string): string | null => [
  workflowFile(name),
  path.join(ROOT_DIR, 'examples', 'tutorials', name, 'workflow.edn'),
  path.join(ROOT_DIR, 'examples', 'catalog', name, 'workflow.edn')
].find(fs.existsSync) || null;
const assetPath = (raw: unknown): string | null => typeof raw === 'string' && raw !== '' && !raw.startsWith('/') && !raw.includes('..') && !raw.includes('\\') && !raw.split('/').includes('') && ASSET_RE.test(raw) ? raw : null;

const readSidecar = async (name: string): Promise<StudioSidecar> => {
  try { const parsed = JSON.parse(await fs.promises.readFile(sidecarFile(name), 'utf8')) as Partial<StudioSidecar>; return { ...parsed, version: 1, status: parsed.status || 'draft' }; }
  catch { return { version: 1, status: 'draft' }; }
};
const cleanDraft = (draft: JsonRecord): JsonRecord => {
  const clean = (value: unknown): unknown => {
    if (value === null || value === undefined) return undefined;
    if (['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (Array.isArray(value)) return value.map(clean).filter((v) => v !== undefined);
    if (typeof value === 'object') {
      const out: JsonRecord = {};
      for (const [key, nested] of Object.entries(value as JsonRecord)) {
        const v = clean(nested);
        if (v === undefined || v === null || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as JsonRecord).length === 0)) continue;
        out[key] = v;
      }
      return out;
    }
    return value;
  };
  return clean(draft) as JsonRecord;
};

export const createStudioRouter = (): Router => {
  const router = express.Router();
  const nameParam = (req: express.Request, res: express.Response): string | null => {
    const raw = req.params.name;
    const name = safeDecode(Array.isArray(raw) ? raw.join('/') : raw);
    if (name === null || !NAME_RE.test(name)) { jsonResponse(res, 400, errorBody(400, 'bad_request', 'name must match /^[a-z][a-z0-9-]{0,62}$/')); return null; }
    return name;
  };
  router.post('/studio/workflows', async (req, res, next) => {
    try {
      const body = (req.body || {}) as JsonRecord; const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!NAME_RE.test(name)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'name must match /^[a-z][a-z0-9-]{0,62}$/'));
      if (fs.existsSync(workflowFile(name)) || fs.existsSync(sidecarFile(name))) return jsonResponse(res, 409, errorBody(409, 'conflict', 'A workflow with that name already exists', { name }));
      const description = typeof body.description === 'string' ? body.description.trim() : '';
      const draft: JsonRecord = { 'api-version': 'tesseraft.workflow/v1', kind: 'workflow', metadata: description ? { name, description } : { name }, initial: null, states: {} };
      await safeWriteJson(sidecarFile(name), { version: 1, status: 'draft', draft, positions: {} });
      jsonResponse(res, 201, { workflow: { name, path: path.join('.tesseraft', 'workflows', name, 'workflow.edn') } });
    } catch (error) { next(error); }
  });
  router.get('/studio/workflows/:name', async (req, res, next) => {
    try {
      const name = nameParam(req, res); if (!name) return; const file = readableWorkflow(name); const state = await readSidecar(name);
      if (!file && !state.draft) return jsonResponse(res, 404, errorBody(404, 'not_found', 'Workflow not found', { name }));
      let normalized: unknown = state.draft;
      if (file) {
        const projectId = typeof req.query.project_id === 'string' ? req.query.project_id : undefined;
        const detail = await runControlPlaneOperation({ operation: 'workflow.read-package', project_id: projectId, payload: { name } });
        const result = detail.body && typeof detail.body === 'object' ? (detail.body as { result?: { workflow?: { normalized?: unknown } } }).result : undefined;
        if (detail.status === 200) normalized = result?.workflow?.normalized;
      }
      jsonResponse(res, 200, { workflow: { name, path: file ? path.relative(ROOT_DIR, file) : path.join('.tesseraft', 'workflows', name, 'workflow.edn'), normalized }, state });
    } catch (error) { next(error); }
  });
  router.put('/studio/workflows/:name', async (req, res, next) => {
    try {
      const name = nameParam(req, res); if (!name) return; const body = (req.body || {}) as JsonRecord;
      if (!body.draft || typeof body.draft !== 'object' || Array.isArray(body.draft)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Provide draft (object)'));
      const draft = cleanDraft(body.draft as JsonRecord); const positions = body.positions && typeof body.positions === 'object' && !Array.isArray(body.positions) ? body.positions as StudioSidecar['positions'] : undefined;
      if (body.save_mode === 'completed') {
        const projectId = typeof req.query.project_id === 'string' ? req.query.project_id : undefined;
        const saved = await runControlPlaneOperation({ operation: 'workflow.save', project_id: projectId, payload: { name, workflow: draft } });
        if (saved.status !== 200) return jsonResponse(res, saved.status, saved.body);
        await safeWriteJson(sidecarFile(name), { version: 1, status: 'completed', draft, positions });
        const result = operationResultBody(saved.body);
        return jsonResponse(res, 200, {
          ok: true,
          save_mode: 'completed',
          ...(result && typeof result === 'object' ? result as JsonRecord : {})
        });
      }
      await safeWriteJson(sidecarFile(name), { version: 1, status: 'draft', draft, positions });
      jsonResponse(res, 200, { ok: true, save_mode: 'draft', state: { draft, positions } });
    } catch (error) { next(error); }
  });
  router.post('/studio/workflows/:name/lint', async (req, res, next) => { try { const name = nameParam(req, res); if (!name) return; const state = await readSidecar(name); const workflow = req.body?.draft || state.draft; if (!workflow) return jsonResponse(res, 404, errorBody(404, 'not_found', 'Workflow draft not found', { name })); const projectId = typeof req.query.project_id === 'string' ? req.query.project_id : undefined; const checked = await runControlPlaneOperation({ operation: 'workflow.validate', project_id: projectId, payload: { name, workflow } }); if (checked.status !== 200) return jsonResponse(res, checked.status, checked.body); const result = checked.body && typeof checked.body === 'object' ? (checked.body as { result?: { lint?: unknown } }).result : undefined; jsonResponse(res, 200, result?.lint || { ok: false, errors: [], warnings: [], diagnostics: [] }); } catch (error) { next(error); } });

  const resolveAsset = (req: express.Request, res: express.Response): { name: string; relative: string; absolute: string } | null => {
    const name = nameParam(req, res); if (!name) return null;
    const raw = Array.isArray(req.params.assetPath) ? req.params.assetPath.join('/') : req.params.assetPath; const relative = assetPath(safeDecode(raw));
    const absolute = relative ? resolveWithin(packageDir(name), relative) : null;
    if (!relative || !absolute) { jsonResponse(res, 400, errorBody(400, 'bad_request', 'Invalid asset path: must be a safe relative path ending in .md.tmpl/.md/.tmpl/.txt')); return null; }
    return { name, relative, absolute };
  };
  router.get('/studio/workflows/:name/assets/*assetPath', async (req, res, next) => { try { const asset = resolveAsset(req, res); if (!asset) return; let stat: fs.Stats; try { stat = await fs.promises.stat(asset.absolute); } catch { return jsonResponse(res, 404, errorBody(404, 'not_found', 'Asset not found', { workflow: asset.name, path: asset.relative })); } if (!stat.isFile()) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Asset path is not a file')); jsonResponse(res, 200, { workflow: asset.name, path: asset.relative, rel_path: path.join('.tesseraft', 'workflows', asset.name, asset.relative), content: await fs.promises.readFile(asset.absolute, 'utf8') }); } catch (error) { next(error); } });
  router.put('/studio/workflows/:name/assets/*assetPath', async (req, res, next) => { try { const asset = resolveAsset(req, res); if (!asset) return; if (typeof req.body?.content !== 'string') return jsonResponse(res, 400, errorBody(400, 'bad_request', 'content must be a string')); if (req.body.content.length > 1024 * 1024) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'content must be at most 1MB')); await safeWriteText(asset.absolute, req.body.content); jsonResponse(res, 200, { ok: true, workflow: asset.name, path: asset.relative, rel_path: path.join('.tesseraft', 'workflows', asset.name, asset.relative) }); } catch (error) { next(error); } });
  return router;
};
