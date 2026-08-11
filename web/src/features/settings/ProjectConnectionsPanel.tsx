import { useEffect, useState } from 'react';
import { getJson, putJson } from '../../lib/api';
import { WorkTrackerPanel, type RuntimeWorkTrackerConnection } from '../../components/WorkTrackerPanel';

type ProjectListItem = { project_id: string; name?: string; source?: string };
type RuntimeMaskedCredential = { present?: boolean; 'credential-ref'?: string; preview?: string; unresolved?: string; error?: string };
type RuntimeProjectConnection = {
  provider?: string;
  'auth-mode'?: 'credential-ref' | 'ambient';
  'credential-ref'?: string;
  credential_state?: RuntimeMaskedCredential | null;
};
type RuntimeProjectConnections = {
  'code-host'?: RuntimeProjectConnection;
  'work-tracker'?: RuntimeWorkTrackerConnection;
};
type RuntimeProjectDetail = {
  project_id: string;
  name?: string;
  workspace_root?: string;
  runs_root?: string;
  discovery?: { 'workflow-roots'?: string[] | null };
  connections?: RuntimeProjectConnections;
  migration?: { source_version?: number; source_sha256?: string; tool_version?: string };
  source?: string;
};

const readCredentialRef = (value: { 'credential-ref'?: string } | undefined | null): string =>
  value?.['credential-ref'] || '';

export const ProjectConnectionsPanel = () => {
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState('default');
  const [projectDetail, setProjectDetail] = useState<RuntimeProjectDetail | null>(null);
  const [connections, setConnections] = useState<RuntimeProjectConnections | null>(null);
  const [codeHostCredentialRef, setCodeHostCredentialRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadProject = async (projectId: string): Promise<void> => {
    setError(null);
    try {
      const [detail, connectionResponse] = await Promise.all([
        getJson<RuntimeProjectDetail>(`/api/projects/${encodeURIComponent(projectId)}`),
        getJson<{ connections: RuntimeProjectConnections }>(`/api/projects/${encodeURIComponent(projectId)}/connections`)
      ]);
      const nextConnections = connectionResponse.connections || {};
      setProjectDetail(detail);
      setConnections(nextConnections);
      setCodeHostCredentialRef(readCredentialRef(nextConnections['code-host']));
      setInfo(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setProjectDetail(null);
      setConnections(null);
    }
  };

  const loadProjects = async (): Promise<void> => {
    setError(null);
    try {
      const response = await getJson<{ projects: ProjectListItem[] }>('/api/projects');
      const items = Array.isArray(response.projects) ? response.projects : [];
      setProjects(items);
      const nextId = items.some((project) => project.project_id === selectedProjectId)
        ? selectedProjectId
        : (items.find((project) => project.project_id === 'default')?.project_id || items[0]?.project_id || 'default');
      setSelectedProjectId(nextId);
      await loadProject(nextId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => { void loadProjects(); }, []);

  const saveConnections = async (): Promise<void> => {
    setError(null); setInfo(null); setBusy(true);
    const credentialRef = codeHostCredentialRef.trim();
    const payload = {
      'code-host': credentialRef
        ? { provider: 'github', 'auth-mode': 'credential-ref', 'credential-ref': credentialRef }
        : { provider: 'github', 'auth-mode': 'ambient' }
    };
    try {
      const response = await putJson<{ connections?: RuntimeProjectConnections }>(
        `/api/projects/${encodeURIComponent(selectedProjectId)}/connections`, payload
      );
      const nextConnections = response.connections || {};
      setConnections(nextConnections);
      setCodeHostCredentialRef(readCredentialRef(nextConnections['code-host']));
      setInfo('Connections saved. Only credential references are persisted.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const credentialState = connections?.['code-host']?.credential_state;
  const credentialRef = readCredentialRef(connections?.['code-host']) || readCredentialRef(credentialState);
  const workflowRoots = projectDetail?.discovery?.['workflow-roots'] || [];

  return (
    <section className="control-card settings-form settings-projects" aria-label="Projects and connections">
      <h3>Projects</h3>
      <p className="muted">Portable descriptors own project configuration; the machine-local registry owns only local roots. Connections store references, never secret values.</p>
      {error && <div className="error">{error}</div>}
      {info && <div className="success">{info}</div>}
      {projects === null ? <p className="muted">Loading projects…</p> : (
        <ul className="item-list" aria-label="Projects list">
          {projects.map((project) => (
            <li key={project.project_id}>
              <button type="button" className={project.project_id === selectedProjectId ? 'project-tab active' : 'project-tab'}
                onClick={() => { if (!busy) { setSelectedProjectId(project.project_id); void loadProject(project.project_id); } }}>
                <strong>{project.name || project.project_id}</strong>{' '}
                <span className="muted">({project.project_id})</span>{' '}
                {project.source && <span className="status-pill">{project.source}</span>}
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
            <dt>Workspace root</dt><dd><code>{projectDetail.workspace_root || 'unset'}</code></dd>
            <dt>Runs root</dt><dd><code>{projectDetail.runs_root || 'unset'}</code></dd>
            <dt>Workflow roots</dt><dd>{workflowRoots.length ? workflowRoots.map((root, index) => <span key={root}>{index ? ', ' : ''}<code>{root}</code></span>) : <em className="muted">none</em>}</dd>
            {projectDetail.migration?.source_version && <><dt>Migrated from</dt><dd><code>{projectDetail.migration.source_version}</code></dd></>}
          </dl>
        </div>
      )}

      <h3>Code-host connection</h3>
      <dl className="field-row">
        <dt>Credential state</dt>
        <dd>
          <span className={`status-pill ${credentialState?.present ? 'connected' : 'disconnected'}`}>
            {credentialState?.present ? 'configured' : 'not configured'}
          </span>
          {credentialState?.preview && <span className="muted"> ••••{credentialState.preview}</span>}
          {credentialRef && <span className="muted"> ref: <code>{credentialRef}</code></span>}
          {(credentialState?.unresolved || credentialState?.error) && <span className="warning inline"> unresolved: {credentialState.unresolved || credentialState.error}</span>}
        </dd>
      </dl>
      <label>
        GitHub credential reference
        <input value={codeHostCredentialRef} onChange={(event) => setCodeHostCredentialRef(event.target.value)} placeholder="env:GITHUB_TOKEN (blank for ambient gh auth)" />
      </label>
      <div className="settings-actions">
        <button type="button" disabled={busy} onClick={() => void saveConnections()}>Save connections</button>
        <button type="button" disabled={busy} onClick={() => void loadProjects()}>Refresh project</button>
      </div>
      <WorkTrackerPanel
        projectId={selectedProjectId}
        tracker={connections?.['work-tracker']}
        onSaved={(next) => {
          const nextConnections = next as RuntimeProjectConnections;
          setConnections(nextConnections);
          setCodeHostCredentialRef(readCredentialRef(nextConnections['code-host']));
        }}
      />
    </section>
  );
};
