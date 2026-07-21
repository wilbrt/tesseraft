import type { Request, Response, Router } from 'express';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { runControlPlane, runLint, runRuntime, startRuntime, type ControlPlaneResult, type RuntimeResult } from '../lib/cli.js';
import { toEdn } from '../lib/edn.js';
import { makeGitUserAuthor } from '../lib/approvals.js';
import { errorBody, jsonResponse, safeDecode } from '../lib/http.js';
import { ROOT_DIR, WORKSPACE_ROOT } from '../lib/paths.js';
import { createConfiguredPiSessionAdapter, type PiSessionAdapter } from '../lib/piSessionAdapter.js';

type ApiRoute = string[] | { badRequest: string } | { notFound: true } | null;
type JsonRecord = Record<string, unknown>;
export type ApiRouterOptions = { piSessionAdapter?: PiSessionAdapter; browserAllowedProjectRoots?: string[] };

/** Optional `?project_id=` query param threaded to project-scoped routes. */
const projectFromQuery = (searchParams: URLSearchParams): string | undefined => {
  const v = searchParams.get('project_id');
  return v && v.trim() !== '' ? v : undefined;
};
const projectArgs = (searchParams: URLSearchParams): string[] => {
  const pid = projectFromQuery(searchParams);
  return pid ? ['--project-id', pid] : [];
};

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
  if (parts.length === 4 && parts[1] === 'runs' && parts[3] === 'approvals') {
    const runId = safeDecode(parts[2]);
    return runId === null ? { badRequest: 'Malformed run id' } : ['approvals', runId];
  }
  if (parts.length === 5 && parts[1] === 'runs' && parts[3] === 'approval') {
    const runId = safeDecode(parts[2]);
    const approvalId = safeDecode(parts[4]);
    if (runId === null) return { badRequest: 'Malformed run id' };
    if (approvalId === null) return { badRequest: 'Malformed approval id' };
    return ['approval', runId, approvalId];
  }
  if (parts.length === 4 && parts[1] === 'runs' && parts[3] === 'comments') {
    const runId = safeDecode(parts[2]);
    return runId === null ? { badRequest: 'Malformed run id' } : ['comments', runId];
  }
  // ---- Project abstraction routes (design §4.6) ----
  if (parts.length === 2 && parts[1] === 'projects') return ['projects'];
  if (parts.length === 3 && parts[1] === 'projects') {
    const id = safeDecode(parts[2]);
    return id === null ? { badRequest: 'Malformed project id' } : ['project', id];
  }
  if (parts.length === 4 && parts[1] === 'projects' && parts[3] === 'doctor') {
    const id = safeDecode(parts[2]);
    return id === null ? { badRequest: 'Malformed project id' } : ['project-doctor', id];
  }
  if (parts.length === 4 && parts[1] === 'projects' && parts[3] === 'connections') {
    const id = safeDecode(parts[2]);
    return id === null ? { badRequest: 'Malformed project id' } : ['project-connections', id];
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

const refreshedRun = async (runId: string, projectId?: string): Promise<ControlPlaneResult> => runControlPlane([...(projectId ? ['--project-id', projectId] : []), 'run', runId]);

const inspectRuntime = async (runDir: string): Promise<unknown> => {
  const inspected = await runRuntime(['inspect', '--run-dir', runDir, '--format', 'json']);
  return inspected.status === 200 ? inspected.body : null;
};

const runSnapshot = async (runId: string, projectId?: string): Promise<unknown> => {
  const pid = projectId ? ['--project-id', projectId] : [];
  const [detail, events, artifacts, runs] = await Promise.all([
    runControlPlane([...pid, 'run', runId]),
    runControlPlane([...pid, 'events', runId]),
    runControlPlane([...pid, 'artifacts', runId]),
    runControlPlane([...pid, 'runs'])
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

const mutationResponse = async (operation: string, runId: string, cli: RuntimeResult, runDir?: string, projectId?: string): Promise<{ status: number; body: unknown }> => {
  const detail = await refreshedRun(runId, projectId);
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

const handleGetGitUser = async (res: Response, projectId?: string): Promise<void> => {
  const result = await runControlPlane([...(projectId ? ['--project-id', projectId] : []), 'git-user']);
  return jsonResponse(res, result.status, result.body);
};

const handleSetGitUser = async (req: Request, res: Response, projectId?: string): Promise<void> => {
  const body = req.body as JsonRecord;
  const name = body.name;
  const email = body.email;
  if (!isNonEmptyString(name)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'name is required and must be a non-empty string'));
  if (name.length > 200) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'name must be at most 200 characters'));
  if (/\n/.test(name)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'name must not contain newlines'));
  if (!isNonEmptyString(email) || !isBasicEmail(email)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'email is required and must be a valid address'));
  const result = await runControlPlane([...(projectId ? ['--project-id', projectId] : []), 'git-user', 'set', '--name', name, '--email', email]);
  return jsonResponse(res, result.status, result.body);
};

const readMaxSteps = (value: unknown, fallback: number): number | null => {
  if (value === undefined) return fallback;
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 1000 ? value as number : null;
};

const EMAIL_RE = /^\S+@\S+\.\S+$/;

const SETTINGS_TOKEN_FIELDS = new Set(['github_token', 'jira_token']);
const SETTINGS_NON_TOKEN_FIELDS = new Set(['pi_default_provider', 'pi_default_model', 'default_repo_root', 'color_scheme']);
const SETTINGS_FIELDS = new Set([...SETTINGS_TOKEN_FIELDS, ...SETTINGS_NON_TOKEN_FIELDS]);
const SETTINGS_LENGTH_LIMITS: Record<string, number> = {
  pi_default_provider: 100, pi_default_model: 200,
  github_token: 500, jira_token: 500, default_repo_root: 1000
};
const SETTINGS_UNCHANGED = '__unchanged__';

const validateSettingsField = (field: string, value: unknown): string | null => {
  if (field === 'color_scheme' && value !== 'classic' && value !== 'matrix') return 'color_scheme must be one of: classic, matrix';
  if (typeof value !== 'string') return `${field} must be a string`;
  if (value.trim() === '') return `${field} must not be empty`;
  if (/\n/.test(value)) return `${field} must not contain newlines`;
  const limit = SETTINGS_LENGTH_LIMITS[field];
  if (limit && value.length > limit) return `${field} must be at most ${limit} characters`;
  return null;
};

const handleGetSettings = async (res: Response, projectId?: string): Promise<void> => {
  const result = await runControlPlane([...(projectId ? ['--project-id', projectId] : []), 'settings', 'get']);
  return jsonResponse(res, result.status, result.body);
};

// ---- Project abstraction handlers (design §4.6) ----
// These shell to `tesseraft control-plane project*` subcommands. Secrets never
// leave the process: the control plane returns masked/absent token state only.
const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CREDENTIAL_REF_RE = /^(env|github-actions):\S+$/;

