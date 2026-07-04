import { useEffect, useState } from 'react';
import { WorkflowPanels } from './components/WorkflowPanels';
import { RunListTable } from './components/RunListTable';
import { RunControls } from './components/RunControls';
import { PiSessionsPanel } from './components/PiSessionsPanel';
import { GitUserPanel } from './components/GitUserPanel';
import { getJson } from './lib/api';
import { isActiveRun } from './lib/runConsole';
import type { Artifact, EventRecord, LoadState, RunDetail, RunSummary, WorkflowDetail, WorkflowGraphState, WorkflowSummary } from './types/runConsole';
import './style.css';

type ActiveTab = 'workflows' | 'runs' | 'pi-sessions' | 'git-user';
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

  const collapseRun = (): void => {
    setSelectedRun(null);
    setRunDetail(null);
    setEvents([]);
    setArtifacts([]);
    setRunError(null);
    setLastRunRefresh(null);
    setSelectedNodeId(null);
  };

  const handleToggleRow = async (runId: string): Promise<void> => {
    if (runId === selectedRun) {
      collapseRun();
    } else {
      setSelectedNodeId(null);
      await selectRun(runId);
    }
  };

  const refreshAfterMutation = async (runId?: string): Promise<void> => {
    await loadRuns();
    if (runId) {
      setActiveTab('runs');
      await selectRun(runId);
    } else if (selectedRun) {
      await selectRun(selectedRun);
    }
  };

  const activeSectionLabel: Record<ActiveTab, string> = {
    workflows: 'Workflows',
    runs: 'Runs',
    'pi-sessions': 'Pi Sessions',
    'git-user': 'Git user'
  };
  const runStatus = runDetail?.status || (selectedRun ? 'loading' : null);
  const streamFreshness = runDetail && isActiveRun(runDetail) ? `Streaming · ${lastRunRefresh || 'pending'}` : 'Stream idle';

  return (
    <>
      <header>
        <div className="header-topline">
          <h1>Tesseraft Console</h1>
          <span className="status-pill">{activeSectionLabel[activeTab]}</span>
        </div>
        <div className="context-strip" aria-label="Current console context">
          <span className="context-chip"><strong>Workflow</strong>{selectedWorkflow || 'No workflow selected'}</span>
          <span className="context-chip"><strong>Run</strong>{selectedRun ? `${selectedRun}${runStatus ? ` · ${runStatus}` : ''}` : 'No run selected'}</span>
          <span className="context-chip"><strong>Graph node</strong>{selectedNodeId || 'No node selected'}</span>
          <span className="context-chip"><strong>Refresh</strong>{streamFreshness}</span>
        </div>
        <nav className="tabs" aria-label="Run Console sections">
          <button type="button" className={activeTab === 'workflows' ? 'active' : ''} aria-pressed={activeTab === 'workflows'} aria-label="Workflows: inspect workflow graphs" onClick={() => setActiveTab('workflows')}>Workflows <span>inspect</span></button>
          <button type="button" className={activeTab === 'runs' ? 'active' : ''} aria-pressed={activeTab === 'runs'} aria-label="Runs: operate and inspect run status" onClick={() => setActiveTab('runs')}>Runs <span>operate</span></button>
          <button type="button" className={activeTab === 'pi-sessions' ? 'active' : ''} aria-pressed={activeTab === 'pi-sessions'} aria-label="Pi Sessions: chat with Pi sessions" onClick={() => setActiveTab('pi-sessions')}>Pi Sessions <span>chat</span></button>
          <button type="button" className={activeTab === 'git-user' ? 'active' : ''} aria-pressed={activeTab === 'git-user'} aria-label="Git user: configure git identity for workflow runs" onClick={() => setActiveTab('git-user')}>Git user <span>config</span></button>
        </nav>
      </header>
      <main>
        {activeTab === 'workflows' && (
          <WorkflowPanels workflows={workflows} selectedWorkflow={selectedWorkflow} workflowDetail={workflowDetail} graph={graph} selectedNodeId={selectedNodeId} workflowError={workflowError} onSelectWorkflow={selectWorkflow} onSelectNode={setSelectedNodeId} />
        )}
        {activeTab === 'runs' && (
          <RunListTable
            runs={runs}
            expandedRunId={selectedRun}
            runDetail={runDetail}
            events={events}
            artifacts={artifacts}
            runError={runError}
            selectedNodeId={selectedNodeId}
            lastRunRefresh={lastRunRefresh}
            onToggleRow={handleToggleRow}
            onSelectNode={setSelectedNodeId}
          />
        )}
        {activeTab === 'pi-sessions' && <PiSessionsPanel />}
        {activeTab === 'git-user' && <GitUserPanel />}
        {activeTab !== 'pi-sessions' && activeTab !== 'git-user' && <RunControls workflows={workflows.data} selectedWorkflow={selectedWorkflow} workflowDetail={workflowDetail} selectedRun={selectedRun} runDetail={runDetail} onRefresh={refreshAfterMutation} />}
      </main>
    </>
  );
};
