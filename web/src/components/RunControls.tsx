import { useState } from 'react';
import { postJson } from '../lib/api';
import { snippet } from '../lib/runConsole';
import type { MutationResult, RunDetail } from '../types/runConsole';

type Props = {
  selectedWorkflow: string | null;
  selectedRun: string | null;
  runDetail: RunDetail | null;
  onRefresh: (runId?: string) => Promise<void>;
};

export const RunControls = ({ selectedWorkflow, selectedRun, runDetail, onRefresh }: Props) => {
  const [runId, setRunId] = useState(`run-${Date.now()}`);
  const [inputsText, setInputsText] = useState('');
  const [maxSteps, setMaxSteps] = useState(10);
  const [confirmStart, setConfirmStart] = useState(false);
  const [confirmStep, setConfirmStep] = useState(false);
  const [confirmResume, setConfirmResume] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MutationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const smokeSafe = selectedWorkflow === 'smoke-demo' || runDetail?.workflow_name === 'smoke-demo';

  const parseInputs = (): Record<string, string> => {
    const inputs: Record<string, string> = {};
    for (const line of inputsText.split('\n').map((item) => item.trim()).filter(Boolean)) {
      const [key, ...rest] = line.split('=');
      if (!key || rest.length === 0) throw new Error(`Invalid input "${line}"; use key=value`);
      inputs[key] = rest.join('=');
    }
    return inputs;
  };

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
      if (label === 'start') setConfirmStart(false);
      if (label === 'step') setConfirmStep(false);
      if (label === 'resume') setConfirmResume(false);
    }
  };

  return (
    <section className="panel run-controls" aria-label="Run controls">
      <h2>Run controls</h2>
      <p className="warning"><strong>Local mutation warning:</strong> start, step, and resume execute workflow nodes on this machine. Non-smoke workflows may run agents, processes, or other side effects.</p>
      {!smokeSafe && <p className="warning strong">Selected workflow/run is not the smoke-demo local-safe workflow. Confirm before mutating.</p>}
      <div className="control-grid">
        <div className="control-card">
          <h3>Start selected workflow</h3>
          <label>Run ID <input value={runId} onChange={(event) => setRunId(event.target.value)} /></label>
          <label>Inputs (key=value, one per line) <textarea value={inputsText} onChange={(event) => setInputsText(event.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={confirmStart} onChange={(event) => setConfirmStart(event.target.checked)} /> I understand this may execute local side effects.</label>
          <button type="button" disabled={!selectedWorkflow || !confirmStart || busy} onClick={() => mutate('start', () => postJson<MutationResult>('/api/runs', { workflow_name: selectedWorkflow, run_id: runId, inputs: parseInputs() }), runId)}>Start run</button>
        </div>
        <div className="control-card">
          <h3>Step selected run</h3>
          <p className="muted">Executes exactly one node when possible; exit code 0 can still leave the run running.</p>
          <label className="check"><input type="checkbox" checked={confirmStep} onChange={(event) => setConfirmStep(event.target.checked)} /> Confirm one local node execution.</label>
          <button type="button" disabled={!selectedRun || !confirmStep || busy} onClick={() => mutate('step', () => postJson<MutationResult>(`/api/runs/${encodeURIComponent(selectedRun || '')}/step`, {}), selectedRun || undefined)}>Step one node</button>
        </div>
        <div className="control-card">
          <h3>Resume selected run</h3>
          <label>Max steps <input type="number" min="1" max="1000" value={maxSteps} onChange={(event) => setMaxSteps(Number(event.target.value))} /></label>
          <label className="check"><input type="checkbox" checked={confirmResume} onChange={(event) => setConfirmResume(event.target.checked)} /> Confirm bounded local execution.</label>
          <button type="button" disabled={!selectedRun || !confirmResume || busy} onClick={() => mutate('resume', () => postJson<MutationResult>(`/api/runs/${encodeURIComponent(selectedRun || '')}/resume`, { max_steps: maxSteps }), selectedRun || undefined)}>Resume run</button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {result && <div className={result.status === 'guarded' ? 'warning' : 'success'}>Mutation {result.operation} {result.status}{result.code ? ` (${result.code})` : ''}<pre>{snippet(result)}</pre></div>}
    </section>
  );
};