// Collect workflow roots from a request body, honoring both the flat
// `workflow_roots` field and the nested design-doc shape
// `discovery.workflow-roots` (hyphenated) or `discovery.workflow_roots`
// (underscored). The CLI subcommand accepts `--workflow-root <path>` repeated.
const collectWorkflowRoots = (body: JsonRecord): string[] => {
  const roots: string[] = [];
  if (Array.isArray(body.workflow_roots)) for (const r of body.workflow_roots) if (typeof r === 'string') roots.push(r);
  const discovery = body.discovery;
  if (discovery && typeof discovery === 'object' && !Array.isArray(discovery)) {
    const d = discovery as Record<string, unknown>;
    for (const key of ['workflow-roots', 'workflow_roots']) {
      const v = d[key];
      if (Array.isArray(v)) for (const r of v) if (typeof r === 'string') roots.push(r);
    }
  }
  return roots;
};

const handleListProjects = async (res: Response): Promise<void> => {
  const result = await runControlPlane(['projects']);
  return jsonResponse(res, result.status, result.body);
};

const handleGetProject = async (res: Response, projectId: string): Promise<void> => {
  if (!PROJECT_NAME_RE.test(projectId)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed project id'));
  const result = await runControlPlane(['project', projectId]);
  return jsonResponse(res, result.status, result.body);
};

const readProjectDescriptor = (projectRoot: string): JsonRecord | null => {
  const descriptorPath = path.join(projectRoot, '.tesseraft', 'project.json');
  if (!fs.existsSync(descriptorPath)) return null;
  const parsed = JSON.parse(fs.readFileSync(descriptorPath, 'utf8')) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : null;
};

const validateProjectDescriptor = (descriptor: JsonRecord): string | null => {
  if (descriptor.version !== 1) return 'Unsupported project descriptor version';
  if (typeof descriptor.project_id !== 'string' || !PROJECT_NAME_RE.test(descriptor.project_id.trim())) return 'Invalid project descriptor project_id';
  if (Object.prototype.hasOwnProperty.call(descriptor, 'workspace_root')) return 'Portable project descriptor must not contain workspace_root';
  if (descriptor.runs_root !== undefined && typeof descriptor.runs_root !== 'string') return 'Invalid project descriptor runs_root';
  if (descriptor.discovery !== undefined && (!descriptor.discovery || typeof descriptor.discovery !== 'object' || Array.isArray(descriptor.discovery))) return 'Invalid project descriptor discovery';
  return null;
};

const validateRegistry = (registry: JsonRecord): string | null => {
  if (registry.version !== 1) return 'Unsupported project registry version';
  if (!registry.projects || typeof registry.projects !== 'object' || Array.isArray(registry.projects)) return 'Project registry projects must be an object';
  for (const [id, entry] of Object.entries(registry.projects as Record<string, unknown>)) {
    if (!PROJECT_NAME_RE.test(id)) return `Invalid project registry id: ${id}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return `Invalid project registry entry: ${id}`;
    const e = entry as JsonRecord;
    if (typeof e.workspace_root !== 'string' || e.workspace_root.trim() === '') return `Invalid project registry workspace_root: ${id}`;
  }
  return null;
};

const isPathWithin = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const hasParentTraversal = (p: string): boolean => p.split(/[\\/]+/).some((part) => part === '..');

const validateProjectOwnedPath = (projectRoot: string, field: string, value: string): JsonRecord | null => {
  if (value.trim() === '') return null;
  if (path.isAbsolute(value) || hasParentTraversal(value)) {
    return { field, path: value, project_root: projectRoot };
  }
  const resolved = path.resolve(projectRoot, value);
  let canonical = resolved;
  try {
    if (fs.existsSync(resolved)) canonical = fs.realpathSync(resolved);
  } catch (error) {
    return { field, path: value, project_root: projectRoot, message: error instanceof Error ? error.message : String(error) };
  }
  return isPathWithin(projectRoot, canonical) ? null : { field, path: value, project_root: projectRoot, canonical_path: canonical };
};

const canonicalAllowedRoots = (roots: string[] = []): string[] => roots.map((root) => fs.realpathSync(root));

const disallowedProjectRoot = (projectRoot: string, allowedRoots: string[]): JsonRecord | null => {
  if (allowedRoots.length === 0) return { project_root: projectRoot, allowed_roots: [] };
  return allowedRoots.some((root) => isPathWithin(root, projectRoot)) ? null : { project_root: projectRoot, allowed_roots: allowedRoots };
};

const handleCreateProject = async (req: Request, res: Response, browserAllowedProjectRoots: string[] = []): Promise<void> => {
  const body = (req.body || {}) as JsonRecord;
  let projectRoot = '';
  if (typeof body.project_root === 'string' && body.project_root.trim() !== '') {
    try {
      projectRoot = fs.realpathSync(body.project_root.trim());
    } catch (error) {
      return jsonResponse(res, 400, errorBody(400, 'bad_request', 'project_root is not readable', { message: error instanceof Error ? error.message : String(error) }));
    }
  }
  if (!projectRoot) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'project_root is required for browser project registration'));
  let descriptor: JsonRecord | null = null;
  if (projectRoot) {
    const rootNotAllowed = disallowedProjectRoot(projectRoot, browserAllowedProjectRoots);
    if (rootNotAllowed) return jsonResponse(res, 400, errorBody(400, 'project_root_not_allowed', 'project_root is outside the configured browser project roots', rootNotAllowed));
    try {
      descriptor = readProjectDescriptor(projectRoot);
    } catch (error) {
      return jsonResponse(res, 400, errorBody(400, 'bad_request', 'project_root descriptor is not readable', { message: error instanceof Error ? error.message : String(error) }));
    }
    if (!descriptor) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'project_root must contain .tesseraft/project.json'));
    const descriptorError = validateProjectDescriptor(descriptor);
    if (descriptorError) return jsonResponse(res, 400, errorBody(400, 'invalid_project_descriptor', descriptorError, { version: descriptor.version }));
  }
  const projectId = typeof descriptor?.project_id === 'string' ? descriptor.project_id.trim() : '';
  if (!PROJECT_NAME_RE.test(projectId)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'project_id must match /^[a-z0-9][a-z0-9-]{0,62}$/'));
  const args = ['project', 'create', projectId];
  const descriptorDiscovery = descriptor?.discovery && typeof descriptor.discovery === 'object' && !Array.isArray(descriptor.discovery) ? descriptor.discovery as JsonRecord : undefined;
  const name = typeof descriptor?.name === 'string' ? descriptor.name : '';
  const runsRoot = typeof descriptor?.runs_root === 'string' && descriptor.runs_root.trim() !== '' ? descriptor.runs_root.trim() : '';
  const workspaceRoot = projectRoot;
  const workflowRoots: string[] = [];
  if (descriptorDiscovery && Array.isArray(descriptorDiscovery['workflow-roots'])) for (const r of descriptorDiscovery['workflow-roots']) if (typeof r === 'string') workflowRoots.push(r);
  if (descriptorDiscovery && Array.isArray(descriptorDiscovery.workflow_roots)) for (const r of descriptorDiscovery.workflow_roots) if (typeof r === 'string') workflowRoots.push(r);
  if (projectRoot) {
    const escapedRunsRoot = runsRoot ? validateProjectOwnedPath(projectRoot, 'runs_root', runsRoot) : null;
    if (escapedRunsRoot) return jsonResponse(res, 400, errorBody(400, 'project_path_escape', 'Project-owned path resolves outside the project boundary', escapedRunsRoot));
    for (const r of workflowRoots) {
      const escapedWorkflowRoot = validateProjectOwnedPath(projectRoot, 'workflow_root', r);
      if (escapedWorkflowRoot) return jsonResponse(res, 400, errorBody(400, 'project_path_escape', 'Project-owned path resolves outside the project boundary', escapedWorkflowRoot));
    }
  }
  if (name) args.push('--name', name);
  if (workspaceRoot) args.push('--workspace-root', workspaceRoot);
  if (runsRoot) args.push('--runs-root', runsRoot);
  for (const r of workflowRoots) args.push('--workflow-root', r);
  const conns = body.connections;
  if (conns && typeof conns === 'object' && !Array.isArray(conns)) {
    const c = conns as Record<string, JsonRecord>;
    if (c.jira) { if (typeof c.jira.base_url === 'string') args.push('--jira-base-url', c.jira.base_url); if (typeof c.jira.credential_ref === 'string') args.push('--jira-credential-ref', c.jira.credential_ref); }
    if (c.github && typeof c.github.credential_ref === 'string') args.push('--github-credential-ref', c.github.credential_ref);
  }
  if (projectRoot) args.push('--source', 'registration');
  const result = await runControlPlane(args);
  return jsonResponse(res, result.status === 200 ? 201 : result.status, result.body);
};

const handleDeleteProject = async (res: Response, projectId: string): Promise<void> => {
  if (!PROJECT_NAME_RE.test(projectId)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed project id'));
  const registryPath = path.join(process.env.TESSERAFT_HOME || path.join(process.env.HOME || '', '.tesseraft'), 'projects', 'registry.json');
  let removed = false;
  let registry: JsonRecord = { version: 1, projects: {} };
  try {
    if (fs.existsSync(registryPath)) {
      const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return jsonResponse(res, 400, errorBody(400, 'invalid_project_registry', 'Project registry must be a JSON object'));
      registry = parsed as JsonRecord;
      const registryError = validateRegistry(registry);
      if (registryError) return jsonResponse(res, 400, errorBody(400, 'invalid_project_registry', registryError));
    }
    const projects = registry.projects as JsonRecord;
    removed = Object.prototype.hasOwnProperty.call(projects, projectId);
    delete projects[projectId];
    registry = { ...registry, version: 1, projects };
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
  } catch (error) {
    return jsonResponse(res, 500, errorBody(500, 'registry_write_failed', 'Could not update project registry', { message: error instanceof Error ? error.message : String(error) }));
  }
  return jsonResponse(res, 200, { project_id: projectId, deleted: removed });
};

const handleUpdateProject = async (req: Request, res: Response, projectId: string): Promise<void> => {
  if (!PROJECT_NAME_RE.test(projectId)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed project id'));
  const body = (req.body || {}) as JsonRecord;
  const args = ['project', 'update', projectId];
  if (typeof body.name === 'string') args.push('--name', body.name);
  if (typeof body.workspace_root === 'string') args.push('--workspace-root', body.workspace_root);
  if (typeof body.runs_root === 'string') args.push('--runs-root', body.runs_root);
  for (const r of collectWorkflowRoots(body)) args.push('--workflow-root', r);
  const result = await runControlPlane(args);
  return jsonResponse(res, result.status, result.body);
};

const handleMigrateProject = async (req: Request, res: Response, projectId: string, browserAllowedProjectRoots: string[] = []): Promise<void> => {
  if (!PROJECT_NAME_RE.test(projectId)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed project id'));
  const body = (req.body || {}) as JsonRecord;
  const legacyManifestPath = typeof body.legacy_manifest === 'string' && body.legacy_manifest.trim() !== '' ? body.legacy_manifest.trim() : '';
  const projectRoot = typeof body.project_root === 'string' && body.project_root.trim() !== '' ? fs.realpathSync(body.project_root.trim()) : '';
  if (!legacyManifestPath && !projectRoot) {
    const result = await runControlPlane(['project', 'migrate', projectId]);
    return jsonResponse(res, result.status, result.body);
  }
  if (!legacyManifestPath || !projectRoot) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'legacy_manifest and project_root are required for explicit migration'));
  const rootNotAllowed = disallowedProjectRoot(projectRoot, browserAllowedProjectRoots);
  if (rootNotAllowed) return jsonResponse(res, 400, errorBody(400, 'project_root_not_allowed', 'project_root is outside the configured browser project roots', rootNotAllowed));

  let legacy: JsonRecord;
  try {
    const parsed = JSON.parse(fs.readFileSync(legacyManifestPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('legacy manifest must be a JSON object');
    legacy = parsed as JsonRecord;
  } catch (error) {
    return jsonResponse(res, 400, errorBody(400, 'invalid_legacy_manifest', 'legacy_manifest is not readable JSON', { legacy_manifest: legacyManifestPath, message: error instanceof Error ? error.message : String(error) }));
  }
  if (legacy.project_id !== projectId) return jsonResponse(res, 400, errorBody(400, 'project_id_mismatch', 'legacy manifest project_id does not match requested project id', { project_id: projectId, legacy_project_id: legacy.project_id }));
  if (typeof legacy.workspace_root !== 'string' || path.normalize(fs.realpathSync(legacy.workspace_root)) !== path.normalize(projectRoot)) {
    return jsonResponse(res, 400, errorBody(400, 'project_root_mismatch', 'legacy manifest workspace_root does not match requested project_root', { project_root: projectRoot, legacy_workspace_root: legacy.workspace_root }));
  }

  const runsRoot = typeof legacy.runs_root === 'string' && legacy.runs_root.trim() !== '' ? legacy.runs_root : 'runs';
  const discovery = legacy.discovery && typeof legacy.discovery === 'object' && !Array.isArray(legacy.discovery) ? legacy.discovery as JsonRecord : {};
  const workflowRoots = Array.isArray(discovery['workflow-roots']) ? discovery['workflow-roots'].filter((r): r is string => typeof r === 'string') : [];
  const escapedRunsRoot = validateProjectOwnedPath(projectRoot, 'runs_root', runsRoot);
  if (escapedRunsRoot) return jsonResponse(res, 400, errorBody(400, 'project_path_escape', 'Project-owned path resolves outside the project boundary', escapedRunsRoot));
  for (const r of workflowRoots) {
    const escapedWorkflowRoot = validateProjectOwnedPath(projectRoot, 'workflow_root', r);
    if (escapedWorkflowRoot) return jsonResponse(res, 400, errorBody(400, 'project_path_escape', 'Project-owned path resolves outside the project boundary', escapedWorkflowRoot));
  }

  const descriptorPath = path.join(projectRoot, '.tesseraft', 'project.json');
  const registryPath = path.join(process.env.TESSERAFT_HOME || path.join(process.env.HOME || '', '.tesseraft'), 'projects', 'registry.json');
  const descriptor: JsonRecord = {
    version: 1,
    project_id: projectId,
    name: typeof legacy.name === 'string' && legacy.name.trim() !== '' ? legacy.name : projectId,
    runs_root: runsRoot,
    discovery
  };
  const registration: JsonRecord = { name: descriptor.name, workspace_root: projectRoot, runs_root: runsRoot, discovery, source: 'registration' };

  const readRegistry = (): JsonRecord => {
    if (!fs.existsSync(registryPath)) return { version: 1, projects: {} };
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('project registry must be a JSON object');
    const registry = parsed as JsonRecord;
    if (registry.version !== 1) throw new Error('unsupported project registry version');
    if (!registry.projects || typeof registry.projects !== 'object' || Array.isArray(registry.projects)) return { ...registry, projects: {} };
    return registry;
  };

  const descriptorPreexisting = fs.existsSync(descriptorPath);
  let registryBefore: string | null = null;
  let registrationPreexisting = false;
  try {
    if (descriptorPreexisting) {
      const existingDescriptor = readProjectDescriptor(projectRoot);
      if (!existingDescriptor || existingDescriptor.project_id !== descriptor.project_id || existingDescriptor.runs_root !== descriptor.runs_root) {
        return jsonResponse(res, 409, errorBody(409, 'project_identity_conflict', 'Destination descriptor already exists for a different project state', { descriptor_path: descriptorPath, project_id: projectId }));
      }
    }
    if (fs.existsSync(registryPath)) registryBefore = fs.readFileSync(registryPath, 'utf8');
    const registry = readRegistry();
    const projects = registry.projects as JsonRecord;
    const existingRegistration = projects[projectId];
    registrationPreexisting = existingRegistration !== undefined;
    if (registrationPreexisting) {
      if (!existingRegistration || typeof existingRegistration !== 'object' || Array.isArray(existingRegistration)) {
        return jsonResponse(res, 409, errorBody(409, 'project_identity_conflict', 'Registration already exists with invalid state', { registry_path: registryPath, project_id: projectId }));
      }
      const existingRoot = typeof (existingRegistration as JsonRecord).workspace_root === 'string' ? fs.realpathSync((existingRegistration as JsonRecord).workspace_root as string) : '';
      if (path.normalize(existingRoot) !== path.normalize(projectRoot)) {
        return jsonResponse(res, 409, errorBody(409, 'project_identity_conflict', 'Registration already exists for a different project root', { registry_path: registryPath, project_id: projectId }));
      }
    }
    if (!descriptorPreexisting) {
      fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
      fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
    }
    if (!registrationPreexisting) {
      fs.mkdirSync(path.dirname(registryPath), { recursive: true });
      fs.writeFileSync(registryPath, `${JSON.stringify({ ...registry, version: 1, projects: { ...projects, [projectId]: registration } }, null, 2)}\n`);
    }
  } catch (error) {
    if (!registrationPreexisting) {
      try {
        if (registryBefore === null) fs.rmSync(registryPath, { force: true });
        else fs.writeFileSync(registryPath, registryBefore);
      } catch {}
    }
    if (!descriptorPreexisting) {
      try { fs.rmSync(descriptorPath, { force: true }); } catch {}
    }
    return jsonResponse(res, 400, errorBody(400, 'migration_failed', 'Project migration could not be completed', { message: error instanceof Error ? error.message : String(error) }));
  }

  const result = await runControlPlane(['--project-root', projectRoot, 'project', projectId]);
  const responseBody = result.body && typeof result.body === 'object' && !Array.isArray(result.body) ? result.body as JsonRecord : {};
  return jsonResponse(res, result.status, { ...responseBody, diagnostics: { ...(responseBody.diagnostics && typeof responseBody.diagnostics === 'object' && !Array.isArray(responseBody.diagnostics) ? responseBody.diagnostics as JsonRecord : {}), migration: { legacy_manifest: legacyManifestPath, descriptor_path: descriptorPath, registry_path: registryPath } } });
};

const handleGetProjectConnections = async (res: Response, projectId: string): Promise<void> => {
  if (!PROJECT_NAME_RE.test(projectId)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed project id'));
  const result = await runControlPlane(['project', 'connections', projectId]);
  return jsonResponse(res, result.status, result.body);
};

const handleGetProjectDoctor = async (res: Response, projectId: string): Promise<void> => {
  if (!PROJECT_NAME_RE.test(projectId)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed project id'));
  const result = await runControlPlane(['--project-id', projectId, 'doctor'], { timeout: 12000 });
  return jsonResponse(res, result.status, result.body);
};

const handleUpdateProjectConnections = async (req: Request, res: Response, projectId: string): Promise<void> => {
  if (!PROJECT_NAME_RE.test(projectId)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed project id'));
  const body = (req.body || {}) as JsonRecord;
  // NEVER accept raw token payloads; only refs + base-url.
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const v of Object.values(body as Record<string, JsonRecord>)) {
      if (v && typeof v === 'object' && Array.isArray(v)) continue;
      if (v && typeof v === 'object') {
        const vs = v as Record<string, unknown>;
        if (['token', 'github_token', 'jira_token', 'secret', 'password'].some((k) => k in vs)) {
          return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Raw token payloads are not accepted; provide a credential_ref instead'));
        }
      }
    }
  }
  const args = ['project', 'connections', projectId];
  const conns = body;
  if (conns && typeof conns === 'object' && !Array.isArray(conns)) {
    const c = conns as Record<string, JsonRecord>;
    if (c.jira) { if (typeof c.jira.base_url === 'string') args.push('--jira-base-url', c.jira.base_url); if (typeof c.jira.credential_ref === 'string') { if (!CREDENTIAL_REF_RE.test(c.jira.credential_ref)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Invalid credential_ref')); args.push('--jira-credential-ref', c.jira.credential_ref); } }
    if (c.github && typeof c.github.credential_ref === 'string') { if (!CREDENTIAL_REF_RE.test(c.github.credential_ref)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Invalid credential_ref')); args.push('--github-credential-ref', c.github.credential_ref); }
  }
  const result = await runControlPlane(args);
  return jsonResponse(res, result.status, result.body);
};

const handleSetSettings = async (req: Request, res: Response, projectId?: string): Promise<void> => {
  const body = req.body as JsonRecord;
  const updates: JsonRecord = {};
  for (const [field, raw] of Object.entries(body)) {
    if (!SETTINGS_FIELDS.has(field)) return jsonResponse(res, 400, errorBody(400, 'bad_request', `Unknown settings field: ${field}`));
    if (field === 'color_scheme' && raw !== 'classic' && raw !== 'matrix') {
      return jsonResponse(res, 400, errorBody(400, 'bad_request', 'color_scheme must be one of: classic, matrix'));
    }
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
  const args = [...(projectId ? ['--project-id', projectId] : []), 'settings', 'set'];
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
// Bundled example workflows live under examples/<name>/ (the control-plane's
// default :workflow-roots). Studio reads resolve the project workflow file
// first, then fall back to the example so example workflows are loadable in
// the Studio (read-only view). Writes (PUT) always target the project path
// under .tesseraft/workflows/ so examples are never mutated; saving an
// example creates a project copy that shadows it on later loads.
const exampleWorkflowFilePath = (name: string): string => path.join(ROOT_DIR, 'examples', name, 'workflow.edn');
const resolveReadableWorkflowFile = (name: string): string | null => {
  const primary = workflowFilePath(name);
  if (fs.existsSync(primary)) return primary;
  const example = exampleWorkflowFilePath(name);
  if (fs.existsSync(example)) return example;
  return null;
};

// Workflow package asset files (e.g. prompt templates) live alongside
// workflow.edn under `.tesseraft/workflows/<name>/`. The composer (see design
// doc) writes a `.md.tmpl` body to the default `prompts/<id>.md.tmpl` path.
// Asset paths must be safe relative paths confined to the package dir: no
// leading slash, no `..`, and a conservative allow-list of extensions.
const ASSET_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*\.(md\.tmpl|md|tmpl|txt)$/;
const safeAssetPath = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || raw === '') return null;
  if (raw.startsWith('/') || raw.includes('..') || raw.includes('\\')) return null;
  // Reject any empty segment (e.g. `a//b`) and a trailing slash.
  const segments = raw.split('/');
  if (segments.some((s) => s === '')) return null;
  if (!ASSET_PATH_RE.test(raw)) return null;
  return raw;
};
const workflowPackageDir = (name: string): string => path.join(projectWorkflowsRoot(), name);
const resolveAssetPath = (name: string, assetPath: string): string => path.resolve(workflowPackageDir(name), assetPath);
const assetRelPath = (name: string, assetPath: string): string => path.join('.tesseraft', 'workflows', name, assetPath);

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
  void req;
  const filePath = resolveReadableWorkflowFile(name);
  if (!filePath) return jsonResponse(res, 404, errorBody(404, 'not_found', 'Workflow not found', { name }));
  let edn: string;
  try {
    edn = await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    return jsonResponse(res, 500, errorBody(500, 'internal_error', error instanceof Error ? error.message : 'Failed to read workflow'));
  }
  const state = await readStudioState(name);
  const relPath = path.relative(ROOT_DIR, filePath);
  jsonResponse(res, 200, { workflow: { name, path: relPath, edn }, state });
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
  const filePath = resolveReadableWorkflowFile(name);
  if (!filePath) return jsonResponse(res, 404, errorBody(404, 'not_found', 'Workflow not found', { name }));
  const lint = await runLint(filePath);
  jsonResponse(res, 200, { ok: lint.ok, errors: lint.errors, warnings: lint.warnings, diagnostics: lint.diagnostics });
};

// Read a workflow package asset file (e.g. a composed prompt template) under
// `.tesseraft/workflows/<name>/`. Returns 404 if the asset does not exist.
const handleGetStudioAsset = async (res: Response, name: string, assetPath: string): Promise<void> => {
  const resolved = resolveAssetPath(name, assetPath);
  if (!isUnderRoot(resolved, workflowPackageDir(name))) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Asset path is outside the workflow package dir'));
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolved);
  } catch {
    return jsonResponse(res, 404, errorBody(404, 'not_found', 'Asset not found', { workflow: name, path: assetPath }));
  }
  if (!stat.isFile()) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Asset path is not a file', { workflow: name, path: assetPath }));
  let content: string;
  try {
    content = await fs.promises.readFile(resolved, 'utf8');
  } catch (error) {
    return jsonResponse(res, 500, errorBody(500, 'internal_error', error instanceof Error ? error.message : 'Failed to read asset'));
  }
  jsonResponse(res, 200, { workflow: name, path: assetPath, rel_path: assetRelPath(name, assetPath), content });
};

