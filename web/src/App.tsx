import { useEffect, useMemo, useState } from 'react';
import { WorkflowGraph } from './components/WorkflowGraph';
import type { GraphEdge, GraphNode } from './lib/graphLayout';
import './style.css';

type WorkflowSummary = { name: string; path?: string };
type WorkflowDetail = { name: string; path?: string; api_version?: string; lint?: { ok?: boolean } };
type Attempt = { attempt?: number; node_id?: string; state?: string; status?: string; started_at?: string; finished_at?: string; next_state?: string; error?: string; result?: unknown; effects?: string[] };
type Failure = { source?: string; message?: string; path?: string; node_id?: string };
type Artifact = { path: string; name?: string; source?: string; node_id?: string; attempt?: number; kind?: string; exists?: boolean; size?: number; content_type?: string; read_url?: string };
type ArtifactRead = { artifact: Artifact; previewable?: boolean; content?: string; reason?: string };
type RunSummary = { run_id: string; workflow_name?: string; status?: string };
type RunDetail = RunSummary & { state?: string; round?: number; attempt?: number; path?: string; attempts?: Attempt[]; failures?: Failure[] };
type EventRecord = { event?: string; type?: string; state?: string; from?: string; attempt?: number; [key: string]: unknown };

type LoadState<T> = {
  data: T;
  error: string | null;
};

