import { useEffect, useState } from 'react';
import { getJson, putJson } from '../lib/api';
import { useProject, projectApiUrl } from '../lib/project';

type GitUser = { name: string | null; email: string | null; source: 'project' | 'global' | 'none' };
type GitUserResponse = { git_user: GitUser };

const isNonEmpty = (value: string): boolean => value.trim() !== '';
const isBasicEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

export const GitUserPanel = () => {
  const { projectId } = useProject();
  const [gitUser, setGitUser] = useState<GitUser | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    try {
      const data = await getJson<GitUserResponse>(projectApiUrl('/api/git-user', projectId));
      setGitUser(data.git_user);
      setName(data.git_user.name || '');
      setEmail(data.git_user.email || '');
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  };

  useEffect(() => { void load(); }, [projectId]);

  const save = async (): Promise<void> => {
    setError(null);
    setInfo(null);
    if (!isNonEmpty(name)) { setError('Name is required.'); return; }
    if (name.length > 200) { setError('Name must be at most 200 characters.'); return; }
    if (/\n/.test(name)) { setError('Name must not contain newlines.'); return; }
    if (!isNonEmpty(email) || !isBasicEmail(email)) { setError('Email is required and must be a valid address.'); return; }
    setBusy(true);
    try {
      const refreshed = await putJson<GitUserResponse>(projectApiUrl('/api/git-user', projectId), { name, email });
      setGitUser(refreshed.git_user);
      setInfo('Saved. The git user is written to the project-local config file.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(false);
    }
  };

  const sourceLabel = gitUser?.source || 'none';

  return (
    <section className="panel git-user-panel" aria-label="Git user settings">
      <h2>Git user</h2>
      <p className="muted">Configure the git identity (name + email) that Tesseraft workflows apply to git operations such as branch, worktree, and push. Stored in the project-local <code>.tesseraft/git-user.json</code> config file; the browser never owns this value.</p>
      {error && <div className="error">{error}</div>}
      {info && <div className="success">{info}</div>}
      <dl className="field-row">
        <dt>Current name</dt><dd>{gitUser?.name || <em className="muted">not configured</em>}</dd>
        <dt>Current email</dt><dd>{gitUser?.email || <em className="muted">not configured</em>}</dd>
        <dt>Source</dt><dd><span className="status-pill">{sourceLabel}</span></dd>
      </dl>
      <div className="control-card git-user-form">
        <label>
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Tesseraft Bot" />
        </label>
        <label>
          Email
          <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="bot@example.local" />
        </label>
        <button type="button" disabled={busy} onClick={() => void save()}>Save git user</button>
        <button type="button" disabled={busy} onClick={() => void load()}>Refresh</button>
      </div>
    </section>
  );
};