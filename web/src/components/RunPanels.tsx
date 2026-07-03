import type { Attempt, RunDetail } from '../types/runConsole';
import { snippet } from '../lib/runConsole';

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