const getJson = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.error) {
    const message = data.error?.message || `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return data;
};

const eventName = (event: EventRecord): string => event.event || event.type || 'event';
const nodeForEvent = (event: EventRecord): string | undefined => event.state || event.from;
const snippet = (value: unknown): string => JSON.stringify(value, null, 2).slice(0, 700);

const FieldList = ({ fields }: { fields: Array<[string, unknown]> }) => (
  <dl>
    {fields.map(([label, value]) => (
      <div className="field-row" key={label}>
        <dt>{label}</dt>
        <dd>{String(value ?? '')}</dd>
      </div>
    ))}
  </dl>
);

const FailureSummary = ({ run }: { run: RunDetail | null }) => {
  const failures = run?.failures || [];
  if (!run || (failures.length === 0 && !['failed', 'error'].includes(run.status || ''))) return null;
  return (
    <div className="failure-summary" aria-label="Run failure summary">
      <strong>Failure / issues</strong>
      <ul>
        {['failed', 'error'].includes(run.status || '') && <li>Run status: {run.status}</li>}
        {failures.map((failure, index) => (
          <li key={`${failure.source || 'failure'}-${index}`}>{failure.message || failure.path || failure.node_id}</li>
        ))}
      </ul>
    </div>
  );
};

const AttemptTimeline = ({ attempts, selectedNodeId }: { attempts: Attempt[]; selectedNodeId: string | null }) => (
  <section className="run-console-section" aria-label="Attempt timeline">
    <h3>Attempt timeline</h3>
    <ol className="timeline">
      {attempts.length === 0 && <li className="muted">No attempts derived.</li>}
      {attempts.map((attempt, index) => {
        const nodeId = attempt.node_id || attempt.state;
        const related = selectedNodeId && nodeId === selectedNodeId;
        return (
          <li className={related ? 'related' : ''} key={`${nodeId || 'attempt'}-${attempt.attempt || index}-${index}`}>
            <div className="timeline-head">
              <strong>{nodeId || 'unknown node'}</strong>
              <span className={`status-pill ${attempt.status || 'unknown'}`}>{attempt.status || 'unknown'}</span>
            </div>
            <div className="muted">Attempt {attempt.attempt ?? index + 1} · {attempt.started_at || '?'} → {attempt.finished_at || 'running'}</div>
            {attempt.next_state && <div>Next: {attempt.next_state}</div>}
            {attempt.error && <div className="error inline">{attempt.error}</div>}
            {attempt.result && <pre>{snippet(attempt.result)}</pre>}
          </li>
        );
      })}
    </ol>
  </section>
);

const ArtifactBrowser = ({ runId, artifacts, selectedNodeId }: { runId: string | null; artifacts: Artifact[]; selectedNodeId: string | null }) => {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ArtifactRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filtered = useMemo(() => selectedNodeId ? artifacts.filter((artifact) => artifact.node_id === selectedNodeId || !artifact.node_id) : artifacts, [artifacts, selectedNodeId]);

  const selectArtifact = async (artifact: Artifact): Promise<void> => {
    if (!runId) return;
    setSelectedPath(artifact.path);
    setPreview(null);
    setError(null);
    try {
      const data = await getJson<ArtifactRead>(`/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(artifact.path)}`);
      setPreview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="run-console-section artifact-grid" aria-label="Artifact browser">
      <div>
        <h3>Artifacts</h3>
        <ul className="item-list compact artifact-list">
          {filtered.length === 0 && <li className="muted">No artifacts found.</li>}
          {filtered.map((artifact) => (
            <li key={`${artifact.source || 'artifact'}-${artifact.path}`} className={selectedPath === artifact.path ? 'selected-row' : ''}>
              <button type="button" onClick={() => selectArtifact(artifact)}>{artifact.path}</button>
              <span>{artifact.source} · {artifact.content_type} · {artifact.exists ? `${artifact.size ?? 0} bytes` : 'missing'}{artifact.node_id ? ` · ${artifact.node_id}` : ''}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3>Preview</h3>
        {error && <div className="error">{error}</div>}
        {!preview && !error && <div className="empty">Select a small text, JSON, markdown, EDN, or log artifact.</div>}
        {preview && (
          <div>
            <FieldList fields={[["Path", preview.artifact.path], ["Type", preview.artifact.content_type], ["Size", preview.artifact.size], ["Preview", preview.previewable ? 'yes' : preview.reason]]} />
            {preview.previewable && <pre>{preview.content}</pre>}
          </div>
        )}
      </div>
    </section>
  );
};

export const App = () => {
  const [workflows, setWorkflows] = useState<LoadState<WorkflowSummary[]>>({ data: [], error: null });
  const [runs, setRuns] = useState<LoadState<RunSummary[]>>({ data: [], error: null });
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
  const [workflowDetail, setWorkflowDetail] = useState<WorkflowDetail | null>(null);
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] }>({ nodes: [], edges: [] });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    getJson<{ workflows: WorkflowSummary[] }>('/api/workflows')
      .then((data) => setWorkflows({ data: data.workflows || [], error: null }))
      .catch((error: Error) => setWorkflows({ data: [], error: error.message }));
    getJson<{ runs: RunSummary[] }>('/api/runs')
      .then((data) => setRuns({ data: data.runs || [], error: null }))
      .catch((error: Error) => setRuns({ data: [], error: error.message }));
  }, []);

  const selectWorkflow = async (name: string): Promise<void> => {
    setSelectedWorkflow(name);
    setSelectedNodeId(null);
    setWorkflowError(null);
    setWorkflowDetail(null);
    setGraph({ nodes: [], edges: [] });
    try {
      const [detail, graphData] = await Promise.all([
        getJson<{ workflow: WorkflowDetail }>(`/api/workflows/${encodeURIComponent(name)}`),
        getJson<{ nodes: GraphNode[]; edges: GraphEdge[] }>(`/api/workflows/${encodeURIComponent(name)}/graph`)
      ]);
      setWorkflowDetail(detail.workflow);
      setGraph({ nodes: graphData.nodes || [], edges: graphData.edges || [] });
    } catch (error) {
      setWorkflowError(error instanceof Error ? error.message : String(error));
    }
  };

  const selectRun = async (runId: string): Promise<void> => {
    setSelectedRun(runId);
    setRunError(null);
    setRunDetail(null);
    setEvents([]);
    setArtifacts([]);
    try {
      const [detail, eventData, artifactData] = await Promise.all([
        getJson<{ run: RunDetail }>(`/api/runs/${encodeURIComponent(runId)}`),
        getJson<{ events: EventRecord[] }>(`/api/runs/${encodeURIComponent(runId)}/events`),
        getJson<{ artifacts: Artifact[] }>(`/api/runs/${encodeURIComponent(runId)}/artifacts`)
      ]);
      setRunDetail(detail.run);
      setEvents(eventData.events || []);
      setArtifacts(artifactData.artifacts || []);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    }
  };

  const visibleEvents = selectedNodeId ? events.filter((event) => nodeForEvent(event) === selectedNodeId || !nodeForEvent(event)) : events;

  return (
    <>
      <header>
        <h1>Tesseraft Local Web UI</h1>
        <p>Read-only local inspection of workflows, visual graphs, runs, attempts, artifacts, and events.</p>
      </header>
      <main>
        <section className="panel">
          <h2>Workflows</h2>
          {workflows.error && <div className="error">{workflows.error}</div>}
          <ul className="item-list">
            {workflows.data.length === 0 && <li className="muted">No workflows found.</li>}
            {workflows.data.map((workflow) => (
              <li key={workflow.name}>
                <button type="button" onClick={() => selectWorkflow(workflow.name)}>{workflow.name || '(unnamed)'}</button>
                <span>{workflow.path}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel detail">
          <h2>Workflow detail</h2>
          {workflowError && <div className="error">{workflowError}</div>}
          {!workflowDetail && !workflowError && <div className="empty">{selectedWorkflow ? 'Loading workflow...' : 'Select a workflow.'}</div>}
          {workflowDetail && (
            <FieldList fields={[
              ['Name', workflowDetail.name],
              ['Path', workflowDetail.path],
              ['API version', workflowDetail.api_version],
              ['Lint', workflowDetail.lint?.ok ? 'ok' : 'has issues'],
              ['Selected graph node', selectedNodeId || 'none']
            ]} />
          )}
          <WorkflowGraph nodes={graph.nodes} edges={graph.edges} selectedNodeId={selectedNodeId} onSelectNode={(node) => setSelectedNodeId(node.id)} />
        </section>

        <section className="panel">
          <h2>Runs</h2>
          {runs.error && <div className="error">{runs.error}</div>}
          <ul className="item-list">
            {runs.data.length === 0 && <li className="muted">No runs found. Run a workflow locally to populate this list.</li>}
            {runs.data.map((run) => (
              <li key={run.run_id}>
                <button type="button" onClick={() => selectRun(run.run_id)}>{run.run_id}</button>
                <span>{run.workflow_name} — {run.status}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel detail">
          <h2>Run detail</h2>
          {runError && <div className="error">{runError}</div>}
          {!runDetail && !runError && <div className="empty">{selectedRun ? 'Loading run...' : 'Select a run.'}</div>}
          {runDetail && (
            <FieldList fields={[
              ['Run ID', runDetail.run_id],
              ['Workflow', runDetail.workflow_name],
              ['Status', runDetail.status],
              ['State', runDetail.state],
              ['Round / attempt', `${runDetail.round ?? ''} / ${runDetail.attempt ?? ''}`],
              ['Path', runDetail.path],
              ['Selected node filter', selectedNodeId || 'none']
            ]} />
          )}
          <FailureSummary run={runDetail} />
          <AttemptTimeline attempts={runDetail?.attempts || []} selectedNodeId={selectedNodeId} />
          <ArtifactBrowser runId={selectedRun} artifacts={artifacts} selectedNodeId={selectedNodeId} />
          <h3>Events</h3>
          <ol className="event-list">
            {visibleEvents.length === 0 && <li className="muted">No events found.</li>}
            {visibleEvents.map((event, index) => (
              <li key={`${eventName(event)}-${index}`} className={selectedNodeId && nodeForEvent(event) === selectedNodeId ? 'related' : ''}>
                <code>{eventName(event)}</code>
                <pre>{JSON.stringify(event, null, 2)}</pre>
              </li>
            ))}
          </ol>
        </section>
      </main>
    </>
  );
};
