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
type MutationResult = { operation?: string; status?: string; code?: string; run_id?: string; cli?: unknown; latest_runtime?: unknown; run_detail?: unknown };

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

const postJson = async <T,>(url: string, body: unknown): Promise<T> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if ((!response.ok && data.status !== 'guarded') || data.error) {
    const message = data.error?.message || data.cli?.stderr || `Request failed: ${response.status}`;
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

const RunControls = ({ selectedWorkflow, selectedRun, runDetail, onRefresh }: { selectedWorkflow: string | null; selectedRun: string | null; runDetail: RunDetail | null; onRefresh: (runId?: string) => Promise<void> }) => {
  const [runId, setRunId] = useState(`run-${Date.now()}`);
  const [inputsText, setInputsText] = useState('');
  const [maxSteps, setMaxSteps] = useState(10);
  const [confirmStart, setConfirmStart] = useState(false);
  const [confirmStep, setConfirmStep] = useState(false);
  const [confirmResume, setConfirmResume] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MutationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const smokeSafe = selectedWorkflow === 'smoke-demo' || runDetail?.workflow_name === 'smoke-demo';

  const parseInputs = (): Record<string, string> => {
    const inputs: Record<string, string> = {};
    for (const line of inputsText.split('\n').map((item) => item.trim()).filter(Boolean)) {
      const [key, ...rest] = line.split('=');
      if (!key || rest.length === 0) throw new Error(`Invalid input "${line}"; use key=value`);
      inputs[key] = rest.join('=');
    }
    return inputs;
  };

  const mutate = async (label: string, action: () => Promise<MutationResult>, refreshRunId?: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const data = await action();
      setResult(data);
      await onRefresh(refreshRunId || data.run_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      if (label === 'start') setConfirmStart(false);
      if (label === 'step') setConfirmStep(false);
      if (label === 'resume') setConfirmResume(false);
    }
  };

  return (
    <section className="panel run-controls" aria-label="Run controls">
      <h2>Run controls</h2>
      <p className="warning"><strong>Local mutation warning:</strong> start, step, and resume execute workflow nodes on this machine. Non-smoke workflows may run agents, processes, or other side effects.</p>
      {!smokeSafe && <p className="warning strong">Selected workflow/run is not the smoke-demo local-safe workflow. Confirm before mutating.</p>}
      <div className="control-grid">
        <div className="control-card">
          <h3>Start selected workflow</h3>
          <label>Run ID <input value={runId} onChange={(event) => setRunId(event.target.value)} /></label>
          <label>Inputs (key=value, one per line) <textarea value={inputsText} onChange={(event) => setInputsText(event.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={confirmStart} onChange={(event) => setConfirmStart(event.target.checked)} /> I understand this may execute local side effects.</label>
          <button type="button" disabled={!selectedWorkflow || !confirmStart || busy} onClick={() => mutate('start', () => postJson<MutationResult>('/api/runs', { workflow_name: selectedWorkflow, run_id: runId, inputs: parseInputs() }), runId)}>Start run</button>
        </div>
        <div className="control-card">
          <h3>Step selected run</h3>
          <p className="muted">Executes exactly one node when possible; exit code 0 can still leave the run running.</p>
          <label className="check"><input type="checkbox" checked={confirmStep} onChange={(event) => setConfirmStep(event.target.checked)} /> Confirm one local node execution.</label>
          <button type="button" disabled={!selectedRun || !confirmStep || busy} onClick={() => mutate('step', () => postJson<MutationResult>(`/api/runs/${encodeURIComponent(selectedRun || '')}/step`, {}), selectedRun || undefined)}>Step one node</button>
        </div>
        <div className="control-card">
          <h3>Resume selected run</h3>
          <label>Max steps <input type="number" min="1" max="1000" value={maxSteps} onChange={(event) => setMaxSteps(Number(event.target.value))} /></label>
          <label className="check"><input type="checkbox" checked={confirmResume} onChange={(event) => setConfirmResume(event.target.checked)} /> Confirm bounded local execution.</label>
          <button type="button" disabled={!selectedRun || !confirmResume || busy} onClick={() => mutate('resume', () => postJson<MutationResult>(`/api/runs/${encodeURIComponent(selectedRun || '')}/resume`, { max_steps: maxSteps }), selectedRun || undefined)}>Resume run</button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {result && <div className={result.status === 'guarded' ? 'warning' : 'success'}>Mutation {result.operation} {result.status}{result.code ? ` (${result.code})` : ''}<pre>{snippet(result)}</pre></div>}
    </section>
  );
};

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

  const loadRuns = async (): Promise<void> => {
    try {
      const data = await getJson<{ runs: RunSummary[] }>('/api/runs');
      setRuns({ data: data.runs || [], error: null });
    } catch (error) {
      setRuns({ data: [], error: error instanceof Error ? error.message : String(error) });
    }
  };

  useEffect(() => {
    getJson<{ workflows: WorkflowSummary[] }>('/api/workflows')
      .then((data) => setWorkflows({ data: data.workflows || [], error: null }))
      .catch((error: Error) => setWorkflows({ data: [], error: error.message }));
    loadRuns();
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

  const refreshAfterMutation = async (runId?: string): Promise<void> => {
    await loadRuns();
    if (runId) await selectRun(runId);
    else if (selectedRun) await selectRun(selectedRun);
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

        <RunControls selectedWorkflow={selectedWorkflow} selectedRun={selectedRun} runDetail={runDetail} onRefresh={refreshAfterMutation} />

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
