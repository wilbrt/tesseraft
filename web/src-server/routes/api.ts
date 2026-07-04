import type { Request, Response, Router } from 'express';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { runControlPlane, runLint, runRuntime, startRuntime, type ControlPlaneResult, type RuntimeResult } from '../lib/cli.js';
import { toEdn } from '../lib/edn.js';
import { errorBody, jsonResponse, safeDecode } from '../lib/http.js';
import { ROOT_DIR, WORKSPACE_ROOT } from '../lib/paths.js';
import { createConfiguredPiSessionAdapter, type PiSessionAdapter } from '../lib/piSessionAdapter.js';

type ApiRoute = string[] | { badRequest: string } | { notFound: true } | null;
type JsonRecord = Record<string, unknown>;

export const routeApi = (pathname: string, searchParams: URLSearchParams = new URLSearchParams()): ApiRoute => {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api') return null;
  if (parts.length === 2 && parts[1] === 'workflows') return ['workflows'];
  if (parts.length === 2 && parts[1] === 'browse') return ['browse'];
  if (parts.length === 3 && parts[1] === 'workflows') {
    const name = safeDecode(parts[2]);
    return name === null ? { badRequest: 'Malformed workflow name' } : ['workflow', name];
  }
  if (parts.length === 4 && parts[1] === 'workflows' && parts[3] === 'graph') {
    const name = safeDecode(parts[2]);
    return name === null ? { badRequest: 'Malformed workflow name' } : ['graph', name];
  }
  if (parts.length === 2 && parts[1] === 'git-user') return ['git-user'];
  if (parts.length === 2 && parts[1] === 'settings') return ['settings'];
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

const runSnapshot = async (runId: string): Promise<unknown> => {
  const [detail, events, artifacts, runs] = await Promise.all([
    runControlPlane(['run', runId]),
    runControlPlane(['events', runId]),
    runControlPlane(['artifacts', runId]),
    runControlPlane(['runs'])
  ]);
  if (detail.status !== 200) return detail.body;
  return {
    run_id: runId,
    run: detail.body && typeof detail.body === 'object' && 'run' in detail.body ? (detail.body as { run?: unknown }).run : null,
    events: events.status === 200 && events.body && typeof events.body === 'object' && 'events' in events.body ? (events.body as { events?: unknown[] }).events || [] : [],
    artifacts: artifacts.status === 200 && artifacts.body && typeof artifacts.body === 'object' && 'artifacts' in artifacts.body ? (artifacts.body as { artifacts?: unknown[] }).artifacts || [] : [],
    runs: runs.status === 200 && runs.body && typeof runs.body === 'object' && 'runs' in runs.body ? (runs.body as { runs?: unknown[] }).runs || [] : []
  };
};

const mutationResponse = async (operation: string, runId: string, cli: RuntimeResult, runDir?: string): Promise<{ status: number; body: unknown }> => {
  const detail = await refreshedRun(runId);
  return { status: cli.status, body: { operation, status: cli.status === 200 ? 'ok' : 'error', run_id: runId, cli: { exit_code: cli.exitCode, stderr: cli.stderr || undefined, result: cli.body }, latest_runtime: runDir ? await inspectRuntime(runDir) : null, run_detail: detail.status === 200 ? detail.body : null } };
};

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const isBasicEmail = (value: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);

type BrowseEntry = { name: string; is_dir: boolean; is_file: boolean };

const isUnderRoot = (resolved: string, root: string): boolean => resolved === root || resolved.startsWith(root + path.sep);

const handleBrowse = async (req: Request, res: Response): Promise<void> => {
  const root = ROOT_DIR;
  const rawPath = typeof req.query.path === 'string' && req.query.path.trim() !== '' ? req.query.path : '.';
  const resolved = path.resolve(root, rawPath);
  if (!isUnderRoot(resolved, root)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Path is outside the allowed root', { root, requested: rawPath }));
  let real: string;
  let stat: fs.Stats;
  try {
    real = await fs.promises.realpath(resolved);
    stat = await fs.promises.stat(real);
  } catch {
    return jsonResponse(res, 404, errorBody(404, 'not_found', 'Path not found', { path: rawPath }));
  }
  if (!isUnderRoot(real, root)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Resolved path is outside the allowed root', { root }));
  if (!stat.isDirectory()) {
    return jsonResponse(res, 200, { root, path: real, is_file: true, is_dir: false, entries: [] });
  }
  let names: string[];
  try {
    names = await fs.promises.readdir(real);
  } catch {
    return jsonResponse(res, 200, { root, path: real, is_file: false, is_dir: true, entries: [] });
  }
  const entries: BrowseEntry[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    let entryStat: fs.Stats;
    try {
      entryStat = await fs.promises.stat(path.join(real, name));
    } catch {
      continue;
    }
    entries.push({ name, is_dir: entryStat.isDirectory(), is_file: entryStat.isFile() });
  }
  entries.sort((a, b) => (Number(b.is_dir) - Number(a.is_dir)) || a.name.localeCompare(b.name));
  return jsonResponse(res, 200, { root, path: real, is_file: false, is_dir: true, entries });
};

const handleGetGitUser = async (res: Response): Promise<void> => {
  const result = await runControlPlane(['git-user']);
  return jsonResponse(res, result.status, result.body);
};

const handleSetGitUser = async (req: Request, res: Response): Promise<void> => {
  const body = req.body as JsonRecord;
  const name = body.name;
  const email = body.email;
  if (!isNonEmptyString(name)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'name is required and must be a non-empty string'));
  if (name.length > 200) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'name must be at most 200 characters'));
  if (/\n/.test(name)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'name must not contain newlines'));
  if (!isNonEmptyString(email) || !isBasicEmail(email)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'email is required and must be a valid address'));
  const result = await runControlPlane(['git-user', 'set', '--name', name, '--email', email]);
  return jsonResponse(res, result.status, result.body);
};