// Write a workflow package asset file under `.tesseraft/workflows/<name>/`,
// confined to the package dir via safeAssetPath + isUnderRoot. The workflow.edn
// file is untouched; the linter remains the save-completed gate for it.
const handlePutStudioAsset = async (req: Request, res: Response, name: string, assetPath: string): Promise<void> => {
  const body = req.body as JsonRecord;
  if (typeof body.content !== 'string') return jsonResponse(res, 400, errorBody(400, 'bad_request', 'content must be a string'));
  if (body.content.length > 1024 * 1024) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'content must be at most 1MB'));
  const resolved = resolveAssetPath(name, assetPath);
  if (!isUnderRoot(resolved, workflowPackageDir(name))) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Asset path is outside the workflow package dir'));
  const dir = path.dirname(resolved);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(resolved, body.content, 'utf8');
  jsonResponse(res, 200, { ok: true, workflow: name, path: assetPath, rel_path: assetRelPath(name, assetPath) });
};

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

const handleStartRun = async (req: Request, res: Response, projectId?: string): Promise<void> => {
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

  const pid = projectId ? ['--project-id', projectId] : [];

  // Validate the project exists (404 → 404) before starting, so a typo'd
  // project id is surfaced rather than silently falling back to default.
  if (projectId) {
    const project = await runControlPlane(['project', projectId]);
    if (project.status !== 200) return jsonResponse(res, project.status, project.body);
  }

  // Existing-run check is project-scoped: a run_id reused in another project
  // is allowed (identity = (project_id, run_id)).
  const existing = await refreshedRun(runId, projectId);
  if (existing.status === 200) return jsonResponse(res, 409, errorBody(409, 'conflict', 'Run id already exists', { run_id: runId }));

  const workflow = await runControlPlane([...pid, 'workflow', workflowName]);
  if (workflow.status !== 200) return jsonResponse(res, workflow.status, workflow.body);
  const filePath = workflowPath(workflow.body);
  if (!filePath) return jsonResponse(res, 502, errorBody(502, 'bad_gateway', 'Workflow detail did not include a path'));

  // Resolve the project's runs-root/workspace-root so the runtime writes the
  // run dir under the selected project rather than the ambient cwd. The
  // default project uses cwd('.') + '.agent-runs' (existing behavior).
  let runtimeRoots: string[] = [];
  if (projectId) {
    const project = await runControlPlane(['project', projectId]);
    if (project.status === 200 && project.body && typeof project.body === 'object') {
      const p = project.body as { workspace_root?: unknown; runs_root?: unknown };
      if (typeof p.workspace_root === 'string' && p.workspace_root.trim() !== '') runtimeRoots.push('--workspace-root', p.workspace_root);
      if (typeof p.runs_root === 'string' && p.runs_root.trim() !== '') runtimeRoots.push('--runs-root', p.runs_root);
    }
  }

  const startArgs = ['start', filePath, '--run-id', runId, '--format', 'json', ...pid, ...runtimeRoots];
  for (const [key, value] of Object.entries(inputs as Record<string, string>)) startArgs.push('--input', `${key}=${value}`);
  if (gitUser) { startArgs.push('--git-user-name', gitUser.name, '--git-user-email', gitUser.email); }
  const started = await runRuntime(startArgs);
  const runDir = started.body && typeof started.body === 'object' ? (started.body as { run?: { dir?: unknown } }).run?.dir : undefined;
  if (started.status !== 200 || typeof runDir !== 'string') {
    const result = await mutationResponse('start', runId, started, typeof runDir === 'string' ? runDir : undefined, projectId);
    return jsonResponse(res, result.status, result.body);
  }

  const background = startRuntime(['resume', '--run-dir', runDir, '--max-steps', String(maxSteps), '--format', 'json']);
  const detail = await refreshedRun(runId, projectId);
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
  let snapshotInFlight = false;
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
    if (closed) return;
    if (!snapshot) return closeStream();
    const payload = JSON.stringify(snapshot);
    if (payload !== lastPayload) {
      lastPayload = payload;
      res.write(`event: snapshot\ndata: ${payload}\n\n`);
    } else {
      res.write(': heartbeat\n\n');
    }
  };
  const poll = (): void => {
    if (closed || snapshotInFlight) return;
    snapshotInFlight = true;
    void sendSnapshot()
      .catch((error) => { if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`); })
      .finally(() => { snapshotInFlight = false; });
  };

  await sendSnapshot();
  if (!closed) interval = setInterval(poll, 1000);
  req.on('close', closeStream);
};

const handleRunStream = async (req: Request, res: Response, runId: string, projectId?: string): Promise<void> => {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  });
  res.write(': connected\n\n');
  let closed = false;
  let snapshotInFlight = false;
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
    return Boolean(run && typeof run.status === 'string' && ['done', 'failed', 'error', 'cancelled'].includes(run.status));
  };
  const sendSnapshot = async (): Promise<void> => {
    if (closed) return;
    const snapshot = await runSnapshot(runId, projectId);
    if (closed) return;
    const payload = JSON.stringify(snapshot);
    if (payload !== lastPayload) {
      lastPayload = payload;
      res.write(`event: snapshot\ndata: ${payload}\n\n`);
    } else {
      res.write(': heartbeat\n\n');
    }
    if (isTerminalSnapshot(snapshot)) closeStream();
  };
  const poll = (): void => {
    if (closed || snapshotInFlight) return;
    snapshotInFlight = true;
    void sendSnapshot()
      .catch((error) => { if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`); })
      .finally(() => { snapshotInFlight = false; });
  };

  await sendSnapshot();
  if (!closed) interval = setInterval(poll, 1000);
  req.on('close', closeStream);
};

