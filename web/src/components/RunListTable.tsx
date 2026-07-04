import React, { useMemo, useState } from 'react';
import type { Artifact, EventRecord, RunDetail, RunSummary } from '../types/runConsole';
import { isDeletableLiveness } from '../types/runConsole';
import { isFinishedRun, isTerminalLiveness, livenessPillClass, runDurationLabel, stalenessLabel } from '../lib/runConsole';
import { RunInspection } from './RunInspection';

type Props = {
  runs: { data: RunSummary[]; error: string | null };
  expandedRunId: string | null;
  runDetail: RunDetail | null;
  events: EventRecord[];
  artifacts: Artifact[];
  runError: string | null;
  selectedNodeId: string | null;
  lastRunRefresh: string | null;
  onToggleRow: (runId: string) => void;
  onSelectNode: (nodeId: string | null) => void;
};

const matchesSearch = (run: RunSummary, query: string): boolean => {
  if (!query) return true;
  const haystack = [run.run_id, run.workflow_name, run.state, run.status, run.liveness]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
};

export const RunListTable = ({ runs, expandedRunId, runDetail, events, artifacts, runError, selectedNodeId, lastRunRefresh, onToggleRow, onSelectNode }: Props) => {
  const [query, setQuery] = useState('');
  const [showFinished, setShowFinished] = useState(false);
  const [onlyDeletable, setOnlyDeletable] = useState(false);

  const visibleRuns = useMemo(() => {
    let list = runs.data;
    if (!showFinished) list = list.filter((run) => !isFinishedRun(run));
    if (onlyDeletable) list = list.filter((run) => isDeletableLiveness(run.liveness));
    const filtered = list.filter((run) => matchesSearch(run, query));
    // Keep expanded row visible even if it falls outside the search/filter, so an
    // expanded run is not hidden unexpectedly while the user inspects it.
    if (expandedRunId && !filtered.some((run) => run.run_id === expandedRunId)) {
      const expanded = list.find((run) => run.run_id === expandedRunId);
      if (expanded) return [expanded, ...filtered];
    }
    return filtered;
  }, [runs.data, showFinished, onlyDeletable, query, expandedRunId]);

  return (
    <section className="panel run-list-table" aria-label="Runs">
      <div className="run-list-toolbar">
        <h2>Runs</h2>
        <input
          type="search"
          className="run-list-search"
          placeholder="Search runs, workflow, state…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search runs"
        />
        <label className="check"><input type="checkbox" checked={showFinished} onChange={(event) => setShowFinished(event.target.checked)} /> Show finished runs</label>
        <label className="check"><input type="checkbox" checked={onlyDeletable} onChange={(event) => setOnlyDeletable(event.target.checked)} /> Show only deletable runs (done/failed/stale/orphaned/parked)</label>
      </div>
      {runs.error && <div className="error">{runs.error}</div>}
      <table className="runs-table">
        <colgroup>
          <col style={{ width: '28%' }} />
          <col style={{ width: '22%' }} />
          <col style={{ width: '14%' }} />
          <col style={{ width: '14%' }} />
          <col style={{ width: '22%' }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Run</th>
            <th scope="col">Workflow</th>
            <th scope="col">State</th>
            <th scope="col">Running for</th>
            <th scope="col">Status / liveness</th>
          </tr>
        </thead>
        <tbody>
          {visibleRuns.length === 0 && (
            <tr><td colSpan={5} className="muted">No runs found. Run a workflow locally to populate this list.</td></tr>
          )}
          {visibleRuns.map((run) => {
            const expanded = run.run_id === expandedRunId;
            const liveness = run.liveness;
            const staleBadge = liveness != null && !isTerminalLiveness(liveness) && liveness !== 'executing';
            return (
              <React.Fragment key={run.run_id}>
                <tr
                  className={expanded ? 'runs-table-row selected-row expanded' : 'runs-table-row'}
                  aria-current={expanded ? 'true' : undefined}
                  onClick={() => onToggleRow(run.run_id)}
                  onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onToggleRow(run.run_id); } }}
                  tabIndex={0}
                  aria-expanded={expanded}
                  aria-controls={expanded ? `run-inspection-${run.run_id}` : undefined}
                >
                  <td><code>{run.run_id}</code></td>
                  <td>{run.workflow_name || '—'}</td>
                  <td>{run.state || run.status || '—'}</td>
                  <td>{runDurationLabel(run)}</td>
                  <td>
                    <span className={`status-pill ${livenessPillClass(run)}`}>{liveness || run.status || 'unknown'}</span>
                    {staleBadge && stalenessLabel(run.staleness_seconds) ? <span className={`status-pill ${liveness}`}>{stalenessLabel(run.staleness_seconds)}</span> : null}
                  </td>
                </tr>
                {expanded && (
                  <tr className="runs-table-inspection-row">
                    <td colSpan={5}>
                      <div id={`run-inspection-${run.run_id}`} aria-live="polite">
                        <RunInspection
                          runSummary={run}
                          runDetail={run.run_id === expandedRunId ? runDetail : null}
                          events={run.run_id === expandedRunId ? events : []}
                          artifacts={run.run_id === expandedRunId ? artifacts : []}
                          runError={run.run_id === expandedRunId ? runError : null}
                          selectedNodeId={selectedNodeId}
                          lastRunRefresh={lastRunRefresh}
                          onSelectNode={onSelectNode}
                        />
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </section>
  );
};