import { useEffect, useState } from 'react';
import { WorkflowGraph } from './components/WorkflowGraph';
import type { GraphEdge, GraphNode } from './lib/graphLayout';
import './style.css';

type WorkflowSummary = { name: string; path?: string };
type WorkflowDetail = { name: string; path?: string; api_version?: string; lint?: { ok?: boolean } };
type RunSummary = { run_id: string; workflow_name?: string; status?: string };
type RunDetail = RunSummary & { state?: string; round?: number; attempt?: number; path?: string };
type EventRecord = { event?: string; type?: string; [key: string]: unknown };

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

export const App = () => {
  const [workflows, setWorkflows] = useState<LoadState<WorkflowSummary[]>>({ data: [], error: null });
  const [runs, setRuns] = useState<LoadState<RunSummary[]>>({ data: [], error: null });
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
  const [workflowDetail, setWorkflowDetail] = useState<WorkflowDetail | null>(null);
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] }>({ nodes: [], edges: [] });
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<EventRecord[]>([]);
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
    try {
      const [detail, eventData] = await Promise.all([
        getJson<{ run: RunDetail }>(`/api/runs/${encodeURIComponent(runId)}`),
        getJson<{ events: EventRecord[] }>(`/api/runs/${encodeURIComponent(runId)}/events`)
      ]);
      setRunDetail(detail.run);
      setEvents(eventData.events || []);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <>
      <header>
        <h1>Tesseraft Local Web UI</h1>
        <p>Read-only local inspection of workflows, visual graphs, runs, and events.</p>
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
              ['Lint', workflowDetail.lint?.ok ? 'ok' : 'has issues']
            ]} />
          )}
          <WorkflowGraph nodes={graph.nodes} edges={graph.edges} />
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
              ['Path', runDetail.path]
            ]} />
          )}
          <h3>Events</h3>
          <ol className="event-list">
            {events.length === 0 && <li className="muted">No events found.</li>}
            {events.map((event, index) => (
              <li key={`${event.event || event.type || 'event'}-${index}`}>
                <code>{event.event || event.type || 'event'}</code>
                <pre>{JSON.stringify(event, null, 2)}</pre>
              </li>
            ))}
          </ol>
        </section>
      </main>
    </>
  );
};