const handleDeleteRun = async (res: Response, runId: string, projectId?: string): Promise<void> => {
  const result = await runControlPlane([...(projectId ? ['--project-id', projectId] : []), 'delete-run', runId]);
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

const handleApprovalDecision = async (req: Request, res: Response, runId: string, approvalId: string, projectId?: string): Promise<void> => {
  const body = (req.body || {}) as JsonRecord;
  const decision = typeof body.decision === 'string' ? body.decision.trim() : '';
  if (!decision) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'decision is required'));
  const summary = typeof body.summary === 'string' ? body.summary : undefined;
  const detail = await runControlPlane([...(projectId ? ['--project-id', projectId] : []), 'run', runId]);
  if (detail.status !== 200) return jsonResponse(res, detail.status, detail.body);
  const runDir = runDetailPath(detail.body);
  if (!runDir) return jsonResponse(res, 502, errorBody(502, 'bad_gateway', 'Run detail did not include a path'));
  const author = await makeGitUserAuthor(req);
  const args = ['decide', '--run-dir', runDir, '--approval-id', approvalId, '--decision', decision, '--format', 'json'];
  if (summary) args.push('--summary', summary);
  if (author) { args.push('--author-name', author.name, '--author-email', author.email); }
  const cli = await runRuntime(args);
  if (cli.status !== 200) {
    // decide! returns a structured error body with HTTP-ish status.
    const errBody = cli.body && typeof cli.body === 'object' && 'error' in cli.body ? cli.body : errorBody(409, 'conflict', 'Approval decision failed', { stderr: cli.stderr || undefined });
    const status = (cli.body && typeof cli.body === 'object' && 'status' in cli.body && typeof (cli.body as { status?: unknown }).status === 'number') ? (cli.body as { status: number }).status : 409;
    return jsonResponse(res, status, errBody);
  }
  const refreshed = await refreshedRun(runId, projectId);
  return jsonResponse(res, 200, { operation: 'decide', status: 'ok', run_id: runId, approval_id: approvalId, decision, cli: { exit_code: cli.exitCode, result: cli.body }, run_detail: refreshed.status === 200 ? refreshed.body : null });
};

