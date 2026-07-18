import { useEffect, useMemo, useState } from 'react';
import { WorkflowPanels } from './components/WorkflowPanels';
import { WorkflowStudio } from './components/WorkflowStudio';
import { RunListTable } from './components/RunListTable';
import { ApprovalPanel } from './components/ApprovalPanel';
import { RunControls } from './components/RunControls';
import { PiSessionsPanel } from './components/PiSessionsPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { FullWidthPage } from './components/PageLayout';
import { ProjectSelector } from './components/ProjectSelector';
import { getJson } from './lib/api';
import { isActiveRun } from './lib/runConsole';
import { ProjectContext, loadProjectId, storeProjectId, projectApiUrl } from './lib/project';
import type { Artifact, EventRecord, LoadState, RunDetail, RunSummary, WorkflowDetail, WorkflowGraphState, WorkflowSummary } from './types/runConsole';
import './style.css';

type ActiveTab = 'workflows' | 'runs' | 'pi-sessions' | 'settings' | 'studio';
type ColorScheme = 'classic' | 'matrix';
type RunSnapshot = { run?: RunDetail; events?: EventRecord[]; artifacts?: Artifact[]; runs?: RunSummary[] };

export const App = () => {
  const [projectId, setProjectIdState] = useState<string>(loadProjectId);
  const setProjectId = (id: string): void => { storeProjectId(id); setProjectIdState(id); };
  const projectContextValue = useMemo(() => ({ projectId, setProjectId }), [projectId]);
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
  const [wizardOpen, setWizardOpen] = useState(false);
  const [studioWorkflowName, setStudioWorkflowName] = useState<string | null>(null);
  const [colorScheme, setColorScheme] = useState<ColorScheme>('classic');

  useEffect(() => {
    document.documentElement.dataset.colorScheme = colorScheme;
  }, [colorScheme]);

  useEffect(() => {
    let cancelled = false;
    setColorScheme('classic');
    getJson<{ settings?: { color_scheme?: unknown } }>(projectApiUrl('/api/settings', projectId))
      .then((data) => {
        if (!cancelled) setColorScheme(data.settings?.color_scheme === 'matrix' ? 'matrix' : 'classic');
      })
      .catch(() => {
        if (!cancelled) setColorScheme('classic');
      });
    return () => { cancelled = true; };
  }, [projectId]);

  const loadRuns = async (): Promise<void> => {
    try {
      const data = await getJson<{ runs: RunSummary[] }>(projectApiUrl('/api/runs', projectId));
      setRuns({ data: data.runs || [], error: null });
    } catch (error) {
      setRuns({ data: [], error: error instanceof Error ? error.message : String(error) });
    }
  };

  // Reload everything when the selected project changes; clear stale selections
  // so a run/workflow from one project never appears in another.
  useEffect(() => {
    setSelectedWorkflow(null); setSelectedNodeId(null); setWorkflowDetail(null);
    setWorkflowError(null); setGraph({ nodes: [], edges: [] });
    setSelectedRun(null); setRunDetail(null); setEvents([]); setArtifacts([]);
    setRunError(null); setLastRunRefresh(null);
    getJson<{ workflows: WorkflowSummary[] }>(projectApiUrl('/api/workflows', projectId))
      .then((data) => setWorkflows({ data: data.workflows || [], error: null }))
      .catch((error: Error) => setWorkflows({ data: [], error: error.message }));
    void loadRuns();
  }, [projectId]);

  const refreshWorkflows = async (): Promise<void> => {
    try {
      const data = await getJson<{ workflows: WorkflowSummary[] }>(projectApiUrl('/api/workflows', projectId));
      setWorkflows({ data: data.workflows || [], error: null });
    } catch (error) {
      setWorkflows({ data: [], error: error instanceof Error ? error.message : String(error) });
    }
  };

  const selectWorkflow = async (name: string): Promise<void> => {
    setSelectedWorkflow(name);
    setSelectedNodeId(null);
    setWorkflowError(null);
    setWorkflowDetail(null);
    setGraph({ nodes: [], edges: [] });
    try {
      const [detail, graphData] = await Promise.all([
        getJson<{ workflow: WorkflowDetail }>(projectApiUrl(`/api/workflows/${encodeURIComponent(name)}`, projectId)),
        getJson<WorkflowGraphState>(projectApiUrl(`/api/workflows/${encodeURIComponent(name)}/graph`, projectId))
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
        getJson<{ run: RunDetail }>(projectApiUrl(`/api/runs/${encodeURIComponent(runId)}`, projectId)),
        getJson<{ events: EventRecord[] }>(projectApiUrl(`/api/runs/${encodeURIComponent(runId)}/events`, projectId)),
        getJson<{ artifacts: Artifact[] }>(projectApiUrl(`/api/runs/${encodeURIComponent(runId)}/artifacts`, projectId))
      ]);
      applyRunSnapshot({ run: detail.run, events: eventData.events || [], artifacts: artifactData.artifacts || [] });
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (!selectedRun || !isActiveRun(runDetail)) return undefined;
    const source = new EventSource(projectApiUrl(`/api/runs/${encodeURIComponent(selectedRun)}/stream`, projectId));
    const onSnapshot = (event: MessageEvent): void => {
      const snapshot = JSON.parse(event.data) as RunSnapshot;
      applyRunSnapshot(snapshot);
      if (snapshot.run && !isActiveRun(snapshot.run)) source.close();
    };
    const onError = (): void => setRunError('Run event stream disconnected; select the run to reconnect.');
    source.addEventListener('snapshot', onSnapshot as EventListener);
    source.addEventListener('error', onError);
    return () => source.close();
  }, [selectedRun, runDetail?.status, projectId]);

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
    'settings': 'Settings',
    studio: 'Workflow Studio'
  };
  const runStatus = runDetail?.status || (selectedRun ? 'loading' : null);
  const streamFreshness = runDetail && isActiveRun(runDetail) ? `Streaming · ${lastRunRefresh || 'pending'}` : 'Stream idle';

  return (
    <ProjectContext.Provider value={projectContextValue}>
    <div className="app-shell" data-color-scheme={colorScheme}>
      <header>
        <div className="header-topline">
          <h1>Tesseraft Console</h1>
          <ProjectSelector />
          <span className="status-pill">{activeSectionLabel[activeTab]}</span>
          {(activeTab === 'workflows' || activeTab === 'runs') && (
            <button type="button" className="header-start-button" onClick={() => setWizardOpen(true)}>Start workflow</button>
          )}
          {activeTab === 'workflows' && (
            <button type="button" className="header-start-button" onClick={() => { setStudioWorkflowName(null); setActiveTab('studio'); }}>Studio</button>
          )}
        </div>
        <div className="context-strip" aria-label="Current console context">
          <span className="context-chip"><strong>Workflow</strong>{selectedWorkflow || 'No workflow selected'}</span>
          <span className="context-chip"><strong>Run</strong>{selectedRun ? `${selectedRun}${runStatus ? ` · ${runStatus}` : ''}` : 'No run selected'}</span>
          <span className="context-chip"><strong>Graph node</strong>{selectedNodeId || 'No node selected'}</span>
          <span className="context-chip"><strong>Project</strong>{projectId}</span>
          <span className="context-chip"><strong>Refresh</strong>{streamFreshness}</span>
        </div>
        <nav className="tabs" aria-label="Run Console sections">
          <button type="button" className={activeTab === 'workflows' ? 'active' : ''} aria-pressed={activeTab === 'workflows'} aria-label="Workflows: inspect workflow graphs" onClick={() => setActiveTab('workflows')}>Workflows <span>inspect</span></button>
          <button type="button" className={activeTab === 'runs' ? 'active' : ''} aria-pressed={activeTab === 'runs'} aria-label="Runs: operate and inspect run status" onClick={() => setActiveTab('runs')}>Runs <span>operate</span></button>
          <button type="button" className={activeTab === 'pi-sessions' ? 'active' : ''} aria-pressed={activeTab === 'pi-sessions'} aria-label="Pi Sessions: chat with Pi sessions" onClick={() => setActiveTab('pi-sessions')}>Pi Sessions <span>chat</span></button>
          <button type="button" className={activeTab === 'settings' ? 'active' : ''} aria-pressed={activeTab === 'settings'} aria-label="Settings: configure Pi defaults, tokens, repo root, and git identity" onClick={() => setActiveTab('settings')}>Settings <span>config</span></button>
          <button type="button" className={activeTab === 'studio' ? 'active' : ''} aria-pressed={activeTab === 'studio'} aria-label="Workflow Studio: author workflows on a canvas" onClick={() => { setActiveTab('studio'); setStudioWorkflowName(studioWorkflowName); }}>Studio <span>author</span></button>
        </nav>
      </header>
      <main>
        {activeTab === 'workflows' && (
          <WorkflowPanels workflows={workflows} selectedWorkflow={selectedWorkflow} workflowDetail={workflowDetail} graph={graph} selectedNodeId={selectedNodeId} workflowError={workflowError} onSelectWorkflow={selectWorkflow} onSelectNode={setSelectedNodeId} onOpenStudio={(name) => { setStudioWorkflowName(name); setActiveTab('studio'); }} onCreateWorkflow={() => { setStudioWorkflowName(null); setActiveTab('studio'); }} />
        )}
        {activeTab === 'runs' && (
          <>
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
            <ApprovalPanel runId={selectedRun} onRefresh={refreshAfterMutation} />
          </>
        )}
        {activeTab === 'pi-sessions' && <PiSessionsPanel />}
        {activeTab === 'settings' && <FullWidthPage><SettingsPanel onColorSchemeChange={setColorScheme} /></FullWidthPage>}
        {activeTab === 'studio' && <WorkflowStudio initialWorkflowName={studioWorkflowName} onExit={() => setActiveTab('workflows')} onWorkflowsChanged={refreshWorkflows} />}
        {activeTab !== 'pi-sessions' && activeTab !== 'settings' && activeTab !== 'studio' && <RunControls workflows={workflows.data} selectedWorkflow={selectedWorkflow} workflowDetail={workflowDetail} selectedRun={selectedRun} runDetail={runDetail} onRefresh={refreshAfterMutation} wizardOpen={wizardOpen} onWizardOpenChange={setWizardOpen} />}
      </main>
    </div>
    </ProjectContext.Provider>
  );
};