const readMaxSteps = (value: unknown, fallback: number): number | null => {
  if (value === undefined) return fallback;
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 1000 ? value as number : null;
};

const EMAIL_RE = /^\S+@\S+\.\S+$/;

const SETTINGS_TOKEN_FIELDS = new Set(['github_token', 'jira_token']);
const SETTINGS_NON_TOKEN_FIELDS = new Set(['pi_default_provider', 'pi_default_model', 'default_repo_root']);
const SETTINGS_FIELDS = new Set([...SETTINGS_TOKEN_FIELDS, ...SETTINGS_NON_TOKEN_FIELDS]);
const SETTINGS_LENGTH_LIMITS: Record<string, number> = {
  pi_default_provider: 100, pi_default_model: 200,
  github_token: 500, jira_token: 500, default_repo_root: 1000
};
const SETTINGS_UNCHANGED = '__unchanged__';

const validateSettingsField = (field: string, value: unknown): string | null => {
  if (typeof value !== 'string') return `${field} must be a string`;
  if (value.trim() === '') return `${field} must not be empty`;
  if (/\n/.test(value)) return `${field} must not contain newlines`;
  const limit = SETTINGS_LENGTH_LIMITS[field];
  if (limit && value.length > limit) return `${field} must be at most ${limit} characters`;
  return null;
};

const handleGetSettings = async (res: Response): Promise<void> => {
  const result = await runControlPlane(['settings', 'get']);
  return jsonResponse(res, result.status, result.body);
};

const handleSetSettings = async (req: Request, res: Response): Promise<void> => {
  const body = req.body as JsonRecord;
  const updates: JsonRecord = {};
  for (const [field, raw] of Object.entries(body)) {
    if (!SETTINGS_FIELDS.has(field)) return jsonResponse(res, 400, errorBody(400, 'bad_request', `Unknown settings field: ${field}`));
    // Token unchanged sentinel: null or the literal sentinel preserves.
    if (SETTINGS_TOKEN_FIELDS.has(field) && (raw === null || raw === SETTINGS_UNCHANGED)) {
      updates[field] = SETTINGS_UNCHANGED;
      continue;
    }
    if (raw === null) {
      // Non-token field cleared.
      updates[field] = null;
      continue;
    }
    const err = validateSettingsField(field, raw);
    if (err) return jsonResponse(res, 400, errorBody(400, 'bad_request', err));
    updates[field] = raw;
  }
  const args = ['settings', 'set'];
  for (const [field, value] of Object.entries(updates)) {
    const flag = `--${field.replace(/_/g, '-')}`;
    if (value === null) args.push(`--clear-${field.replace(/_/g, '-')}`);
    else if (value === SETTINGS_UNCHANGED) args.push(flag, SETTINGS_UNCHANGED);
    else args.push(flag, String(value));
  }
  const result = await runControlPlane(args);
  return jsonResponse(res, result.status, result.body);
};


