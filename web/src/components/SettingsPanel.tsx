import { useEffect, useState } from 'react';
import { getJson, putJson } from '../lib/api';

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

const UNCHANGED = '__unchanged__';
const isNonEmpty = (value: string): boolean => value.trim() !== '';
const isBasicEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const tokenInputValue = (mask: TokenMask): string => '';

export const SettingsPanel = () => {
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

  const load = async (): Promise<void> => {
    try {
      const [settingsData, gitUserData] = await Promise.all([
        getJson<SettingsResponse>('/api/settings'),
        getJson<GitUserResponse>('/api/git-user')
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

  useEffect(() => { void load(); }, []);

  const save = async (): Promise<void> => {
    setError(null);
    setInfo(null);
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
        tasks.push(putJson<SettingsResponse>('/api/settings', updates).then((data) => {
          setSettings(data.settings);
          setProvider(data.settings.pi_default_provider || '');
          setModel(data.settings.pi_default_model || '');
          setRepoRoot(data.settings.default_repo_root || '');
        }));
      }
      if (isNonEmpty(gitName) && isNonEmpty(gitEmail) && isBasicEmail(gitEmail)) {
        tasks.push(putJson<GitUserResponse>('/api/git-user', { name: gitName, email: gitEmail }).then((data) => {
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

  return (
    <section className="panel settings-panel" aria-label="Settings">
      <h2>Settings</h2>
      <p className="muted">Configure default provider/model for Pi sessions, GitHub and Jira tokens, and the default repo root for workflows. The existing Git user identity (name + email) is also managed here. Values are stored in the project-local <code>.tesseraft/settings.json</code> and <code>.tesseraft/git-user.json</code> files; the browser never owns these values.</p>
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
        <p className="muted">Stored for future use by gh-operations and Jira adapters. Current values are masked.</p>
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
          <small>Default repository root for new workflow runs.</small>
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
    </section>
  );
};