const handleAddComment = async (req: Request, res: Response, runId: string, projectId?: string): Promise<void> => {
  const body = (req.body || {}) as JsonRecord;
  const path = typeof body.path === 'string' ? body.path.trim() : '';
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!path) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'path is required'));
  if (!text) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'body is required'));
  const anchor = body.anchor && typeof body.anchor === 'object' && !Array.isArray(body.anchor) ? body.anchor : undefined;
  const args = [...(projectId ? ['--project-id', projectId] : []), 'comment', 'add', runId, '--path', path, '--body', text];
  if (anchor && typeof anchor === 'object') {
    const a = anchor as { start_line?: unknown; end_line?: unknown };
    if (typeof a.start_line === 'number' && typeof a.end_line === 'number') {
      args.push('--start-line', String(a.start_line), '--end-line', String(a.end_line));
    }
  }
  const result = await runControlPlane(args);
  return jsonResponse(res, result.status, result.body);
};

const handleExistingRunMutation = async (req: Request, res: Response, runId: string, operation: 'step' | 'resume' | 'cancel', projectId?: string): Promise<void> => {
  const body = req.body as JsonRecord;
  const detail = await refreshedRun(runId, projectId);
  if (detail.status !== 200) return jsonResponse(res, detail.status, detail.body);
  const runDir = runDetailPath(detail.body);
  if (!runDir) return jsonResponse(res, 502, errorBody(502, 'bad_gateway', 'Run detail did not include a path'));
  const maxSteps = readMaxSteps(body?.max_steps, 100);
  if (operation === 'resume' && maxSteps === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'max_steps must be an integer from 1 to 1000'));

  if (operation === 'cancel') {
    const cli = await runRuntime(['cancel', '--run-dir', runDir, '--format', 'json']);
    const result = await mutationResponse(operation, runId, cli, runDir, projectId);
    return jsonResponse(res, result.status, result.body);
  }

  if (operation === 'resume') {
    const background = startRuntime(['resume', '--run-dir', runDir, '--max-steps', String(maxSteps), '--format', 'json']);
    const refreshed = await refreshedRun(runId, projectId);
    return jsonResponse(res, 202, { operation, status: 'running', code: 'background_started', run_id: runId, background, latest_runtime: await inspectRuntime(runDir), run_detail: refreshed.status === 200 ? refreshed.body : null });
  }

  const cli = await runRuntime(['step', '--run-dir', runDir, '--format', 'json']);
  const result = await mutationResponse(operation, runId, cli, runDir, projectId);
  jsonResponse(res, result.status, result.body);
};