// Workflow Studio authoring routes write workflow definition files under
// `.tesseraft/workflows/<name>/workflow.edn` (project workspace). The CLI
// discovers project workflows there, so the file is the source of truth once
// written. Writes are path-confined to the project workflows root; drafts may
// be invalid EDN-wise (linter is the authority on save-completed).
const WORKFLOW_NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;
const projectWorkflowsRoot = (): string => path.join(WORKSPACE_ROOT, '.tesseraft', 'workflows');
const workflowFilePath = (name: string): string => path.join(projectWorkflowsRoot(), name, 'workflow.edn');
const workflowStatePath = (name: string): string => path.join(projectWorkflowsRoot(), name, 'studio-state.json');

type StudioSidecar = { status: string; draft?: JsonRecord; positions?: Record<string, { x: number; y: number }>; lint?: { ok?: boolean; errors?: unknown[]; warnings?: unknown[] } };

const readStudioState = async (name: string): Promise<StudioSidecar> => {
  try {
    const raw = await fs.promises.readFile(workflowStatePath(name), 'utf8');
    return JSON.parse(raw) as StudioSidecar;
  } catch {
    return { status: 'draft' };
  }
};
const writeStudioState = async (name: string, state: StudioSidecar): Promise<void> => {
  await fs.promises.mkdir(path.dirname(workflowStatePath(name)), { recursive: true });
  await fs.promises.writeFile(workflowStatePath(name), JSON.stringify(state, null, 2), 'utf8');
};

// Drop empty/optional fields so emitted EDN stays minimal and lint-friendly.
// Keyword-valued strings keep their leading colon; empty strings, empty
// objects/arrays, and null are omitted. `states` keys become string keys in
// the EDN map (the emitter turns them into keywords).
// Coerce id-reference fields the UI stores sans-colon into EDN keywords.
// `initial`, per-node `next`, and per-transition `next` reference state ids;
// the emitter only writes colon-prefixed strings as keywords, so prefix them
// here. Other string values (e.g. :when condition values, metadata) stay as
// quoted strings. The sidecar keeps the raw sans-colon draft for UI reload.
const coerceKeyword = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const str = String(value);
  if (str === '') return undefined;
  return str.startsWith(':') ? str : `:${str}`;
};

const coerceDraftKeywords = (draft: JsonRecord): JsonRecord => {
  const out: JsonRecord = { ...draft };
  out.initial = coerceKeyword(draft.initial) ?? null;
  const statesIn = (draft.states || {}) as Record<string, JsonRecord>;
  const statesOut: Record<string, JsonRecord> = {};
  for (const id of Object.keys(statesIn)) {
    const node = { ...statesIn[id] };
    if (node.next) node.next = coerceKeyword(node.next);
    if (Array.isArray(node.transitions)) {
      node.transitions = (node.transitions as JsonRecord[]).map((t) => ({ ...t, next: coerceKeyword(t.next) }));
    }
    statesOut[id] = node;
  }
  out.states = statesOut;
  return out;
};

const sanitizeDraft = (draft: JsonRecord): JsonRecord => {
  const clean = (value: unknown): unknown => {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map(clean).filter((item) => item !== undefined);
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        const cleaned = clean(val);
        if (cleaned === undefined || cleaned === null) continue;
        if (Array.isArray(cleaned) && cleaned.length === 0) continue;
        if (typeof cleaned === 'object' && !Array.isArray(cleaned) && Object.keys(cleaned as Record<string, unknown>).length === 0) continue;
        out[key] = cleaned;
      }
      return out;
    }
    return value;
  };
  const result = clean(draft) as JsonRecord;
  return result;
};

