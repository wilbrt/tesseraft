import { useState } from 'react';
import { deleteJson, postJson } from '../lib/api';
import { useProject, projectApiUrl } from '../lib/project';
import { snippet } from '../lib/runConsole';
import { StartWorkflowWizard, type StartPayload } from './StartWorkflowWizard';
import type { MutationResult, RunDetail, WorkflowSummary } from '../types/runConsole';
import { isDeletableLiveness } from '../types/runConsole';

type Props = {
  workflows: WorkflowSummary[];
  selectedWorkflow: string | null;
  workflowDetail: WorkflowDetail | null;
  selectedRun: string | null;
  runDetail: RunDetail | null;
  onRefresh: (runId?: string) => Promise<void>;
  wizardOpen?: boolean;
  onWizardOpenChange?: (open: boolean) => void;
};

export const RunControls = ({ workflows, selectedWorkflow, workflowDetail, selectedRun, runDetail, onRefresh, wizardOpen: wizardOpenProp, onWizardOpenChange }: Props) => {
  const { projectId } = useProject();
  const [wizardOpenInternal, setWizardOpenInternal] = useState(false);
  const wizardOpen = wizardOpenProp ?? wizardOpenInternal;
  const setWizardOpen = (open: boolean): void => { setWizardOpenInternal(open); onWizardOpenChange?.(open); };
  const [runId, setRunId] = useState(`run-${Date.now()}`);
  const [maxSteps, setMaxSteps] = useState(10);
  const [confirmStep, setConfirmStep] = useState(false);
  const [confirmResume, setConfirmResume] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MutationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const smokeSafe = selectedWorkflow === 'smoke-demo' || runDetail?.workflow_name === 'smoke-demo';

  const mutate = async (label: string, action: () => Promise<MutationResult>, refreshRunId?: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const data = await action();
      setResult(data);
      await onRefresh(refreshRunId || data.run_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      if (label === 'step') setConfirmStep(false);
      if (label === 'resume') setConfirmResume(false);
      if (label === 'delete') setConfirmDelete(false);
    }
  };

  const startRun = async (payload: StartPayload): Promise<MutationResult> => {
    setRunId(payload.run_id);
    setMaxSteps(payload.max_steps);
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const data = await postJson<MutationResult>(projectApiUrl('/api/runs', projectId), { workflow_name: payload.workflow_name, run_id: payload.run_id, inputs: payload.inputs, max_steps: payload.max_steps, ...(payload.git_user ? { git_user: payload.git_user } : {}) });
      setResult(data);
      await onRefresh(payload.run_id);
      // Surface non-success outcomes (e.g. a guarded start) to the wizard so it
      // stays open and preserves the user's configured inputs instead of closing.
      if (data.status === 'guarded') {
        const message = (data.cli && typeof data.cli.stderr === 'string' && data.cli.stderr) || `Run start was guarded (${data.code || 'guarded'}).`;
        throw new Error(message);
      }
      return data;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    } finally {
      setBusy(false);
    }
  };

  const selectedRunContext = selectedRun ? `${selectedRun}${runDetail?.status ? ` · ${runDetail.status}` : ''}` : 'No run selected';

  return (
    <section className="panel run-controls" aria-label="Run controls">
      <div className="panel-heading-row">
        <div>
          <h2>Run controls</h2>
          <p className="muted">Start the selected workflow, or operate the selected run.</p>
        </div>
        <div className="context-mini" aria-label="Run control context">
          <span><strong>Workflow</strong>{selectedWorkflow || 'No workflow selected'}</span>
          <span><strong>Run</strong>{selectedRunContext}</span>
        </div>
      </div>
      <p className="warning"><strong>Local mutation warning:</strong> these actions execute workflow nodes on this machine. Non-smoke workflows may run agents, processes, or other side effects.</p>
      {!smokeSafe && <p className="warning strong">Not smoke-demo. Confirm before mutating.</p>}
      <div className="control-grid">
        <div className="control-card start-workflow-card">
          <h3>Start workflow</h3>
          <p className="muted">Open the guided wizard to pick a workflow and fill in the required run info. Start uses the inputs you configure in the wizard, with type-correct fields including a local file/directory picker for path inputs.</p>
          <button type="button" className="primary" disabled={busy} onClick={() => setWizardOpen(true)}>Start workflow</button>
          <small className="muted">Selected workflow: {selectedWorkflow || 'none'}. The wizard lets you change the selection.</small>
        </div>
        <div className="control-card">
          <h3>Delete selected run</h3>
          <p className="muted">Removes the run directory from <code>.agent-runs/</code>. Local and irreversible. Disabled while a run is executing.</p>
          <label className="check"><input type="checkbox" checked={confirmDelete} onChange={(event) => setConfirmDelete(event.target.checked)} /> Confirm permanent deletion of this run's directory.</label>
          <button type="button" disabled={!selectedRun || !isDeletableLiveness(runDetail?.liveness) || !confirmDelete || busy} onClick={() => mutate('delete', () => deleteJson<MutationResult>(projectApiUrl(`/api/runs/${encodeURIComponent(selectedRun || '')}`, projectId)), undefined)}>Delete run</button>
        </div>
        <div className="control-card">
          <h3>Step selected run</h3>
          <p className="muted">Executes exactly one node when possible; exit code 0 can still leave the run running.</p>
          <label className="check"><input type="checkbox" checked={confirmStep} onChange={(event) => setConfirmStep(event.target.checked)} /> Confirm one local node execution.</label>
          <button type="button" disabled={!selectedRun || !confirmStep || busy} onClick={() => mutate('step', () => postJson<MutationResult>(projectApiUrl(`/api/runs/${encodeURIComponent(selectedRun || '')}/step`, projectId), {}), selectedRun || undefined)}>Step one node</button>
        </div>
        <div className="control-card">
          <h3>Resume selected run</h3>
          <label>Max steps <input type="number" min="1" max="1000" value={maxSteps} onChange={(event) => setMaxSteps(Number(event.target.value))} /></label>
          <label className="check"><input type="checkbox" checked={confirmResume} onChange={(event) => setConfirmResume(event.target.checked)} /> Confirm bounded local execution.</label>
          <button type="button" disabled={!selectedRun || !confirmResume || busy} onClick={() => mutate('resume', () => postJson<MutationResult>(projectApiUrl(`/api/runs/${encodeURIComponent(selectedRun || '')}/resume`, projectId), { max_steps: maxSteps }), selectedRun || undefined)}>Resume run</button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {result && <div className={result.status === 'guarded' ? 'warning' : 'success'}>Mutation {result.operation} {result.status}{result.code ? ` (${result.code})` : ''}<pre>{snippet(result)}</pre></div>}
      <StartWorkflowWizard open={wizardOpen} workflows={workflows} initialWorkflow={selectedWorkflow} onClose={() => setWizardOpen(false)} onStart={startRun} />
    </section>
  );
};