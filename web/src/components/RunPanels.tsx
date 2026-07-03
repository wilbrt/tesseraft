import { useState } from 'react';
import type { Attempt, EventRecord, RunDetail, RunSummary } from '../types/runConsole';
import { isDeletableLiveness } from '../types/runConsole';
import { eventName, isActiveRun, isTerminalLiveness, livenessPillClass, nodeForEvent, snippet, stalenessLabel } from '../lib/runConsole';
import { ArtifactBrowser } from './ArtifactBrowser';
import { FieldList } from './FieldList';

export const FailureSummary = ({ run }: { run: RunDetail | null }) => {
  const failures = run?.failures || [];
  const statusFailed = ['failed', 'error'].includes(run?.status || '');
  const liveness = run?.liveness;
  const livenesstaleOrphan = liveness === 'orphaned' || liveness === 'stale';
  if (!run || (failures.length === 0 && !statusFailed && !livenesstaleOrphan)) return null;
  return (
    <div className={`failure-summary ${livenesstaleOrphan ? 'warning strong' : ''}`} aria-label="Run failure summary">
      <strong>Issues to inspect</strong>
      <ul>
        {statusFailed && <li>Run status: {run.status}</li>}
        {liveness === 'orphaned' && <li>Run node appears orphaned: started without finishing and no live progress.</li>}
        {liveness === 'stale' && <li>Run appears stale: marked running but no recent activity.</li>}
        {failures.map((failure, index) => <li key={`${failure.source || 'failure'}-${index}`}>{failure.message || failure.path || failure.node_id}</li>)}
      </ul>
    </div>
  );
};

export const AttemptTimeline = ({ attempts, selectedNodeId }: { attempts: Attempt[]; selectedNodeId: string | null }) => (
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

export const RunsPanel = ({ runs, selectedRun, runDetail, events, artifacts, runError, selectedNodeId, lastRunRefresh, onSelectRun }: {
  runs: { data: RunSummary[]; error: string | null };
  selectedRun: string | null;
  runDetail: RunDetail | null;
  events: EventRecord[];
  artifacts: Parameters<typeof ArtifactBrowser>[0]['artifacts'];
  runError: string | null;
  selectedNodeId: string | null;
  lastRunRefresh: string | null;
  onSelectRun: (runId: string) => Promise<void>;
}) => {
  const [onlyDeletable, setOnlyDeletable] = useState(false);
  const visibleEvents = selectedNodeId ? events.filter((event) => nodeForEvent(event) === selectedNodeId || !nodeForEvent(event)) : events;
  const visibleRuns = onlyDeletable ? runs.data.filter((run) => isDeletableLiveness(run.liveness)) : runs.data;
  return (
    <>
      <section className="panel">
        <h2>Runs</h2>
        {runs.error && <div className="error">{runs.error}</div>}
        <label className="check"><input type="checkbox" checked={onlyDeletable} onChange={(event) => setOnlyDeletable(event.target.checked)} /> Show only deletable runs (done/failed/stale/orphaned/parked)</label>
        <ul className="item-list">
          {runs.data.length === 0 && <li className="muted">No runs found. Run a workflow locally to populate this list.</li>}
          {visibleRuns.map((run) => {
            const selected = run.run_id === selectedRun;
            const liveness = run.liveness;
            const staleBadge = liveness != null && !isTerminalLiveness(liveness) && liveness !== 'executing';
            return (
              <li key={run.run_id} className={selected ? 'selected-row' : undefined} aria-current={selected ? 'true' : undefined}>
                <button type="button" onClick={() => onSelectRun(run.run_id)}>{run.run_id}</button>
                <span>{run.workflow_name} — <span className={`status-pill ${livenessPillClass(run)}`}>{liveness || run.status || 'unknown'}</span>{staleBadge && stalenessLabel(run.staleness_seconds) ? <span className={`status-pill ${liveness}`}>{stalenessLabel(run.staleness_seconds)}</span> : null}</span>
              </li>
            );
          })}
        </ul>
      </section>
      <section className="panel detail">
        <h2>Run detail</h2>
        {runError && <div className="error">{runError}</div>}
        {!runDetail && !runError && <div className="empty">{selectedRun ? 'Loading run...' : 'Select a run.'}</div>}
        {runDetail && <FieldList fields={[["Run ID", runDetail.run_id], ["Workflow", runDetail.workflow_name], ["Status", runDetail.status], ["Liveness", runDetail.liveness || 'unknown'], ["Last update", stalenessLabel(runDetail.staleness_seconds) || runDetail.updated_at || 'unknown'], ["State", runDetail.state], ["Round / attempt", `${runDetail.round ?? ''} / ${runDetail.attempt ?? ''}`], ["Path", runDetail.path], ["Event filter", selectedNodeId ? `Graph node: ${selectedNodeId}` : 'All events'], ["Auto-refresh", isActiveRun(runDetail) ? `Active, last refresh ${lastRunRefresh || 'pending'}` : 'Inactive']]} />}
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
    </>
  );
};