const scaffoldWorkflowEdn = (name: string, description?: string): string => {
  const metadata: Record<string, string> = { name };
  if (description) metadata.description = description;
  const workflow = {
    'api-version': 'tesseraft.workflow/v1',
    kind: ':workflow',
    metadata,
    initial: null,
    states: {}
  };
  return toEdn(workflow);
};

const handleCreateStudioWorkflow = async (req: Request, res: Response): Promise<void> => {
  const body = req.body as JsonRecord;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!WORKFLOW_NAME_RE.test(name)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'name must match /^[a-z][a-z0-9-]{0,62}$/'));
  const fileDir = path.join(projectWorkflowsRoot(), name);
  const filePath = workflowFilePath(name);
  if (fs.existsSync(filePath)) return jsonResponse(res, 409, errorBody(409, 'conflict', 'A workflow with that name already exists', { name }));
  await fs.promises.mkdir(fileDir, { recursive: true });
  const draft: JsonRecord = { 'api-version': 'tesseraft.workflow/v1', kind: ':workflow', metadata: description ? { name, description } : { name }, initial: null, states: {} };
  await fs.promises.writeFile(filePath, scaffoldWorkflowEdn(name, description || undefined), 'utf8');
  await writeStudioState(name, { status: 'draft', draft, positions: {} });
  jsonResponse(res, 201, { workflow: { name, path: path.join('.tesseraft', 'workflows', name, 'workflow.edn') } });
};

const handleGetStudioWorkflow = async (req: Request, res: Response, name: string): Promise<void> => {
  const filePath = workflowFilePath(name);
  if (!fs.existsSync(filePath)) return jsonResponse(res, 404, errorBody(404, 'not_found', 'Workflow not found', { name }));
  let edn: string;
  try {
    edn = await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    return jsonResponse(res, 500, errorBody(500, 'internal_error', error instanceof Error ? error.message : 'Failed to read workflow'));
  }
  const state = await readStudioState(name);
  jsonResponse(res, 200, { workflow: { name, path: path.join('.tesseraft', 'workflows', name, 'workflow.edn'), edn }, state });
};

const handlePutStudioWorkflow = async (req: Request, res: Response, name: string): Promise<void> => {
  if (!WORKFLOW_NAME_RE.test(name)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'name must match /^[a-z][a-z0-9-]{0,62}$/'));
  const body = req.body as JsonRecord;
  const mode = body.save_mode === 'completed' ? 'completed' : 'draft';
  // Accept either pre-formatted EDN text (`edn`) or a JSON draft (`draft`) the
  // server serializes via toEdn. The UI sends `draft` to avoid duplicating the
  // EDN emitter in the bundle; the server is the serialization authority.
  let payloadEdn: string | null = null;
  let draftSnapshot: JsonRecord | null = null;
  if (typeof body.edn === 'string') {
    payloadEdn = body.edn;
  } else if (body.draft && typeof body.draft === 'object') {
    draftSnapshot = sanitizeDraft(body.draft as JsonRecord);
    payloadEdn = toEdn(coerceDraftKeywords(draftSnapshot));
  }
  if (!payloadEdn) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Provide edn (string) or draft (object)'));
  const positions = body.positions && typeof body.positions === 'object' && !Array.isArray(body.positions) ? body.positions as Record<string, { x: number; y: number }> : undefined;
  const filePath = workflowFilePath(name);
  const dir = path.dirname(filePath);
  const draftsRoot = projectWorkflowsRoot();
  const resolvedDir = path.resolve(dir);
  if (!isUnderRoot(resolvedDir, draftsRoot)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Resolved path is outside the allowed root'));
  // For completed saves, lint before persisting the real file. Write to a temp
  // file under the same directory so the linter reads a real path, then either
  // promote or reject without clobbering the existing file.
  if (mode === 'completed') {
    const tmpPath = path.join(dir, `.studio-lint-${Date.now()}.edn`);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(tmpPath, payloadEdn, 'utf8');
    try {
      const lint = await runLint(tmpPath);
      if (!lint.ok) {
        return jsonResponse(res, 422, { status: 422, ok: false, save_mode: 'completed', lint: { ok: false, errors: lint.errors, warnings: lint.warnings, diagnostics: lint.diagnostics } });
      }
      await fs.promises.writeFile(filePath, payloadEdn, 'utf8');
      await writeStudioState(name, { status: 'completed', draft: draftSnapshot || undefined, positions, lint: { ok: true, errors: lint.errors, warnings: lint.warnings } });
      return jsonResponse(res, 200, { workflow: { name, path: path.join('.tesseraft', 'workflows', name, 'workflow.edn') }, ok: true, save_mode: 'completed', lint: { ok: true, errors: lint.errors, warnings: lint.warnings } });
    } finally {
      try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
    }
  }
  // Draft: persist unconditionally; lint non-blocking.
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(filePath, payloadEdn, 'utf8');
  let lint: Awaited<ReturnType<typeof runLint>> | null = null;
  try { lint = await runLint(filePath); } catch { lint = null; }
  await writeStudioState(name, { status: 'draft', draft: draftSnapshot || undefined, positions, lint: lint ? { ok: lint.ok, errors: lint.errors, warnings: lint.warnings } : undefined });
  jsonResponse(res, 200, { workflow: { name, path: path.join('.tesseraft', 'workflows', name, 'workflow.edn') }, ok: true, save_mode: 'draft', lint: lint ? { ok: lint.ok, errors: lint.errors, warnings: lint.warnings } : null });
};

