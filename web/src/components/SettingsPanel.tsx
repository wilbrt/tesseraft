import { useEffect, useState } from 'react';
import { getJson, putJson } from '../lib/api';
import { useProject, projectApiUrl } from '../lib/project';
import { ConnectionsDoctorPanel } from './ConnectionsDoctorPanel';

type TokenMask = { present: boolean; preview?: string };
type Settings = {
  pi_default_provider: string | null;
  pi_default_model: string | null;
  github_token: TokenMask;
  jira_token: TokenMask;
  default_repo_root: string | null;
  source: 'project' | 'global' | 'none';
};
type SettingsResponse = { settings: Settings };

type GitUser = { name: string | null; email: string | null; source: 'project' | 'global' | 'none' };
type GitUserResponse = { git_user: GitUser };

// ---- Project abstraction runtime types ----
// The control plane emits JSON with kebab-cased compound keys
// (`credential-ref`, `workflow-roots`, `migrated-from`, `github-token`),
// while single-concept keys keep their existing snake_case (`project_id`,
// `workspace_root`, `runs_root`). These local types mirror the wire shape so
// the UI typechecks against the actual contract rather than the aspirational
// snake_case TS types in runConsole.ts.
type ProjectListItem = { project_id: string; name?: string; source?: string };
type ProjectsResponse = { projects: ProjectListItem[] };

type RuntimeMaskedCredential = {
  present?: boolean;
  // The control plane uses kebab-case `credential-ref` on the wire.
  'credential-ref'?: string;
  credential_ref?: string;
  preview?: string;
  unresolved?: string;
  error?: string;
};

type RuntimeProjectConnection = {
  base_url?: string;
  // Kebab-cased on the wire.
  'credential-ref'?: string;
  credential_ref?: string;
  credential_state?: RuntimeMaskedCredential | null;
};

type RuntimeProjectConnections = {
  jira?: RuntimeProjectConnection;
  github?: RuntimeProjectConnection;
};
type ProjectConnectionsResponse = { connections: RuntimeProjectConnections };

type RuntimeProjectDiscovery = {
  'workflow-roots'?: string[] | null;
  workflow_roots?: string[] | null;
  'tesseraft-home'?: string | null;
  tesseraft_home?: string | null;
};

type RuntimeProjectDetail = {
  project_id: string;
  name?: string;
  workspace_root?: string;
  runs_root?: string;
  discovery?: RuntimeProjectDiscovery;
  connections?: RuntimeProjectConnections;
  'migrated-from'?: string;
  migrated_from?: string;
  source?: string;
};

// Read a kebab-or-snake credential ref off a connection/mask object.
const readCredRef = (obj: { 'credential-ref'?: string; credential_ref?: string } | undefined | null): string =>
  (obj && (obj['credential-ref'] || obj.credential_ref)) || '';

const UNCHANGED = '__unchanged__';
const isNonEmpty = (value: string): boolean => value.trim() !== '';
const isBasicEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const tokenInputValue = (mask: TokenMask): string => '';

