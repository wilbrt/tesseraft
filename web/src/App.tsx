import { useEffect, useState } from 'react';
import { WorkflowPanels } from './components/WorkflowPanels';
import { RunsPanel } from './components/RunPanels';
import { RunControls } from './components/RunControls';
import { PiSessionsPanel } from './components/PiSessionsPanel';
import { getJson } from './lib/api';
import { isActiveRun } from './lib/runConsole';
import type { Artifact, EventRecord, LoadState, RunDetail, RunSummary, WorkflowDetail, WorkflowGraphState, WorkflowSummary } from './types/runConsole';
import './style.css';

type ActiveTab = 'workflows' | 'runs' | 'pi-sessions';
type RunSnapshot = { run?: RunDetail; events?: EventRecord[]; artifacts?: Artifact[]; runs?: RunSummary[] };

export const App = () => {
  const [activeTab, setActiveTab] = useState<ActiveTab>('workflows');
  const [workflows, setWorkflows] = useState<LoadState<WorkflowSummary[]>>({ data: [], error: null });
  const [runs, setRuns] = useState<LoadState<RunSummary[]>>({ data: [], error: null });
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
  const [workflowDetail, setWorkflowDetail] = useState<WorkflowDetail | null>(null);
  const [graph, setGraph] = useState<WorkflowGraphState>({ nodes: [], edges: [] });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [lastRunRefresh, setLastRunRefresh] = useState<string | null>(null);

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
    void loadRuns();
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
        getJson<WorkflowGraphState>(`/api/workflows/${encodeURIComponent(name)}/graph`)
      ]);
      setWorkflowDetail(detail.workflow);
      setGraph({ nodes: graphData.nodes || [], edges: graphData.edges || [] });
    } catch (error) {
      setWorkflowError(error instanceof Error ? error.message : String(error));
    }
  };

  const applyRunSnapshot = (snapshot: RunSnapshot): void => {
    if (snapshot.run) setRunDetail(snapshot.run);
    if (snapshot.events) setEvents(snapshot.events);
    if (snapshot.artifacts) setArtifacts(snapshot.artifacts);
    if (snapshot.runs) setRuns({ data: snapshot.runs, error: null });
    setLastRunRefresh(new Date().toLocaleTimeString());
  };

  const selectRun = async (runId: string): Promise<void> => {
    setSelectedRun(runId);
    setRunError(null);
    setRunDetail(null);
    setEvents([]);
    setArtifacts([]);
    setLastRunRefresh(null);
    try {
      const [detail, eventData, artifactData] = await Promise.all([
        getJson<{ run: RunDetail }>(`/api/runs/${encodeURIComponent(runId)}`),
        getJson<{ events: EventRecord[] }>(`/api/runs/${encodeURIComponent(runId)}/events`),
        getJson<{ artifacts: Artifact[] }>(`/api/runs/${encodeURIComponent(runId)}/artifacts`)
      ]);
      applyRunSnapshot({ run: detail.run, events: eventData.events || [], artifacts: artifactData.artifacts || [] });
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (!selectedRun || !isActiveRun(runDetail)) return undefined;
    const source = new EventSource(`/api/runs/${encodeURIComponent(selectedRun)}/stream`);
    const onSnapshot = (event: MessageEvent): void => {
      const snapshot = JSON.parse(event.data) as RunSnapshot;
      applyRunSnapshot(snapshot);
      if (snapshot.run && !isActiveRun(snapshot.run)) source.close();
    };
    const onError = (): void => setRunError('Run event stream disconnected; select the run to reconnect.');
    source.addEventListener('snapshot', onSnapshot as EventListener);
    source.addEventListener('error', onError);
    return () => source.close();
  }, [selectedRun, runDetail?.status]);

  const refreshAfterMutation = async (runId?: string): Promise<void> => {
    await loadRuns();
    if (runId) {
      setActiveTab('runs');
      await selectRun(runId);
    } else if (selectedRun) {
      await selectRun(selectedRun);
    }
  };

  return (
    <>
      <header>
        <h1>Tesseraft Local Web UI</h1>
        <p>Local inspection and controlled execution for workflows, visual graphs, runs, attempts, artifacts, and events. Active runs stream updates.</p>
        <nav className="tabs" aria-label="Run Console sections">
          <button type="button" className={activeTab === 'workflows' ? 'active' : ''} aria-pressed={activeTab === 'workflows'} onClick={() => setActiveTab('workflows')}>Workflows</button>
          <button type="button" className={activeTab === 'runs' ? 'active' : ''} aria-pressed={activeTab === 'runs'} onClick={() => setActiveTab('runs')}>Runs</button>
          <button type="button" className={activeTab === 'pi-sessions' ? 'active' : ''} aria-pressed={activeTab === 'pi-sessions'} onClick={() => setActiveTab('pi-sessions')}>Pi Sessions</button>
        </nav>
      </header>
      <main>
        {activeTab === 'workflows' && (
          <WorkflowPanels workflows={workflows} selectedWorkflow={selectedWorkflow} workflowDetail={workflowDetail} graph={graph} selectedNodeId={selectedNodeId} workflowError={workflowError} onSelectWorkflow={selectWorkflow} onSelectNode={setSelectedNodeId} />
        )}
        {activeTab === 'runs' && (
          <RunsPanel runs={runs} selectedRun={selectedRun} runDetail={runDetail} events={events} artifacts={artifacts} runError={runError} selectedNodeId={selectedNodeId} lastRunRefresh={lastRunRefresh} onSelectRun={selectRun} />
        )}
        {activeTab === 'pi-sessions' && <PiSessionsPanel />}
        {activeTab !== 'pi-sessions' && <RunControls selectedWorkflow={selectedWorkflow} workflowDetail={workflowDetail} selectedRun={selectedRun} runDetail={runDetail} onRefresh={refreshAfterMutation} />}
      </main>
    </>
  );
};