const handleLintStudioWorkflow = async (req: Request, res: Response, name: string): Promise<void> => {
  void req;
  const filePath = workflowFilePath(name);
  if (!fs.existsSync(filePath)) return jsonResponse(res, 404, errorBody(404, 'not_found', 'Workflow not found', { name }));
  const lint = await runLint(filePath);
  jsonResponse(res, 200, { ok: lint.ok, errors: lint.errors, warnings: lint.warnings, diagnostics: lint.diagnostics });
}

const readGitUser = (value: unknown): { name: string; email: string } | undefined | 'invalid' => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const obj = value as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  const email = typeof obj.email === 'string' ? obj.email.trim() : '';
  if (name === '' && email === '') return undefined;
  if (name !== '' && email !== '' && EMAIL_RE.test(email)) return { name, email };
  return 'invalid';
};

const handleStartRun = async (req: Request, res: Response): Promise<void> => {
  const body = req.body as JsonRecord;
  const workflowName = body.workflow_name;
  const runId = body.run_id;
  const inputs = body.inputs ?? {};
  const maxSteps = readMaxSteps(body.max_steps, 100);
  const gitUser = readGitUser(body.git_user);
  if (typeof workflowName !== 'string' || workflowName.trim() === '') return jsonResponse(res, 400, errorBody(400, 'bad_request', 'workflow_name is required'));
  if (typeof runId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(runId)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'run_id is required and may contain only letters, numbers, dot, underscore, and dash'));
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || Object.values(inputs).some((value) => typeof value !== 'string')) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'inputs must be an object of string values'));
  if (maxSteps === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'max_steps must be an integer from 1 to 1000'));
  if (gitUser === 'invalid') return jsonResponse(res, 400, errorBody(400, 'bad_request', 'git_user requires both name and a valid email, or neither'));

  const existing = await refreshedRun(runId);
  if (existing.status === 200) return jsonResponse(res, 409, errorBody(409, 'conflict', 'Run id already exists', { run_id: runId }));

  const workflow = await runControlPlane(['workflow', workflowName]);
  if (workflow.status !== 200) return jsonResponse(res, workflow.status, workflow.body);
  const filePath = workflowPath(workflow.body);
  if (!filePath) return jsonResponse(res, 502, errorBody(502, 'bad_gateway', 'Workflow detail did not include a path'));

  const startArgs = ['start', filePath, '--run-id', runId, '--format', 'json'];
  for (const [key, value] of Object.entries(inputs as Record<string, string>)) startArgs.push('--input', `${key}=${value}`);
  if (gitUser) { startArgs.push('--git-user-name', gitUser.name, '--git-user-email', gitUser.email); }
  const started = await runRuntime(startArgs);
  const runDir = started.body && typeof started.body === 'object' ? (started.body as { run?: { dir?: unknown } }).run?.dir : undefined;
  if (started.status !== 200 || typeof runDir !== 'string') {
    const result = await mutationResponse('start', runId, started, typeof runDir === 'string' ? runDir : undefined);
    return jsonResponse(res, result.status, result.body);
  }

  const background = startRuntime(['resume', '--run-dir', runDir, '--max-steps', String(maxSteps), '--format', 'json']);
  const detail = await refreshedRun(runId);
  jsonResponse(res, 202, { operation: 'start', status: 'running', code: 'background_started', run_id: runId, background, cli: { exit_code: started.exitCode, result: started.body }, latest_runtime: await inspectRuntime(runDir), run_detail: detail.status === 200 ? detail.body : null });
};