export const SettingsPanel = () => {
  const { projectId: globalProjectId } = useProject();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [repoRoot, setRepoRoot] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [jiraToken, setJiraToken] = useState('');
  const [gitName, setGitName] = useState('');
  const [gitEmail, setGitEmail] = useState('');
  const [gitUser, setGitUser] = useState<GitUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Project abstraction state.
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('default');
  const [projectDetail, setProjectDetail] = useState<RuntimeProjectDetail | null>(null);
  const [connections, setConnections] = useState<RuntimeProjectConnections | null>(null);
  const [jiraBaseUrl, setJiraBaseUrl] = useState('');
  const [jiraCredRef, setJiraCredRef] = useState('');
  const [githubCredRef, setGithubCredRef] = useState('');
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectInfo, setProjectInfo] = useState<string | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);

  const load = async (): Promise<void> => {
    try {
      const [settingsData, gitUserData] = await Promise.all([
        getJson<SettingsResponse>(projectApiUrl('/api/settings', globalProjectId)),
        getJson<GitUserResponse>(projectApiUrl('/api/git-user', globalProjectId))
      ]);
      setSettings(settingsData.settings);
      setProvider(settingsData.settings.pi_default_provider || '');
      setModel(settingsData.settings.pi_default_model || '');
      setRepoRoot(settingsData.settings.default_repo_root || '');
      setGithubToken(tokenInputValue(settingsData.settings.github_token));
      setJiraToken(tokenInputValue(settingsData.settings.jira_token));
      setGitUser(gitUserData.git_user);
      setGitName(gitUserData.git_user.name || '');
      setGitEmail(gitUserData.git_user.email || '');
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  };

  useEffect(() => { void load(); void loadProjects(); }, [globalProjectId]);

  const loadProjects = async (): Promise<void> => {
    setProjectError(null);
    try {
      const list = await getJson<ProjectsResponse>('/api/projects');
      const items = Array.isArray(list.projects) ? list.projects : [];
      setProjects(items);
      // Keep a valid selection: prefer the current selection if it still
      // exists, otherwise fall back to the first/default project.
      const stillPresent = items.some((p) => p.project_id === selectedProjectId);
      const nextId = stillPresent ? selectedProjectId : (items.find((p) => p.project_id === 'default')?.project_id || items[0]?.project_id || 'default');
      if (nextId !== selectedProjectId) setSelectedProjectId(nextId);
      await loadProject(nextId);
    } catch (loadError) {
      setProjectError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  };

  const loadProject = async (projectId: string): Promise<void> => {
    setProjectError(null);
    try {
      const [detail, conns] = await Promise.all([
        getJson<RuntimeProjectDetail>(`/api/projects/${encodeURIComponent(projectId)}`),
        getJson<ProjectConnectionsResponse>(`/api/projects/${encodeURIComponent(projectId)}/connections`)
      ]);
      setProjectDetail(detail);
      const c = conns.connections || {};
      setConnections(c);
      setJiraBaseUrl(c.jira?.base_url || '');
      setJiraCredRef(readCredRef(c.jira));
      setGithubCredRef(readCredRef(c.github));
      setProjectInfo(null);
    } catch (loadError) {
      setProjectError(loadError instanceof Error ? loadError.message : String(loadError));
      setProjectDetail(null);
      setConnections(null);
    }
  };

  const selectProject = (projectId: string): void => {
    if (projectId === selectedProjectId || projectBusy) return;
    setSelectedProjectId(projectId);
    void loadProject(projectId);
  };

  const saveConnections = async (): Promise<void> => {
    setProjectError(null);
    setProjectInfo(null);
    const id = selectedProjectId;
    // NEVER send raw token payloads: only credential_ref + base_url. The
    // server rejects any raw token key with 400 (surface-4 gate).
    const payload: { jira?: { credential_ref?: string; base_url?: string }; github?: { credential_ref?: string } } = {};
    const jira: { credential_ref?: string; base_url?: string } = {};
    if (jiraCredRef.trim() !== '') jira.credential_ref = jiraCredRef.trim();
    if (jiraBaseUrl.trim() !== '') jira.base_url = jiraBaseUrl.trim();
    if (Object.keys(jira).length > 0) payload.jira = jira;
    const github: { credential_ref?: string } = {};
    if (githubCredRef.trim() !== '') github.credential_ref = githubCredRef.trim();
    if (Object.keys(github).length > 0) payload.github = github;
    if (Object.keys(payload).length === 0) {
      setProjectError('Edit a credential ref or Jira base URL before saving connections.');
      return;
    }
    setProjectBusy(true);
    try {
      const result = await putJson<{ connections?: RuntimeProjectConnections } & { error?: { message?: string } }>(
        `/api/projects/${encodeURIComponent(id)}/connections`,
        payload
      );
      const c = result.connections || {};
      setConnections(c);
      setJiraBaseUrl(c.jira?.base_url || '');
      setJiraCredRef(readCredRef(c.jira));
      setGithubCredRef(readCredRef(c.github));
      setProjectInfo('Connections saved. Only credential references are stored; raw tokens are never accepted or exposed.');
    } catch (saveError) {
      setProjectError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setProjectBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    setError(null);
    setInfo(null);
    // Cross-field consistency: a default model without a default provider is
    // an inconsistent state. Validate inline before submitting so the user
    // gets a clear error and the save does not go through. The check uses the
    // *resulting* values: an empty field clears the stored value (the updates
    // object below sends null when a value was stored), so empty => null.
    const effectiveProvider = provider.trim() !== '' ? provider.trim() : null;
    const effectiveModel = model.trim() !== '' ? model.trim() : null;
    if (effectiveModel && !effectiveProvider) {
      setError('Default provider is required when a default model is set. Clear the model first, or set a provider.');
      return;
    }
    const updates: Record<string, unknown> = {};
    if (provider.trim() !== '') updates.pi_default_provider = provider.trim();
    else if (settings?.pi_default_provider) updates.pi_default_provider = null;
    if (model.trim() !== '') updates.pi_default_model = model.trim();
    else if (settings?.pi_default_model) updates.pi_default_model = null;
    if (repoRoot.trim() !== '') updates.default_repo_root = repoRoot.trim();
    else if (settings?.default_repo_root) updates.default_repo_root = null;
    if (isNonEmpty(githubToken)) updates.github_token = githubToken;
    else if (settings?.github_token?.present) updates.github_token = null;
    if (isNonEmpty(jiraToken)) updates.jira_token = jiraToken;
    else if (settings?.jira_token?.present) updates.jira_token = null;
    if (gitName.trim() === '' && gitEmail.trim() === '') {
      // nothing
    } else if (!isNonEmpty(gitName)) { setError('Git name is required.'); return; }
    else if (gitName.length > 200) { setError('Git name must be at most 200 characters.'); return; }
    else if (/\n/.test(gitName)) { setError('Git name must not contain newlines.'); return; }
    else if (!isNonEmpty(gitEmail) || !isBasicEmail(gitEmail)) { setError('A valid git email is required.'); return; }

    setBusy(true);
    try {
      const tasks: Promise<unknown>[] = [];
      if (Object.keys(updates).length > 0) {
        tasks.push(putJson<SettingsResponse>(projectApiUrl('/api/settings', globalProjectId), updates).then((data) => {
          setSettings(data.settings);
          setProvider(data.settings.pi_default_provider || '');
          setModel(data.settings.pi_default_model || '');
          setRepoRoot(data.settings.default_repo_root || '');
        }));
      }
      if (isNonEmpty(gitName) && isNonEmpty(gitEmail) && isBasicEmail(gitEmail)) {
        tasks.push(putJson<GitUserResponse>(projectApiUrl('/api/git-user', globalProjectId), { name: gitName, email: gitEmail }).then((data) => {
          setGitUser(data.git_user);
        }));
      }
      await Promise.all(tasks);
      setGithubToken('');
      setJiraToken('');
      setInfo('Saved. Settings are written to the project-local .tesseraft/settings.json config file; the browser never owns token values.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(false);
    }
  };

  const sourceLabel = settings?.source || 'none';
  const githubPreview = settings?.github_token?.present ? `••••${settings.github_token.preview || ''}` : <em className="muted">not configured</em>;
  const jiraPreview = settings?.jira_token?.present ? `••••${settings.jira_token.preview || ''}` : <em className="muted">not configured</em>;

  // ---- Project abstraction rendered helpers ----
  const renderMaskedState = (conn: RuntimeProjectConnection | undefined, label: string) => {
    const cs = conn?.credential_state;
    const ref = readCredRef(conn) || readCredRef(cs);
    const present = !!(cs?.present);
    const preview = cs?.preview ? `••••${cs.preview}` : '';
    const unresolved = cs?.unresolved || cs?.error;
    return (
      <dl className="field-row">
        <dt>{label} state</dt>
        <dd>
          {present ? (
            <span className="status-pill connected">configured</span>
          ) : (
            <span className="status-pill disconnected">not configured</span>
          )}
          {preview && <span className="muted"> {preview}</span>}
          {ref && <span className="muted"> ref: <code>{ref}</code></span>}
          {unresolved && <span className="warning inline"> unresolved: {unresolved}</span>}
        </dd>
      </dl>
    );
  };

  const workflowRoots: string[] = (() => {
    const d = projectDetail?.discovery;
    if (!d) return [];
    const r = d['workflow-roots'] || d.workflow_roots;
    return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : [];
  })();
  const migratedFrom = projectDetail?.['migrated-from'] || projectDetail?.migrated_from;

  return (
    <section className="panel settings-panel" aria-label="Settings">
      <h2>Settings</h2>
      <p className="muted">Configure default provider/model for Pi sessions, GitHub and Jira tokens, and the default repo root for workflows. The existing Git user identity (name + email) is also managed here. Values are stored in the project-local <code>.tesseraft/settings.json</code> and <code>.tesseraft/git-user.json</code> files; the browser never owns these values. <strong>Note:</strong> token fields and the default repo root are <em>stored only</em> — their runtime consumers are pending wiring (see field notes). Only Pi default provider/model currently affect created Pi sessions.</p>
      <p className="warning">Tokens are stored as plaintext in local config files (single-user localhost-only server). Leave a token field blank to keep its current value; clear the field text and save to remove it.</p>
      {error && <div className="error">{error}</div>}
      {info && <div className="success">{info}</div>}
      <dl className="field-row">
        <dt>Source</dt><dd><span className="status-pill">{sourceLabel}</span></dd>
      </dl>

      <div className="control-card settings-form">
        <h3>Pi defaults</h3>
        <p className="muted">Default provider and model used when creating new Pi sessions.</p>
        <label>
          Default provider
          <input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="openai" />
        </label>
        <label>
          Default model
          <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4o-mini" />
        </label>

        <h3>Tokens</h3>
        <p className="muted">Persisted locally for gh-operations and Jira adapters. <strong>Stored only</strong>: runtime consumers are not yet wired — tokens are saved here but workflow runs do not currently read them. Current values are masked.</p>
        <span className="warning inline">Pending consumer wiring (stored only).</span>
        <label>
          GitHub token
          <input type="password" value={githubToken} onChange={(event) => setGithubToken(event.target.value)} placeholder="Leave blank to keep current" />
          <small>Current: {githubPreview}</small>
        </label>
        <label>
          Jira token
          <input type="password" value={jiraToken} onChange={(event) => setJiraToken(event.target.value)} placeholder="Leave blank to keep current" />
          <small>Current: {jiraPreview}</small>
        </label>

        <h3>Workflows</h3>
        <label>
          Default repo root
          <input value={repoRoot} onChange={(event) => setRepoRoot(event.target.value)} placeholder="/Users/me/projects/my-repo" />
          <small>Default repository root for new workflow runs. <strong>Stored only</strong>: this value is saved to <code>.tesseraft/settings.json</code> but the Start-workflow wizard does not yet pre-seed a repo-root field from it (pending consumer wiring).</small>
        </label>

        <h3>Git identity</h3>
        <p className="muted">Git identity (name + email) applied to git operations in workflow runs. Stored in <code>.tesseraft/git-user.json</code>.</p>
        <dl className="field-row">
          <dt>Current name</dt><dd>{gitUser?.name || <em className="muted">not configured</em>}</dd>
          <dt>Current email</dt><dd>{gitUser?.email || <em className="muted">not configured</em>}</dd>
        </dl>
        <label>
          Name
          <input value={gitName} onChange={(event) => setGitName(event.target.value)} placeholder="Tesseraft Bot" />
        </label>
        <label>
          Email
          <input value={gitEmail} onChange={(event) => setGitEmail(event.target.value)} placeholder="bot@example.local" />
        </label>

        <div className="settings-actions">
          <button type="button" disabled={busy} onClick={() => void save()}>Save settings</button>
          <button type="button" disabled={busy} onClick={() => void load()}>Refresh</button>
        </div>
      </div>

      <ConnectionsDoctorPanel />

      {/* ---- Project abstraction (surface 10) ---- */}
      <div className="control-card settings-form" aria-label="Projects and connections">
        <h3>Projects</h3>
        <p className="muted">A first-class Project owns a workspace root, runs root, workflow discovery context, and project-specific Jira/GitHub connections. Raw credentials are kept out of repositories behind a <em>credential reference</em> (e.g. <code>env:GITHUB_TOKEN</code>); the browser never holds raw tokens. Manifests are safe to commit to <code>.tesseraft/projects/</code>.</p>
        {projectError && <div className="error">{projectError}</div>}
        {projectInfo && <div className="success">{projectInfo}</div>}

        {projects === null ? (
          <p className="muted">Loading projects…</p>
        ) : projects.length === 0 ? (
          <p className="muted">No projects found.</p>
        ) : (
          <ul className="item-list" aria-label="Projects list">
            {projects.map((p) => (
              <li key={p.project_id}>
                <button
                  type="button"
                  className={p.project_id === selectedProjectId ? 'project-tab active' : 'project-tab'}
                  onClick={() => selectProject(p.project_id)}
                >
                  <strong>{p.name || p.project_id}</strong>{' '}
                  <span className="muted">({p.project_id})</span>{' '}
                  {p.source && <span className="status-pill">{p.source}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}

        {projectDetail && (
          <div className="control-card" aria-label="Project metadata">
            <h4>{projectDetail.name || projectDetail.project_id}</h4>
            <dl className="field-row">
              <dt>Project id</dt><dd><code>{projectDetail.project_id}</code></dd>
              {projectDetail.source && <><dt>Source</dt><dd><span className="status-pill">{projectDetail.source}</span></dd></>}
              <dt>Workspace root</dt><dd><code>{projectDetail.workspace_root || <em className="muted">unset</em>}</code></dd>
              <dt>Runs root</dt><dd><code>{projectDetail.runs_root || <em className="muted">unset</em>}</code></dd>
              <dt>Workflow roots</dt><dd>{workflowRoots.length > 0 ? workflowRoots.map((r, i) => (<span key={r}>{i > 0 ? ', ' : ''}<code>{r}</code></span>)) : <em className="muted">none</em>}</dd>
              {migratedFrom && <><dt>Migrated from</dt><dd><code>{migratedFrom}</code></dd></>}
            </dl>
          </div>
        )}

        <h3>Connections</h3>
        <p className="muted">Edit per-project connection metadata. Credential references are resolved at effect time and never expose raw tokens here. Leaving a field blank keeps the current value.</p>
        {connections && (
          <>
            {renderMaskedState(connections.jira, 'Jira')}
            {renderMaskedState(connections.github, 'GitHub')}
          </>
        )}
        <label>
          Jira base URL
          <input value={jiraBaseUrl} onChange={(event) => setJiraBaseUrl(event.target.value)} placeholder="https://your-domain.atlassian.net" />
        </label>
        <label>
          Jira credential ref
          <input value={jiraCredRef} onChange={(event) => setJiraCredRef(event.target.value)} placeholder="env:JIRA_TOKEN" />
          <small>A reference like <code>env:JIRA_TOKEN</code>; raw tokens are never accepted.</small>
        </label>
        <label>
          GitHub credential ref
          <input value={githubCredRef} onChange={(event) => setGithubCredRef(event.target.value)} placeholder="env:GITHUB_TOKEN" />
          <small>A reference like <code>env:GITHUB_TOKEN</code>; raw tokens are never accepted.</small>
        </label>

        <div className="settings-actions">
          <button type="button" disabled={projectBusy} onClick={() => void saveConnections()}>Save connections</button>
          <button type="button" disabled={projectBusy} onClick={() => void loadProjects()}>Refresh project</button>
        </div>
      </div>
    </section>
  );
};