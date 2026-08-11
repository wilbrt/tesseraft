import { useCallback, useEffect, useState } from 'react';
import { getJson } from '../../lib/api';
import { projectApiUrl } from '../../lib/project';
import { isActiveRun } from '../../lib/runConsole';
import type {
  Artifact,
  EventRecord,
  LoadState,
  RunDetail,
  RunSummary,
  WorkflowDetail,
  WorkflowGraphState,
  WorkflowSummary
} from '../../types/runConsole';

type RunSnapshot = { run?: RunDetail; events?: EventRecord[]; artifacts?: Artifact[]; runs?: RunSummary[] };

export const useConsoleData = (projectId: string, openRuns: () => void) => {
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

  const loadRuns = useCallback(async (): Promise<void> => {
    try {
      const data = await getJson<{ runs: RunSummary[] }>(projectApiUrl('/api/runs', projectId));
      setRuns({ data: data.runs || [], error: null });
    } catch (error) {
      setRuns({ data: [], error: error instanceof Error ? error.message : String(error) });
    }
  }, [projectId]);

  const refreshWorkflows = useCallback(async (): Promise<void> => {
    try {
      const data = await getJson<{ workflows: WorkflowSummary[] }>(projectApiUrl('/api/workflows', projectId));
      setWorkflows({ data: data.workflows || [], error: null });
    } catch (error) {
      setWorkflows({ data: [], error: error instanceof Error ? error.message : String(error) });
    }
  }, [projectId]);

  useEffect(() => {
    setSelectedWorkflow(null); setSelectedNodeId(null); setWorkflowDetail(null);
    setWorkflowError(null); setGraph({ nodes: [], edges: [] });
    setSelectedRun(null); setRunDetail(null); setEvents([]); setArtifacts([]);
    setRunError(null); setLastRunRefresh(null);
    void refreshWorkflows();
    void loadRuns();
  }, [loadRuns, refreshWorkflows]);

  const selectWorkflow = useCallback(async (name: string): Promise<void> => {
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
  }, [projectId]);

  const applyRunSnapshot = useCallback((snapshot: RunSnapshot): void => {
    if (snapshot.run) setRunDetail(snapshot.run);
    if (snapshot.events) setEvents(snapshot.events);
    if (snapshot.artifacts) setArtifacts(snapshot.artifacts);
    if (snapshot.runs) setRuns({ data: snapshot.runs, error: null });
    if (snapshot.run) {
      const snapshotRun = snapshot.run;
      setRuns((current) => {
        const list = snapshot.runs || current.data;
        const index = list.findIndex((run) => run.run_id === snapshotRun.run_id);
        if (index === -1) return current;
        const next = [...list];
        next[index] = { ...next[index], ...snapshotRun };
        return { data: next, error: null };
      });
    }
    setLastRunRefresh(new Date().toLocaleTimeString());
  }, []);

  const selectRun = useCallback(async (runId: string): Promise<void> => {
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
  }, [applyRunSnapshot, projectId]);

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
  }, [applyRunSnapshot, projectId, runDetail, selectedRun]);

  const collapseRun = useCallback((): void => {
    setSelectedRun(null); setRunDetail(null); setEvents([]); setArtifacts([]);
    setRunError(null); setLastRunRefresh(null); setSelectedNodeId(null);
  }, []);

  const handleToggleRow = useCallback(async (runId: string): Promise<void> => {
    if (runId === selectedRun) collapseRun();
    else { setSelectedNodeId(null); await selectRun(runId); }
  }, [collapseRun, selectRun, selectedRun]);

  const refreshAfterMutation = useCallback(async (runId?: string | null): Promise<void> => {
    await loadRuns();
    if (runId === null) { openRuns(); collapseRun(); }
    else if (runId) { openRuns(); await selectRun(runId); }
    else if (selectedRun) await selectRun(selectedRun);
  }, [collapseRun, loadRuns, openRuns, selectRun, selectedRun]);

  return {
    workflows, runs, selectedWorkflow, workflowDetail, graph, selectedNodeId,
    workflowError, selectedRun, runDetail, events, artifacts, runError,
    lastRunRefresh, setSelectedNodeId, selectWorkflow, selectRun,
    refreshWorkflows, refreshAfterMutation, handleToggleRow
  };
};