const handlePiError = (res: Response, error: unknown): void => {
  const err = error as Error & { status?: number; code?: string };
  const status = err.status || 500;
  const code = err.code || (status === 500 ? 'internal_error' : 'bad_request');
  jsonResponse(res, status, errorBody(status, code, err.message || 'Pi session request failed'));
};

const readOptionalString = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const handleCreatePiSession = async (req: Request, res: Response, adapter: PiSessionAdapter): Promise<void> => {
  try {
    const body = (req.body || {}) as JsonRecord;
    const session = await adapter.createSession({ id: readOptionalString(body.id), title: readOptionalString(body.title) });
    jsonResponse(res, 201, { session });
  } catch (error) {
    handlePiError(res, error);
  }
};

const handleSendPiPrompt = async (req: Request, res: Response, adapter: PiSessionAdapter, sessionId: string): Promise<void> => {
  const body = req.body as JsonRecord;
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'prompt is required'));
  const result = await adapter.sendPrompt(sessionId, prompt);
  if (!result) return jsonResponse(res, 404, errorBody(404, 'not_found', 'Pi session not found', { session_id: sessionId }));
  jsonResponse(res, 200, result);
};

const piSessionSnapshot = async (adapter: PiSessionAdapter, sessionId: string): Promise<unknown | null> => {
  const session = await adapter.getSession(sessionId);
  if (!session) return null;
  const messages = await adapter.listMessages(sessionId);
  return { session, messages: messages || [] };
};

const handlePiSessionStream = async (req: Request, res: Response, adapter: PiSessionAdapter, sessionId: string): Promise<void> => {
  const initial = await piSessionSnapshot(adapter, sessionId);
  if (!initial) return jsonResponse(res, 404, errorBody(404, 'not_found', 'Pi session not found', { session_id: sessionId }));

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  });
  res.write(': connected\n\n');
  let closed = false;
  let lastPayload = '';
  let interval: ReturnType<typeof setInterval> | null = null;

  const closeStream = (): void => {
    if (closed) return;
    closed = true;
    if (interval) clearInterval(interval);
    res.end();
  };
  const sendSnapshot = async (): Promise<void> => {
    if (closed) return;
    const snapshot = await piSessionSnapshot(adapter, sessionId);
    if (!snapshot) return closeStream();
    const payload = JSON.stringify(snapshot);
    if (payload !== lastPayload) {
      lastPayload = payload;
      res.write(`event: snapshot\ndata: ${payload}\n\n`);
    } else {
      res.write(': heartbeat\n\n');
    }
  };

  await sendSnapshot();
  if (!closed) interval = setInterval(() => { void sendSnapshot().catch((error) => res.write(`event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`)); }, 1000);
  req.on('close', closeStream);
};

