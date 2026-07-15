import React, { useEffect, useMemo, useState } from 'react';
import { getJson } from '../lib/api';
import { useProject, projectApiUrl } from '../lib/project';
import { eventName, isActiveRun, nodeForEvent, snippet, stalenessLabel } from '../lib/runConsole';
import { livenessPillClass } from '../lib/runConsole';
import type { Artifact, ArtifactRead, Attempt, EventRecord, RunDetail, RunSummary, WorkflowGraphState } from '../types/runConsole';
import type { GraphNode } from '../lib/graphLayout';
import { WorkflowGraph } from './WorkflowGraph';
import { AttemptTimeline, FailureSummary } from './RunPanels';
import { ArtifactBrowser } from './ArtifactBrowser';
import { FieldList } from './FieldList';

/** Inline per-node artifact viewer rendered inside the node modal. Keeps its
 * own selection state (one preview open at a time) and reuses the existing
 * `GET /api/runs/:runId/artifact?path=...` route + `ArtifactRead` preview,
 * mirroring `ArtifactBrowser` without coupling to its state.
 * `artifacts` is the per-node filtered list; if the selected path disappears
 * (e.g. during streaming), the preview auto-clears to avoid stale views. */
const NodeArtifactViewer = ({ runId, artifacts }: { runId: string; artifacts: Artifact[] }) => {
  const { projectId } = useProject();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ArtifactRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Auto-clear when the selected artifact is no longer present for this node.
  useEffect(() => {
    if (selectedPath && !artifacts.some((a) => a.path === selectedPath)) {
      setSelectedPath(null);
      setPreview(null);
      setError(null);
      setLoading(false);
    }
  }, [selectedPath, artifacts]);

  const selectArtifact = async (artifact: Artifact): Promise<void> => {
    if (selectedPath === artifact.path) return; // keep open; no refetch
    setSelectedPath(artifact.path);
    setPreview(null);
    setError(null);
    setLoading(true);
    try {
      const data = await getJson<ArtifactRead>(projectApiUrl(`/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(artifact.path)}`, projectId));
      setPreview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <ul className="item-list compact">
        {artifacts.map((artifact) => (
          <li key={`${artifact.source || 'artifact'}-${artifact.path}`} className={selectedPath === artifact.path ? 'selected-row' : ''}>
            <button type="button" onClick={() => selectArtifact(artifact)}>
              {artifact.path}
            </button>
            <span>{artifact.content_type || '—'} · {artifact.exists ? `${artifact.size ?? 0} bytes` : 'missing'}</span>
          </li>
        ))}
      </ul>
      {loading && <p className="muted">Loading artifact…</p>}
      {error && <div className="error">{error}</div>}
      {preview && (
        <div className="node-artifact-preview">
          <FieldList fields={[
            ['Path', preview.artifact.path],
            ['Type', preview.artifact.content_type],
            ['Size', preview.artifact.size],
            ['Preview', preview.previewable ? 'yes' : preview.reason || 'no']
          ]} />
          {preview.previewable && <pre className="node-attempt-result">{preview.content}</pre>}
        </div>
      )}
    </>
  );
};

type Props = {
  runSummary: RunSummary;
  runDetail: RunDetail | null;
  events: EventRecord[];
  artifacts: Artifact[];
  runError: string | null;
  selectedNodeId: string | null;
  lastRunRefresh: string | null;
  onSelectNode: (nodeId: string | null) => void;
};

// Module-level cache of workflow graphs keyed by workflow name, so runs of the
// same workflow reuse the graph (avoids re-fetching on every expand).
const graphCache = new Map<string, WorkflowGraphState>();

const useWorkflowGraph = (workflowName: string | null | undefined): { graph: WorkflowGraphState; error: string | null } => {
  const { projectId } = useProject();
  const cacheKey = workflowName ? `${projectId}:${workflowName}` : null;
  const [graph, setGraph] = useState<WorkflowGraphState>(() => (cacheKey ? graphCache.get(cacheKey) : undefined) || { nodes: [], edges: [] });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workflowName || !cacheKey) return;
    const cached = graphCache.get(cacheKey);
    if (cached) { setGraph(cached); setError(null); return; }
    let cancelled = false;
    setGraph({ nodes: [], edges: [] });
    setError(null);
    getJson<WorkflowGraphState>(projectApiUrl(`/api/workflows/${encodeURIComponent(workflowName)}/graph`, projectId))
      .then((data) => {
        const normalized = { nodes: data.nodes || [], edges: data.edges || [] };
        graphCache.set(cacheKey, normalized);
        if (!cancelled) { setGraph(normalized); setError(null); }
      })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [workflowName, cacheKey, projectId]);

  return { graph, error };
};

/** Latest attempt for a node id, if any. */
const latestAttemptForNode = (attempts: Attempt[], nodeId: string): Attempt | null => {
  let latest: Attempt | null = null;
  for (const attempt of attempts) {
    if ((attempt.node_id || attempt.state) === nodeId) {
      if (!latest || (attempt.attempt ?? 0) >= (latest.attempt ?? 0)) latest = attempt;
    }
  }
  return latest;
};

