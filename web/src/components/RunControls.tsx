import { useEffect, useMemo, useState } from 'react';
import { postJson } from '../lib/api';
import { snippet } from '../lib/runConsole';
import type { MutationResult, RunDetail, WorkflowDetail, WorkflowInputDefinition } from '../types/runConsole';

type Props = {
  selectedWorkflow: string | null;
  workflowDetail: WorkflowDetail | null;
  selectedRun: string | null;
  runDetail: RunDetail | null;
  onRefresh: (runId?: string) => Promise<void>;
};

type WorkflowInputField = { name: string; definition: WorkflowInputDefinition };

const humanizeInputName = (name: string): string => name.split('-').map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part).join(' ');
const stringifyDefault = (value: WorkflowInputDefinition['default']): string => value === undefined || value === null ? '' : String(value);
const inputHelp = (name: string, definition: WorkflowInputDefinition): string => {
  if (definition.description) return definition.description;
  if (definition.type === 'path') return 'Path on this machine, such as . for the current repository.';
  if (definition.type === 'integer') return 'Whole number.';
  if (definition.type === 'boolean') return 'Choose true or false.';
  if (name === 'ticket') return 'Ticket or issue key to fetch, for example PROJ-123.';
  if (name === 'branch' || name === 'base-branch') return 'Git branch name.';
  return 'Workflow input value.';
};

export const RunControls = ({ selectedWorkflow, workflowDetail, selectedRun, runDetail, onRefresh }: Props) => {
  const [runId, setRunId] = useState(`run-${Date.now()}`);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [maxSteps, setMaxSteps] = useState(10);
  const [confirmStart, setConfirmStart] = useState(false);
  const [confirmStep, setConfirmStep] = useState(false);
  const [confirmResume, setConfirmResume] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MutationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const smokeSafe = selectedWorkflow === 'smoke-demo' || runDetail?.workflow_name === 'smoke-demo';
  const inputFields = useMemo<WorkflowInputField[]>(() => Object.entries(workflowDetail?.normalized?.inputs || {}).map(([name, definition]) => ({ name, definition })).sort((a, b) => Number(Boolean(b.definition.required)) - Number(Boolean(a.definition.required)) || a.name.localeCompare(b.name)), [workflowDetail]);

  useEffect(() => {
    const nextValues: Record<string, string> = {};
    for (const field of inputFields) nextValues[field.name] = stringifyDefault(field.definition.default);
    setInputValues(nextValues);
  }, [inputFields]);

  const setInputValue = (name: string, value: string): void => setInputValues((current) => ({ ...current, [name]: value }));
  const buildInputs = (): Record<string, string> => Object.fromEntries(Object.entries(inputValues).filter(([, value]) => value.trim() !== ''));
  const missingRequired = inputFields.filter((field) => field.definition.required && !inputValues[field.name]?.trim()).map((field) => field.name);

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
        <div className="control-card start-workflow-card">
          <h3>Start and run selected workflow</h3>
          {!selectedWorkflow && <p className="muted">Select a workflow to see the inputs it needs.</p>}
          {selectedWorkflow && !workflowDetail && <p className="loading">Loading workflow inputs...</p>}
          <label>Run ID <input value={runId} onChange={(event) => setRunId(event.target.value)} /></label>
          <div className="workflow-inputs" aria-label="Workflow inputs">
            <h4>Workflow inputs</h4>
            {selectedWorkflow && workflowDetail && inputFields.length === 0 && <p className="muted">This workflow declares no start inputs. Defaults will be used.</p>}
            {inputFields.map(({ name, definition }) => (
              <label key={name} className="workflow-input-field">
                <span>{definition.title || humanizeInputName(name)} {definition.required && <strong className="required">required</strong>}</span>
                {definition.type === 'boolean' ? (
                  <select value={inputValues[name] ?? 'false'} onChange={(event) => setInputValue(name, event.target.value)}>
                    <option value="false">False</option>
                    <option value="true">True</option>
                  </select>
                ) : definition.enum && definition.enum.length > 0 ? (
                  <select value={inputValues[name] ?? ''} onChange={(event) => setInputValue(name, event.target.value)}>
                    {!definition.required && <option value="">Use default / leave blank</option>}
                    {definition.enum.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}
                  </select>
                ) : definition.type === 'integer' ? (
                  <input type="number" step="1" value={inputValues[name] ?? ''} onChange={(event) => setInputValue(name, event.target.value)} />
                ) : name === 'prompt' ? (
                  <textarea value={inputValues[name] ?? ''} onChange={(event) => setInputValue(name, event.target.value)} placeholder="Describe what the workflow should do" />
                ) : (
                  <input value={inputValues[name] ?? ''} onChange={(event) => setInputValue(name, event.target.value)} placeholder={definition.type === 'path' ? '.' : undefined} />
                )}
                <small>{inputHelp(name, definition)}{definition.default !== undefined ? ` Default: ${String(definition.default)}.` : ''}</small>
              </label>
            ))}
          </div>
          {missingRequired.length > 0 && <p className="error inline">Required inputs missing: {missingRequired.map(humanizeInputName).join(', ')}</p>}
          <label>Max automated steps <input type="number" min="1" max="1000" value={maxSteps} onChange={(event) => setMaxSteps(Number(event.target.value))} /></label>
          <label className="check"><input type="checkbox" checked={confirmStart} onChange={(event) => setConfirmStart(event.target.checked)} /> I understand this may execute local side effects automatically.</label>
          <button type="button" disabled={!selectedWorkflow || !workflowDetail || missingRequired.length > 0 || !confirmStart || busy} onClick={() => mutate('start', () => postJson<MutationResult>('/api/runs', { workflow_name: selectedWorkflow, run_id: runId, inputs: buildInputs(), max_steps: maxSteps }), runId)}>Start and run</button>
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