const handleRunStream = async (req: Request, res: Response, runId: string): Promise<void> => {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  });
  res.write(': connected\n\n');
  let closed = false;
  let lastPayload = '';
  let interval: ReturnType<typeof setInterval> | null = null;

  const closeStream = (): void => {
    if (closed) return;
    closed = true;
    if (interval) clearInterval(interval);
    res.end();
  };
  const isTerminalSnapshot = (snapshot: unknown): boolean => {
    const run = snapshot && typeof snapshot === 'object' && 'run' in snapshot ? (snapshot as { run?: { status?: unknown } }).run : null;
    return Boolean(run && typeof run.status === 'string' && ['done', 'failed', 'error'].includes(run.status));
  };
  const sendSnapshot = async (): Promise<void> => {
    if (closed) return;
    const snapshot = await runSnapshot(runId);
    const payload = JSON.stringify(snapshot);
    if (payload !== lastPayload) {
      lastPayload = payload;
      res.write(`event: snapshot\ndata: ${payload}\n\n`);
    } else {
      res.write(': heartbeat\n\n');
    }
    if (isTerminalSnapshot(snapshot)) closeStream();
  };

  await sendSnapshot();
  if (!closed) interval = setInterval(() => { void sendSnapshot().catch((error) => res.write(`event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`)); }, 1000);
  req.on('close', closeStream);
};

const handleDeleteRun = async (res: Response, runId: string): Promise<void> => {
  const result = await runControlPlane(['delete-run', runId]);
  if (result.status !== 200) return jsonResponse(res, result.status, result.body);
  const body = result.body as { run_id?: string; deleted?: boolean; liveness?: string; path?: string } | undefined;
  return jsonResponse(res, 200, {
    operation: 'delete',
    status: 'ok',
    run_id: body?.run_id ?? runId,
    deleted: body?.deleted ?? true,
    liveness: body?.liveness,
    path: body?.path
  });
};

const handleExistingRunMutation = async (req: Request, res: Response, runId: string, operation: 'step' | 'resume'): Promise<void> => {
  const body = req.body as JsonRecord;
  const detail = await refreshedRun(runId);
  if (detail.status !== 200) return jsonResponse(res, detail.status, detail.body);
  const runDir = runDetailPath(detail.body);
  if (!runDir) return jsonResponse(res, 502, errorBody(502, 'bad_gateway', 'Run detail did not include a path'));
  const maxSteps = readMaxSteps(body.max_steps, 100);
  if (operation === 'resume' && maxSteps === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'max_steps must be an integer from 1 to 1000'));

  if (operation === 'resume') {
    const background = startRuntime(['resume', '--run-dir', runDir, '--max-steps', String(maxSteps), '--format', 'json']);
    const refreshed = await refreshedRun(runId);
    return jsonResponse(res, 202, { operation, status: 'running', code: 'background_started', run_id: runId, background, latest_runtime: await inspectRuntime(runDir), run_detail: refreshed.status === 200 ? refreshed.body : null });
  }

  const cli = await runRuntime(['step', '--run-dir', runDir, '--format', 'json']);
  const result = await mutationResponse(operation, runId, cli, runDir);
  jsonResponse(res, result.status, result.body);
};