export const createApiRouter = (options: ApiRouterOptions = {}): Router => {
  const router = express.Router();
  const piSessionAdapter = options.piSessionAdapter || createConfiguredPiSessionAdapter();
  const browserAllowedProjectRoots = canonicalAllowedRoots(options.browserAllowedProjectRoots);
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

  // ---- Project abstraction routes (design §4.6) ----
  // Secrets never leave the process: handlers return masked/absent token state.
  // Raw token payloads are rejected on write; only credential refs are accepted.
  router.get('/projects', (_req, res, next) => { void handleListProjects(res).catch(next); });
  router.post('/projects', (req, res, next) => { void handleCreateProject(req, res, browserAllowedProjectRoots).catch(next); });
  router.get('/projects/:projectId', (req, res, next) => {
    const id = safeDecode(req.params.projectId);
    if (id === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed project id'));
    return void handleGetProject(res, id).catch(next);
  });
  router.put('/projects/:projectId', (req, res, next) => {
    const id = safeDecode(req.params.projectId);
    if (id === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed project id'));
    return void handleUpdateProject(req, res, id).catch(next);
  });
  router.delete('/projects/:projectId', (req, res, next) => {
    const id = safeDecode(req.params.projectId);
    if (id === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed project id'));
    return void handleDeleteProject(res, id).catch(next);
  });
  router.post('/projects/:projectId/migrate', (req, res, next) => {
    const id = safeDecode(req.params.projectId);
    if (id === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed project id'));
    return void handleMigrateProject(req, res, id, browserAllowedProjectRoots).catch(next);
  });
  router.get('/projects/:projectId/doctor', (req, res, next) => {
    const id = safeDecode(req.params.projectId);
    if (id === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed project id'));
    return void handleGetProjectDoctor(res, id).catch(next);
  });
  router.get('/projects/:projectId/connections', (req, res, next) => {
    const id = safeDecode(req.params.projectId);
    if (id === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed project id'));
    return void handleGetProjectConnections(res, id).catch(next);
  });
  router.put('/projects/:projectId/connections', (req, res, next) => {
    const id = safeDecode(req.params.projectId);
    if (id === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed project id'));
    return void handleUpdateProjectConnections(req, res, id).catch(next);
  });

  // ---- Project-scoped operations (design §5.3) ----
  // Each routes workflows/runs/settings/git-identity to the selected project by
  // threading `--project-id` to the control plane and runtime. `projectId` is
  // validated against the same id regex used by the project routes so a
  // malformed id is a 400 rather than a control-plane error. Read fallbacks in
  // the control plane keep discovery working when a project is implicit.
  const projectIdParam = (req: Request): string | null => safeDecode(req.params.projectId as string);
  const badProjectId = (res: Response, id: string | null): boolean => {
    if (id === null) { jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed project id')); return true; }
    if (!PROJECT_NAME_RE.test(id)) { jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed project id')); return true; }
    return false;
  };

  router.get('/projects/:projectId/workflows', (req, res, next) => {
    const id = projectIdParam(req); if (badProjectId(res, id)) return;
    return void runControlPlane(['--project-id', id!, 'workflows']).then((r) => jsonResponse(res, r.status, r.body)).catch(next);
  });
  router.get('/projects/:projectId/workflows/:name', (req, res, next) => {
    const id = projectIdParam(req); if (badProjectId(res, id)) return;
    const name = safeDecode(req.params.name); if (name === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed workflow name'));
    return void runControlPlane(['--project-id', id!, 'workflow', name]).then((r) => jsonResponse(res, r.status, r.body)).catch(next);
  });
  router.get('/projects/:projectId/workflows/:name/graph', (req, res, next) => {
    const id = projectIdParam(req); if (badProjectId(res, id)) return;
    const name = safeDecode(req.params.name); if (name === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed workflow name'));
    return void runControlPlane(['--project-id', id!, 'graph', name]).then((r) => jsonResponse(res, r.status, r.body)).catch(next);
  });
  router.get('/projects/:projectId/runs', (req, res, next) => {
    const id = projectIdParam(req); if (badProjectId(res, id)) return;
    return void runControlPlane(['--project-id', id!, 'runs']).then((r) => jsonResponse(res, r.status, r.body)).catch(next);
  });
  router.get('/projects/:projectId/runs/:runId', (req, res, next) => {
    const id = projectIdParam(req); if (badProjectId(res, id)) return;
    const runId = safeDecode(req.params.runId); if (runId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed run id'));
    return void runControlPlane(['--project-id', id!, 'run', runId]).then((r) => jsonResponse(res, r.status, r.body)).catch(next);
  });
  router.get('/projects/:projectId/runs/:runId/events', (req, res, next) => {
    const id = projectIdParam(req); if (badProjectId(res, id)) return;
    const runId = safeDecode(req.params.runId); if (runId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed run id'));
    return void runControlPlane(['--project-id', id!, 'events', runId]).then((r) => jsonResponse(res, r.status, r.body)).catch(next);
  });
  router.get('/projects/:projectId/runs/:runId/artifacts', (req, res, next) => {
    const id = projectIdParam(req); if (badProjectId(res, id)) return;
    const runId = safeDecode(req.params.runId); if (runId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed run id'));
    return void runControlPlane(['--project-id', id!, 'artifacts', runId]).then((r) => jsonResponse(res, r.status, r.body)).catch(next);
  });
  router.get('/projects/:projectId/runs/:runId/artifact', (req, res, next) => {
    const id = projectIdParam(req); if (badProjectId(res, id)) return;
    const runId = safeDecode(req.params.runId); if (runId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed run id'));
    const artifactPath = req.query.path; if (typeof artifactPath !== 'string' || artifactPath === '') return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Missing artifact path'));
    return void runControlPlane(['--project-id', id!, 'artifact', runId, artifactPath]).then((r) => jsonResponse(res, r.status, r.body)).catch(next);
  });
  router.get('/projects/:projectId/runs/:runId/approvals', (req, res, next) => {
    const id = projectIdParam(req); if (badProjectId(res, id)) return;
    const runId = safeDecode(req.params.runId); if (runId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed run id'));
    return void runControlPlane(['--project-id', id!, 'approvals', runId]).then((r) => jsonResponse(res, r.status, r.body)).catch(next);
  });
  router.get('/projects/:projectId/runs/:runId/approval/:approvalId', (req, res, next) => {
    const id = projectIdParam(req); if (badProjectId(res, id)) return;
    const runId = safeDecode(req.params.runId); if (runId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed run id'));
    const approvalId = safeDecode(req.params.approvalId); if (approvalId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed approval id'));
    return void runControlPlane(['--project-id', id!, 'approval', runId, approvalId]).then((r) => jsonResponse(res, r.status, r.body)).catch(next);
  });
  router.get('/projects/:projectId/runs/:runId/comments', (req, res, next) => {
    const id = projectIdParam(req); if (badProjectId(res, id)) return;
    const runId = safeDecode(req.params.runId); if (runId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed run id'));
    const artifactPath = typeof req.query.path === 'string' ? req.query.path : '';
    return void runControlPlane(['--project-id', id!, 'comments', runId, '--path', artifactPath]).then((r) => jsonResponse(res, r.status, r.body)).catch(next);
  });
  router.get('/projects/:projectId/settings', (req, res, next) => {
    const id = projectIdParam(req); if (badProjectId(res, id)) return;
    return void handleGetSettings(res, id!).catch(next);
  });
  router.put('/projects/:projectId/settings', (req, res, next) => {
    const id = projectIdParam(req); if (badProjectId(res, id)) return;
    return void handleSetSettings(req, res, id!).catch(next);
  });
  router.get('/projects/:projectId/git-user', (req, res, next) => {
    const id = projectIdParam(req); if (badProjectId(res, id)) return;
    return void handleGetGitUser(res, id!).catch(next);
  });
  router.put('/projects/:projectId/git-user', (req, res, next) => {
    const id = projectIdParam(req); if (badProjectId(res, id)) return;
    return void handleSetGitUser(req, res, id!).catch(next);
  });

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
  // Workflow package asset read/write (prompt templates, etc.). Path-confined
  // to the workflow package dir via safeAssetPath + isUnderRoot.
  router.get('/studio/workflows/:name/assets/*assetPath', (req, res, next) => {
    const name = safeDecode(req.params.name);
    if (name === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed workflow name'));
    if (!WORKFLOW_NAME_RE.test(name)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'name must match /^[a-z][a-z0-9-]{0,62}$/'));
    const rawAsset = Array.isArray(req.params.assetPath) ? req.params.assetPath.join('/') : req.params.assetPath;
    const assetPath = safeAssetPath(safeDecode(rawAsset));
    if (assetPath === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Invalid asset path: must be a safe relative path ending in .md.tmpl/.md/.tmpl/.txt'));
    return void handleGetStudioAsset(res, name, assetPath).catch(next);
  });
  router.put('/studio/workflows/:name/assets/*assetPath', (req, res, next) => {
    const name = safeDecode(req.params.name);
    if (name === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed workflow name'));
    if (!WORKFLOW_NAME_RE.test(name)) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'name must match /^[a-z][a-z0-9-]{0,62}$/'));
    const rawAsset = Array.isArray(req.params.assetPath) ? req.params.assetPath.join('/') : req.params.assetPath;
    const assetPath = safeAssetPath(safeDecode(rawAsset));
    if (assetPath === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Invalid asset path: must be a safe relative path ending in .md.tmpl/.md/.tmpl/.txt'));
    return void handlePutStudioAsset(req, res, name, assetPath).catch(next);
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

  // Specific POST routes MUST precede /runs/:runId/:operation, otherwise the
  // wildcard :operation param would shadow /comments and /approvals/:id.
  router.post('/runs/:runId/approvals/:approvalId', (req, res, next) => {
    const runId = safeDecode(req.params.runId);
    const approvalId = safeDecode(req.params.approvalId);
    if (runId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed run id'));
    if (approvalId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed approval id'));
    return void handleApprovalDecision(req, res, runId, approvalId).catch(next);
  });
  router.post('/runs/:runId/comments', (req, res, next) => {
    const runId = safeDecode(req.params.runId);
    if (runId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed run id'));
    return void handleAddComment(req, res, runId).catch(next);
  });
  router.post('/runs/:runId/:operation', (req, res, next) => {
    const runId = safeDecode(req.params.runId);
    const operation = req.params.operation;
    if (runId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed run id'));
    if (operation !== 'step' && operation !== 'resume' && operation !== 'cancel') return jsonResponse(res, 404, errorBody(404, 'not_found', 'API route not found'));
    return void handleExistingRunMutation(req, res, runId, operation).catch(next);
  });

  // ---- Project-scoped run mutations, streams, and deletes (design §5.3) ----
  // Start, step/resume, decide, comment, stream, and delete under a project
  // prefix, threading projectId to the project-aware handlers above.
  router.post('/projects/:projectId/runs', (req, res, next) => {
    const id = projectIdParam(req); if (badProjectId(res, id)) return;
    return void handleStartRun(req, res, id!).catch(next);
  });
  router.get('/projects/:projectId/runs/:runId/stream', (req, res, next) => {
    const id = projectIdParam(req); if (badProjectId(res, id)) return;
    const runId = safeDecode(req.params.runId); if (runId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed run id'));
    return void handleRunStream(req, res, runId, id!).catch(next);
  });
  router.delete('/projects/:projectId/runs/:runId', (req, res, next) => {
    const id = projectIdParam(req); if (badProjectId(res, id)) return;
    const runId = safeDecode(req.params.runId); if (runId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed run id'));
    return void handleDeleteRun(res, runId, id!).catch(next);
  });
  router.post('/projects/:projectId/runs/:runId/approvals/:approvalId', (req, res, next) => {
    const id = projectIdParam(req); if (badProjectId(res, id)) return;
    const runId = safeDecode(req.params.runId); if (runId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed run id'));
    const approvalId = safeDecode(req.params.approvalId); if (approvalId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed approval id'));
    return void handleApprovalDecision(req, res, runId, approvalId, id!).catch(next);
  });
  router.post('/projects/:projectId/runs/:runId/comments', (req, res, next) => {
    const id = projectIdParam(req); if (badProjectId(res, id)) return;
    const runId = safeDecode(req.params.runId); if (runId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed run id'));
    return void handleAddComment(req, res, runId, id!).catch(next);
  });
  router.post('/projects/:projectId/runs/:runId/:operation', (req, res, next) => {
    const id = projectIdParam(req); if (badProjectId(res, id)) return;
    const runId = safeDecode(req.params.runId); if (runId === null) return jsonResponse(res, 400, errorBody(400, 'bad_request', 'Malformed run id'));
    const operation = req.params.operation;
    if (operation !== 'step' && operation !== 'resume' && operation !== 'cancel') return jsonResponse(res, 404, errorBody(404, 'not_found', 'API route not found'));
    return void handleExistingRunMutation(req, res, runId, operation, id!).catch(next);
  });

  router.use((req, res, next) => {
    if (req.method !== 'GET') return jsonResponse(res, 405, errorBody(405, 'method_not_allowed', 'Only GET, POST, PUT, and DELETE are supported for API routes'));
    const routed = routeApi(`/api${req.path}`, new URLSearchParams(req.url.split('?')[1] || ''));
    if (routed === null) return next();
    if ('badRequest' in routed) return jsonResponse(res, 400, errorBody(400, 'bad_request', routed.badRequest));
    if ('notFound' in routed) return jsonResponse(res, 404, errorBody(404, 'not_found', 'API route not found'));
    // comments GET needs --path forwarded from the query string.
    const routedArgs = routed as string[];
    const cpArgs: string[] = routedArgs[0] === 'comments' && routedArgs.length === 2
      ? [...routedArgs, '--path', new URLSearchParams(req.url.split('?')[1] || '').get('path') || '']
      : routedArgs;
    return void runControlPlane(cpArgs).then((result) => jsonResponse(res, result.status, result.body)).catch(next);
  });

  return router;
};
