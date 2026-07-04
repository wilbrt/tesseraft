import React, { useEffect, useMemo, useState } from 'react';
import { getJson } from '../lib/api';
import { eventName, isActiveRun, nodeForEvent, snippet, stalenessLabel } from '../lib/runConsole';
import { livenessPillClass } from '../lib/runConsole';
import type { Artifact, Attempt, EventRecord, RunDetail, RunSummary, WorkflowGraphState } from '../types/runConsole';
import type { GraphNode } from '../lib/graphLayout';
import { WorkflowGraph } from './WorkflowGraph';
import { AttemptTimeline, FailureSummary } from './RunPanels';
import { ArtifactBrowser } from './ArtifactBrowser';
import { FieldList } from './FieldList';

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
  const [graph, setGraph] = useState<WorkflowGraphState>(() => (workflowName ? graphCache.get(workflowName) : undefined) || { nodes: [], edges: [] });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workflowName) return;
    const cached = graphCache.get(workflowName);
    if (cached) { setGraph(cached); setError(null); return; }
    let cancelled = false;
    setGraph({ nodes: [], edges: [] });
    setError(null);
    getJson<WorkflowGraphState>(`/api/workflows/${encodeURIComponent(workflowName)}/graph`)
      .then((data) => {
        const normalized = { nodes: data.nodes || [], edges: data.edges || [] };
        graphCache.set(workflowName, normalized);
        if (!cancelled) { setGraph(normalized); setError(null); }
      })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [workflowName]);

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
            <ul className="item-list compact">
              {nodeArtifacts.map((artifact) => <li key={`${artifact.source || 'artifact'}-${artifact.path}`}>{artifact.path} · {artifact.content_type || '—'} · {artifact.exists ? `${artifact.size ?? 0} bytes` : 'missing'}</li>)}
            </ul>
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
    </section>
  );
};