export const createApiRouter = (piSessionAdapter: PiSessionAdapter = createConfiguredPiSessionAdapter()): Router => {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  router.get('/pi-sessions', (req, res, next) => {
    void piSessionAdapter.listSessions().then((sessions) => jsonResponse(res, 200, { sessions })).catch(next);
  });
  router.post('/pi-sessions', (req, res, next) => { void handleCreatePiSession(req, res, piSessionAdapter).catch(next); });
  router.get('/pi-sessions/:sessionId', (req, res, next) => {
    const sessionId = safeDecode(req.params.sessionId);
    if (sessionId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed Pi session id'));
    return void piSessionAdapter.getSession(sessionId).then((session) => session ? jsonResponse(res, 200, { session }) : jsonResponse(res, 404, errorBody(404, 'not_found', 'Pi session not found', { session_id: sessionId }))).catch(next);
  });
  router.post('/pi-sessions/:sessionId/prompts', (req, res, next) => {
    const sessionId = safeDecode(req.params.sessionId);
    if (sessionId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed Pi session id'));
    return void handleSendPiPrompt(req, res, piSessionAdapter, sessionId).catch(next);
  });
  router.get('/pi-sessions/:sessionId/events', (req, res, next) => {
    const sessionId = safeDecode(req.params.sessionId);
    const afterValue = Array.isArray(req.query.after) ? req.query.after[0] : req.query.after;
    let after: number | undefined;
    if (sessionId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed Pi session id'));
    if (afterValue !== undefined) {
      const parsedAfter = Number(afterValue);
      if (!Number.isInteger(parsedAfter) || parsedAfter < 0) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'after must be a non-negative integer'));
      after = parsedAfter;
    }
    return void piSessionAdapter.listEvents(sessionId, after).then((events) => events ? jsonResponse(res, 200, { session_id: sessionId, events }) : jsonResponse(res, 404, errorBody(404, 'not_found', 'Pi session not found', { session_id: sessionId }))).catch(next);
  });
  router.get('/pi-sessions/:sessionId/stream', (req, res, next) => {
    const sessionId = safeDecode(req.params.sessionId);
    if (sessionId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed Pi session id'));
    return void handlePiSessionStream(req, res, piSessionAdapter, sessionId).catch(next);
  });

  router.get('/browse', (req, res, next) => { void handleBrowse(req, res).catch(next); });
  router.get('/git-user', (_req, res, next) => { void handleGetGitUser(res).catch(next); });
  router.put('/git-user', (req, res, next) => { void handleSetGitUser(req, res).catch(next); });
  router.get('/settings', (_req, res, next) => { void handleGetSettings(res).catch(next); });
  router.put('/settings', (req, res, next) => { void handleSetSettings(req, res).catch(next); });

  // Workflow Studio authoring routes (see design doc). These write workflow
  // definition files under .tesseraft/workflows/ and run the linter as the
  // save-completed gate. They are registered before the generic GET fallback.
  router.post('/studio/workflows', (req, res, next) => { void handleCreateStudioWorkflow(req, res).catch(next); });
  router.get('/studio/workflows/:name', (req, res, next) => {
    const name = safeDecode(req.params.name);
    if (name === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed workflow name'));
    return void handleGetStudioWorkflow(req, res, name).catch(next);
  });
  router.put('/studio/workflows/:name', (req, res, next) => {
    const name = safeDecode(req.params.name);
    if (name === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed workflow name'));
    return void handlePutStudioWorkflow(req, res, name).catch(next);
  });
  router.post('/studio/workflows/:name/lint', (req, res, next) => {
    const name = safeDecode(req.params.name);
    if (name === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed workflow name'));
    return void handleLintStudioWorkflow(req, res, name).catch(next);
  });

  router.post('/runs', (req, res, next) => { void handleStartRun(req, res).catch(next); });
  router.get('/runs/:runId/stream', (req, res, next) => {
    const runId = safeDecode(req.params.runId);
    if (runId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed run id'));
    return void handleRunStream(req, res, runId).catch(next);
  });
  router.delete('/runs/:runId', (req, res, next) => {
    const runId = safeDecode(req.params.runId);
    if (runId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed run id'));
    return void handleDeleteRun(res, runId).catch(next);
  });

  router.post('/runs/:runId/:operation', (req, res, next) => {
    const runId = safeDecode(req.params.runId);
    const operation = req.params.operation;
    if (runId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed run id'));
    if (operation !== 'step' && operation !== 'resume') return jsonResponse(res, 404, errorBody(404, 'not_found', 'API route not found'));
    return void handleExistingRunMutation(req, res, runId, operation).catch(next);
  });

  router.use((req, res, next) => {
    if (req.method !== 'GET') return jsonResponse(res, 405, errorBody(405, 'method_not_allowed', 'Only GET, POST, PUT, and DELETE are supported for API routes'));
    const routed = routeApi(`/api${req.path}`, new URLSearchParams(req.url.split('?')[1] || ''));
    if (routed === null) return next();
    if ('badRequest' in routed) return jsonResponse(res, 400, errorBody(400, 'bad_request', routed.badRequest));
    if ('notFound' in routed) return jsonResponse(res, 404, errorBody(404, 'not_found', 'API route not found'));
    return void runControlPlane(routed).then((result) => jsonResponse(res, result.status, result.body)).catch(next);
  });

  return router;
};
