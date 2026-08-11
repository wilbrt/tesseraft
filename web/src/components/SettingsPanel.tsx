import { useEffect, useState } from 'react';
import { getJson, putJson } from '../lib/api';
import { projectApiUrl, useProject } from '../lib/project';
import { ConnectionsDoctorPanel } from './ConnectionsDoctorPanel';
import { GitUserPanel } from './GitUserPanel';
import { ProjectConnectionsPanel } from '../features/settings/ProjectConnectionsPanel';

type ColorScheme = 'classic' | 'matrix';
type Settings = {
  pi_default_provider: string | null;
  pi_default_model: string | null;
  default_repo_root: string | null;
  color_scheme: ColorScheme;
  source: 'user-preferences';
};
export const SettingsPanel = ({ onColorSchemeChange }: { onColorSchemeChange: (scheme: ColorScheme) => void }) => {
  const { projectId } = useProject();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [repoRoot, setRepoRoot] = useState('');
  const [colorScheme, setColorScheme] = useState<ColorScheme>('classic');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const applySettings = (next: Settings): void => {
    setSettings(next);
    setProvider(next.pi_default_provider || '');
    setModel(next.pi_default_model || '');
    setRepoRoot(next.default_repo_root || '');
    setColorScheme(next.color_scheme === 'matrix' ? 'matrix' : 'classic');
  };

  const load = async (): Promise<void> => {
    try {
      const response = await getJson<{ settings: Settings }>(projectApiUrl('/api/settings', projectId));
      applySettings(response.settings);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => { void load(); }, [projectId]);

  const save = async (): Promise<void> => {
    setError(null); setInfo(null);
    const effectiveProvider = provider.trim() || null;
    const effectiveModel = model.trim() || null;
    if (effectiveModel && !effectiveProvider) {
      setError('Default provider is required when a default model is set.');
      return;
    }
    const updates: Record<string, unknown> = { color_scheme: colorScheme };
    if (effectiveProvider) updates.pi_default_provider = effectiveProvider;
    else if (settings?.pi_default_provider) updates.pi_default_provider = null;
    if (effectiveModel) updates.pi_default_model = effectiveModel;
    else if (settings?.pi_default_model) updates.pi_default_model = null;
    if (repoRoot.trim()) updates.default_repo_root = repoRoot.trim();
    else if (settings?.default_repo_root) updates.default_repo_root = null;

    setBusy(true);
    try {
      const response = await putJson<{ settings: Settings }>(projectApiUrl('/api/settings', projectId), updates);
      applySettings(response.settings);
      onColorSchemeChange(response.settings.color_scheme);
      setInfo('Saved user preferences and non-secret runtime defaults.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel settings-panel" aria-label="Settings">
      <h2>Settings</h2>
      <p className="muted">Each section has one owner: user preferences, Git identity, portable project connections, and diagnostics.</p>
      {error && <div className="error">{error}</div>}
      {info && <div className="success">{info}</div>}
      <div className="settings-layout">
        <section className="control-card settings-form settings-primary" aria-label="User preferences">
          <h3>User preferences</h3>
          <dl className="field-row"><dt>Source</dt><dd><span className="status-pill">{settings?.source || 'none'}</span></dd></dl>
          <fieldset className="color-scheme-options">
            <legend>Color scheme</legend>
            <label><input type="radio" name="color-scheme" value="classic" checked={colorScheme === 'classic'} onChange={() => setColorScheme('classic')} /><span><strong>Classic</strong><small>Standard Tesseraft palette.</small></span></label>
            <label><input type="radio" name="color-scheme" value="matrix" checked={colorScheme === 'matrix'} onChange={() => setColorScheme('matrix')} /><span><strong>Matrix</strong><small>High-contrast console palette.</small></span></label>
          </fieldset>
          <h3>Pi defaults</h3>
          <label>Default provider<input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="openai" /></label>
          <label>Default model<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4o-mini" /></label>
          <h3>Workflow defaults</h3>
          <label>Default repo root<input value={repoRoot} onChange={(event) => setRepoRoot(event.target.value)} placeholder="/Users/me/projects/my-repo" /></label>
          <div className="settings-actions">
            <button type="button" disabled={busy} onClick={() => void save()}>Save preferences</button>
            <button type="button" disabled={busy} onClick={() => void load()}>Refresh</button>
          </div>
        </section>
        <GitUserPanel />
        <ProjectConnectionsPanel />
        <ConnectionsDoctorPanel />
      </div>
    </section>
  );
};
