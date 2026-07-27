import { useEffect, useState } from 'react';
import { getJson, putJson } from '../lib/api';

export type WorkTrackerField = {
  name: string;
  label: string;
  type: string;
  required: boolean;
  placeholder?: string;
};
export type WorkTrackerProvider = {
  provider: string;
  fields: WorkTrackerField[];
  credential_ref: { required: boolean };
};
type WorkTrackerProvidersResponse = { providers: WorkTrackerProvider[] };

type RuntimeMaskedCredential = {
  present?: boolean;
  state?: 'present' | 'absent' | 'unresolved' | 'invalid';
  unresolved?: string;
  error?: string;
};

export type RuntimeWorkTrackerConnection = {
  provider?: string;
  'credential-ref'?: string;
  credential_ref?: string;
  config?: Record<string, unknown>;
  'credential-state'?: RuntimeMaskedCredential | null;
  credential_state?: RuntimeMaskedCredential | null;
};

type RuntimeProjectConnections = Record<string, unknown> & { 'work-tracker'?: RuntimeWorkTrackerConnection };

const readCredRef = (tracker: RuntimeWorkTrackerConnection | undefined): string =>
  (tracker && (tracker['credential-ref'] || tracker.credential_ref)) || '';

const readCredState = (tracker: RuntimeWorkTrackerConnection | undefined): RuntimeMaskedCredential | null =>
  (tracker && (tracker['credential-state'] || tracker.credential_state)) || null;

const credentialStateLabel: Record<string, string> = {
  present: 'Present',
  absent: 'Absent',
  unresolved: 'Unresolved',
  invalid: 'Invalid'
};

export const WorkTrackerPanel = ({
  projectId,
  tracker,
  onSaved
}: {
  projectId: string;
  tracker: RuntimeWorkTrackerConnection | undefined;
  onSaved: (connections: RuntimeProjectConnections) => void;
}) => {
  const [providers, setProviders] = useState<WorkTrackerProvider[] | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [credentialRef, setCredentialRef] = useState('');
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getJson<WorkTrackerProvidersResponse>('/api/work-tracker-providers');
        if (!cancelled) setProviders(Array.isArray(data.providers) ? data.providers : []);
      } catch (loadError) {
        if (!cancelled) setProvidersError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Reset messages only when the *selected project* changes, not whenever the
  // `tracker` prop identity changes (save/clear replace it via `onSaved`,
  // which must not wipe the confirmation message set immediately after).
  useEffect(() => {
    setError(null);
    setInfo(null);
  }, [projectId]);

  useEffect(() => {
    setSelectedProvider(tracker?.provider || '');
    setCredentialRef(readCredRef(tracker));
    const config = (tracker?.config || {}) as Record<string, unknown>;
    const nextValues: Record<string, string> = {};
    for (const [key, value] of Object.entries(config)) nextValues[key] = value === null || value === undefined ? '' : String(value);
    setConfigValues(nextValues);
  }, [projectId, tracker]);

  const activeFields = providers?.find((p) => p.provider === selectedProvider)?.fields || [];

  const selectProvider = (nextProvider: string): void => {
    setSelectedProvider(nextProvider);
    setConfigValues({});
    setError(null);
    setInfo(null);
  };

  const setFieldValue = (name: string, value: string): void => {
    setConfigValues((prev) => ({ ...prev, [name]: value }));
  };

  const save = async (): Promise<void> => {
    setError(null);
    setInfo(null);
    if (selectedProvider.trim() === '') {
      setError('Choose a work-tracker provider, or use Clear tracker to remove one.');
      return;
    }
    if (credentialRef.trim() === '') {
      setError('A credential reference (e.g. env:PLANE_API_KEY) is required.');
      return;
    }
    const config: Record<string, string> = {};
    for (const field of activeFields) {
      const value = (configValues[field.name] || '').trim();
      if (field.required || value !== '') config[field.name] = value;
    }
    setBusy(true);
    try {
      const result = await putJson<{ connections?: RuntimeProjectConnections }>(
        `/api/projects/${encodeURIComponent(projectId)}/connections`,
        { work_tracker: { provider: selectedProvider, credential_ref: credentialRef.trim(), config } }
      );
      onSaved(result.connections || {});
      setInfo('Work tracker saved. Only the provider, credential reference, and non-secret config are stored; the browser never holds credential values.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(false);
    }
  };

  const clear = async (): Promise<void> => {
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const result = await putJson<{ connections?: RuntimeProjectConnections }>(
        `/api/projects/${encodeURIComponent(projectId)}/connections`,
        { clear_work_tracker: true }
      );
      onSaved(result.connections || {});
      selectProvider('');
      setCredentialRef('');
      setInfo('Work tracker cleared. No primary work tracker is configured; this is a valid project state.');
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : String(clearError));
    } finally {
      setBusy(false);
    }
  };

  const credState = readCredState(tracker);
  const credStateKey = credState?.state || (credState?.present ? 'present' : null);

  return (
    <div className="control-card work-tracker-panel" aria-label="Work tracker">
      <h3>Work tracker</h3>
      <p className="muted">
        The primary work tracker is resolved from the nearest ancestor <code>.tesseraft/project.json</code> to the
        selected project (or the current directory when Tesseraft develops itself — a Tesseraft checkout is an
        ordinary project under this same contract). <strong>Ownership:</strong> the project owns the credential
        reference (e.g. <code>env:PLANE_API_KEY</code>); the user, machine, or CI owns the referenced credential
        value. Raw credential values are never accepted or displayed here.
      </p>
      {providersError && <div className="error" role="alert">{providersError}</div>}
      {error && <div className="error" role="alert">{error}</div>}
      {info && <div className="success">{info}</div>}

      <label>
        Provider
        <select value={selectedProvider} onChange={(event) => selectProvider(event.target.value)}>
          <option value="">No tracker</option>
          {(providers || []).map((p) => (
            <option key={p.provider} value={p.provider}>{p.provider}</option>
          ))}
        </select>
      </label>

      {selectedProvider !== '' && (
        <>
          {activeFields.map((field) => (
            <label key={field.name}>
              {field.label}{field.required && <span className="required"> *</span>}
              <input
                type={field.type === 'url' ? 'url' : 'text'}
                value={configValues[field.name] || ''}
                onChange={(event) => setFieldValue(field.name, event.target.value)}
                placeholder={field.placeholder}
              />
            </label>
          ))}
          <label>
            Credential reference
            <input
              value={credentialRef}
              onChange={(event) => setCredentialRef(event.target.value)}
              placeholder="env:PLANE_API_KEY"
            />
            <small>A reference like <code>env:PLANE_API_KEY</code>; raw credential values are never accepted.</small>
          </label>
        </>
      )}

      <dl className="field-row">
        <dt>Credential state</dt>
        <dd>
          {credStateKey ? (
            <span className={`status-pill tracker-state ${credStateKey}`}>{credentialStateLabel[credStateKey] || credStateKey}</span>
          ) : (
            <span className="status-pill tracker-state absent">Absent</span>
          )}
        </dd>
      </dl>

      <div className="settings-actions">
        <button type="button" disabled={busy} onClick={() => void save()}>Save tracker</button>
        <button type="button" disabled={busy} onClick={() => void clear()}>Clear tracker</button>
      </div>
    </div>
  );
};