export const RunInspection = ({ runSummary, runDetail, events, artifacts, runError, selectedNodeId, lastRunRefresh, onSelectNode }: Props) => {
  const workflowName = runDetail?.workflow_name || runSummary.workflow_name || null;
  const { graph, error: graphError } = useWorkflowGraph(workflowName);
  const activeNodeId = (runDetail?.state || runSummary.state || null) ?? null;
  const activeOnGraph = activeNodeId ? graph.nodes.some((node) => node.id === activeNodeId) : false;

  const visibleEvents = selectedNodeId ? events.filter((event) => nodeForEvent(event) === selectedNodeId || !nodeForEvent(event)) : events;

  const renderNodeDetail = React.useCallback((node: GraphNode): React.ReactNode => {
    const attempt = runDetail ? latestAttemptForNode(runDetail.attempts || [], node.id) : null;
    const nodeEvents = events.filter((event) => nodeForEvent(event) === node.id);
    const nodeArtifacts = artifacts.filter((artifact) => artifact.node_id === node.id);
    return (
      <>
        <dl>
          <div className="field-row"><dt>ID</dt><dd>{node.id}</dd></div>
          <div className="field-row"><dt>Type</dt><dd>{String(node.type || '')}</dd></div>
          <div className="field-row"><dt>Title</dt><dd>{String(node.title || '')}</dd></div>
          <div className="field-row"><dt>Run state</dt><dd>{activeNodeId === node.id ? 'current (active)' : '—'}</dd></div>
        </dl>
        {attempt ? (
          <>
            <h3>Latest attempt</h3>
            <FieldList fields={[
              ['Attempt', attempt.attempt ?? '—'],
              ['Status', attempt.status || '—'],
              ['Started', attempt.started_at || '—'],
              ['Finished', attempt.finished_at || 'running'],
              ['Next', attempt.next_state || '—'],
              ['Error', attempt.error || '—']
            ]} />
            {attempt.result != null && <pre className="node-attempt-result">{snippet(attempt.result)}</pre>}
          </>
        ) : (
          <p className="muted">No attempts derived for this node.</p>
        )}
        {nodeArtifacts.length > 0 && (
          <>
            <h3>Related artifacts</h3>
            <NodeArtifactViewer runId={runSummary.run_id} artifacts={nodeArtifacts} />
          </>
        )}
        {nodeEvents.length > 0 && (
          <>
            <h3>Related events</h3>
            <ol className="event-list compact">
              {nodeEvents.map((event, index) => (
                <li key={`${eventName(event)}-${index}`}><code>{eventName(event)}</code></li>
              ))}
            </ol>
          </>
        )}
        <details>
          <summary>Structured node JSON</summary>
          <pre>{JSON.stringify(node, null, 2)}</pre>
        </details>
      </>
    );
  }, [runDetail, events, artifacts, activeNodeId]);

  return (
    <section className="run-inspection" aria-label={`Run inspection ${runSummary.run_id}`}>
      <div className="run-inspection-header">
        <div>
          <strong>{runSummary.run_id}</strong> · {workflowName || '—'} ·
          <span className={`status-pill ${livenessPillClass(runDetail || runSummary)}`}>{runDetail?.liveness || runSummary.liveness || runDetail?.status || runSummary.status || 'unknown'}</span>
          {stalenessLabel(runDetail?.staleness_seconds ?? runSummary.staleness_seconds) ? <span className={`status-pill ${runDetail?.liveness || runSummary.liveness || 'stale'}`}>{stalenessLabel(runDetail?.staleness_seconds ?? runSummary.staleness_seconds)}</span> : null}
        </div>
        <div className="muted">
          {isActiveRun(runDetail)
            ? `Streaming · ${lastRunRefresh || 'pending'}`
            : runDetail
              ? `Idle · last refresh ${lastRunRefresh || '—'}`
              : runError || 'Loading run…'}
        </div>
      </div>

      {runError && <div className="error">{runError}</div>}
      {graphError && <div className="error">Graph load failed: {graphError}</div>}

      {runDetail && (
        <FieldList fields={[
          ['Run ID', runDetail.run_id],
          ['Workflow', runDetail.workflow_name],
          ['Status', runDetail.status],
          ['Liveness', runDetail.liveness || 'unknown'],
          ['Last update', stalenessLabel(runDetail.staleness_seconds) || runDetail.updated_at || 'unknown'],
          ['State', runDetail.state],
          ['Round / attempt', `${runDetail.round ?? ''} / ${runDetail.attempt ?? ''}`],
          ['Path', runDetail.path],
          ['Event filter', selectedNodeId ? `Graph node: ${selectedNodeId}` : 'All events'],
          ['Auto-refresh', isActiveRun(runDetail) ? `Active, last refresh ${lastRunRefresh || 'pending'}` : 'Inactive']
        ]} />
      )}

      <FailureSummary run={runDetail} />

      <div className="run-inspection-graph">
        <WorkflowGraph
          nodes={graph.nodes}
          edges={graph.edges}
          selectedNodeId={selectedNodeId}
          activeNodeId={activeOnGraph ? activeNodeId : null}
          onSelectNode={(node) => onSelectNode(node.id)}
          renderNodeDetail={renderNodeDetail}
          sectionLabel="Run graph"
        />
        {!activeOnGraph && activeNodeId ? (
          <p className="muted">Current: {activeNodeId} (not on graph)</p>
        ) : null}
      </div>

      <details className="run-detail-more">
        <summary>Show attempts, artifacts, and events</summary>
        {runDetail && <AttemptTimeline attempts={runDetail.attempts || []} selectedNodeId={selectedNodeId} />}
        <ArtifactBrowser runId={runSummary.run_id} artifacts={artifacts} selectedNodeId={selectedNodeId} />

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
      </details>
    </section>
  );
};