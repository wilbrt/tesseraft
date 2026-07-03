import React, { useEffect, useMemo, useRef, useState } from 'react';
import { browsePath, getJson, type BrowseResult } from '../lib/api';
import type { MutationResult, WorkflowDetail, WorkflowInputDefinition, WorkflowSummary } from '../types/runConsole';

type WorkflowInputField = { name: string; definition: WorkflowInputDefinition };
export type StartPayload = { workflow_name: string; run_id: string; inputs: Record<string, string>; max_steps: number; git_user?: { name: string; email: string } };

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

const PathPicker = ({ value, onChange }: { value: string; onChange: (value: string) => void }) => {
  const [open, setOpen] = useState(false);
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const load = async (target: string): Promise<void> => {
    setLoading(true);
    setBrowseError(null);
    try {
      const result = await browsePath(`/api/browse?path=${encodeURIComponent(target)}`);
      setBrowse(result);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : String(err));
      setBrowse(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    if (!browse) void load(value || '.');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent): void => {
      if (containerRef.current && event.target instanceof Node && !containerRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const navigate = (entryName: string): void => {
    const target = browse ? pathJoin(browse.path, entryName) : entryName;
    void load(target);
  };

  return (
    <div className="path-picker" ref={containerRef}>
      <div className="path-picker-row">
        <input value={value} onChange={(event) => onChange(event.target.value)} placeholder="." aria-label="Path" />
        <button type="button" className="link-button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>Browse…</button>
      </div>
      {open && (
        <div className="browse-popover" role="dialog" aria-label="Browse local filesystem">
          <div className="browse-cwd">
            {browse && <><strong>CWD:</strong> <code>{browse.path}</code></>}
            <button type="button" className="link-button" onClick={() => { if (browse) void load(parentOf(browse.path)); else void load('.'); }}>Up…</button>
            <button type="button" className="link-button" disabled={!browse?.is_dir} onClick={() => { if (browse) onChange(browse.path); setOpen(false); }}>Pick this directory</button>
          </div>
          {loading && <p className="muted">Loading…</p>}
          {browseError && <p className="error inline">{browseError}</p>}
          {browse && !loading && (
            <ul className="browse-list">
              {browse.entries.length === 0 && <li className="muted">No entries (hidden files omitted).</li>}
              {browse.entries.map((entry) => (
                <li key={entry.name}>
                  <button type="button" className="link-button" onClick={() => (entry.is_dir ? navigate(entry.name) : (() => { onChange(pathJoin(browse.path, entry.name)); setOpen(false); })())}>
                    {entry.is_dir ? '📁' : '📄'} {entry.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

const pathJoin = (base: string, name: string): string => {
  if (name === '.' || name === '') return base;
  if (base.endsWith('/')) return `${base}${name}`;
  return `${base}/${name}`;
};
const parentOf = (p: string): string => {
  const idx = p.replace(/\/$/, '').lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
};

export const StartWorkflowWizard = ({ open, workflows, initialWorkflow, onClose, onStart }: {
  open: boolean;
  workflows: WorkflowSummary[];
  initialWorkflow?: string | null;
  onClose: () => void;
  onStart: (payload: StartPayload) => Promise<MutationResult>;
}) => {
  const [step, setStep] = useState<'pick' | 'fill'>('pick');
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(initialWorkflow || null);
  const [workflowDetail, setWorkflowDetail] = useState<WorkflowDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [runId, setRunId] = useState(`run-${Date.now()}`);
  const [maxSteps, setMaxSteps] = useState(10);
  const [gitUserName, setGitUserName] = useState('');
  const [gitUserEmail, setGitUserEmail] = useState('');
  const [showGitUser, setShowGitUser] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Keep the latest onClose without depending on its identity, so the focus/
  // keydown listener mounts once per open transition instead of once per parent
  // render (RunControls re-renders on every SSE tick via runDetail/selectedRun).
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  const inputFields = useMemo<WorkflowInputField[]>(() => Object.entries(workflowDetail?.normalized?.inputs || {}).map(([name, definition]) => ({ name, definition })).sort((a, b) => Number(Boolean(b.definition.required)) - Number(Boolean(a.definition.required)) || a.name.localeCompare(b.name)), [workflowDetail]);

  // Reset state when the wizard opens.
  useEffect(() => {
    if (!open) return;
    setStep('pick');
    setSelectedWorkflow(initialWorkflow || null);
    setWorkflowDetail(null);
    setDetailError(null);
    setRunId(`run-${Date.now()}`);
    setMaxSteps(10);
    setGitUserName('');
    setGitUserEmail('');
    setShowGitUser(false);
    setConfirm(false);
    setSubmitError(null);
    setInputValues({});
  }, [open, initialWorkflow]);

  // Focus management.
  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement as HTMLButtonElement | null;
    const t = setTimeout(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>('button, [href], input, select, textarea');
      first?.focus();
    }, 0);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); }
      if (event.key === 'Tab') trapTab(event, dialogRef.current);
    };
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); document.removeEventListener('keydown', onKey); triggerRef.current?.focus(); };
  }, [open]);

  const loadDetail = async (name: string): Promise<WorkflowDetail | null> => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const data = await getJson<{ workflow: WorkflowDetail }>(`/api/workflows/${encodeURIComponent(name)}`);
      setWorkflowDetail(data.workflow);
      const nextValues: Record<string, string> = {};
      for (const field of Object.entries(data.workflow.normalized?.inputs || {}).map(([fn, fd]) => ({ name: fn, definition: fd })) as WorkflowInputField[]) nextValues[field.name] = stringifyDefault(field.definition.default);
      setInputValues(nextValues);
      return data.workflow;
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err));
      setWorkflowDetail(null);
      return null;
    } finally {
      setDetailLoading(false);
    }
  };

  const pickAndAdvance = async (name: string): Promise<void> => {
    setSelectedWorkflow(name);
    const detail = await loadDetail(name);
    if (detail) setStep('fill');
  };

  const setInputValue = (name: string, value: string): void => setInputValues((current) => ({ ...current, [name]: value }));
  const buildInputs = (): Record<string, string> => Object.fromEntries(Object.entries(inputValues).filter(([, value]) => value.trim() !== ''));
  const missingRequired = inputFields.filter((field) => field.definition.required && !inputValues[field.name]?.trim()).map((field) => field.name);
  const EMAIL_RE = /^\S+@\S+\.\S+$/;
  const gitUserNameTrim = gitUserName.trim();
  const gitUserEmailTrim = gitUserEmail.trim();
  const gitUserPartial = (gitUserNameTrim !== '') !== (gitUserEmailTrim !== '');
  const gitUserBadEmail = gitUserEmailTrim !== '' && !EMAIL_RE.test(gitUserEmailTrim);
  const gitUserValid = !gitUserPartial && !gitUserBadEmail;
  const buildGitUser = (): { name: string; email: string } | undefined => {
    if (gitUserNameTrim === '' && gitUserEmailTrim === '') return undefined;
    if (!gitUserValid) return undefined;
    return { name: gitUserNameTrim, email: gitUserEmailTrim };
  };

  const canStart = Boolean(selectedWorkflow && workflowDetail && missingRequired.length === 0 && gitUserValid && confirm && !busy);

  const start = async (): Promise<void> => {
    if (!selectedWorkflow || !canStart) return;
    setBusy(true);
    setSubmitError(null);
    try {
      await onStart({ workflow_name: selectedWorkflow, run_id: runId, inputs: buildInputs(), max_steps: maxSteps, ...(buildGitUser() ? { git_user: buildGitUser() } : {}) });
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="modal-backdrop wizard-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-heading" ref={dialogRef}>
        <div className="modal-header">
          <h2 id="wizard-heading">Start workflow</h2>
          <button type="button" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <ol className="wizard-steps" aria-label="Wizard steps">
          <li aria-current={step === 'pick' ? 'true' : undefined}>1. Pick workflow</li>
          <li aria-current={step === 'fill' ? 'true' : undefined}>2. Configure run</li>
        </ol>
        {submitError && <div className="error">{submitError}</div>}
        {step === 'pick' && (
          <div className="wizard-step wizard-pick">
            <p className="muted">Choose a workflow to run.</p>
            {workflows.length === 0 && <p className="muted">No workflows discovered.</p>}
            <ul className="item-list wizard-workflow-list">
              {workflows.map((workflow) => {
                const selected = workflow.name === selectedWorkflow;
                return (
                  <li key={workflow.name} className={selected ? 'selected-row' : undefined} aria-current={selected ? 'true' : undefined}>
                    <button type="button" onClick={() => void pickAndAdvance(workflow.name)}>{workflow.name || '(unnamed)'}</button>
                    <span>{workflow.path}</span>
                  </li>
                );
              })}
            </ul>
            <div className="wizard-actions">
              <button type="button" onClick={onClose}>Cancel</button>
              <button type="button" className="primary" disabled={!selectedWorkflow} onClick={async () => { if (selectedWorkflow) { const detail = workflowDetail && selectedWorkflow === workflowDetail.name ? workflowDetail : await loadDetail(selectedWorkflow); if (detail) setStep('fill'); } }}>Next</button>
            </div>
          </div>
        )}
        {step === 'fill' && (
          <div className="wizard-step wizard-fill">
            {detailError && <div className="error">{detailError}</div>}
            {detailLoading && <p className="muted">Loading workflow inputs…</p>}
            {selectedWorkflow && !detailLoading && workflowDetail && (
              <>
                <h3>{workflowDetail.normalized?.metadata?.title || selectedWorkflow}</h3>
                <label>Run ID <input value={runId} onChange={(event) => setRunId(event.target.value)} /></label>
                <div className="workflow-inputs" aria-label="Workflow inputs">
                  <h4>Workflow inputs</h4>
                  {inputFields.length === 0 && <p className="muted">This workflow declares no start inputs. Defaults will be used.</p>}
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
                      ) : definition.type === 'path' ? (
                        <PathPicker value={inputValues[name] ?? ''} onChange={(value) => setInputValue(name, value)} />
                      ) : (
                        <input value={inputValues[name] ?? ''} onChange={(event) => setInputValue(name, event.target.value)} placeholder={undefined} />
                      )}
                      <small>{inputHelp(name, definition)}{definition.default !== undefined ? ` Default: ${String(definition.default)}.` : ''}</small>
                    </label>
                  ))}
                </div>
                {missingRequired.length > 0 && <p className="error inline">Required inputs missing: {missingRequired.map(humanizeInputName).join(', ')}</p>}
                <div className="git-user-section" aria-label="Git user (commit identity)">
                  <button type="button" className="toggle" aria-expanded={showGitUser} onClick={() => setShowGitUser((v) => !v)}>Git user (commit identity) {showGitUser ? '▾' : '▸'}</button>
                  {showGitUser && (
                    <div className="git-user-fields">
                      <small className="muted">When set, agent commits in this run use this Git author. Leave blank to use this machine's git config.</small>
                      <label>Name <input type="text" value={gitUserName} onChange={(event) => setGitUserName(event.target.value)} placeholder="Git author name" /></label>
                      <label>Email <input type="email" value={gitUserEmail} onChange={(event) => setGitUserEmail(event.target.value)} placeholder="git@example.com" /></label>
                      {(gitUserPartial || gitUserBadEmail) && <p className="error inline">{gitUserPartial ? 'Both name and email are required when either is set.' : 'Enter a valid email address.'}</p>}
                    </div>
                  )}
                </div>
                <label>Max automated steps <input type="number" min="1" max="1000" value={maxSteps} onChange={(event) => setMaxSteps(Number(event.target.value))} /></label>
                <label className="check"><input type="checkbox" checked={confirm} onChange={(event) => setConfirm(event.target.checked)} /> I understand this may execute local side effects automatically.</label>
              </>
            )}
            <div className="wizard-actions">
              <button type="button" onClick={() => setStep('pick')}>Back</button>
              <button type="button" className="primary" disabled={!canStart} onClick={() => void start()}>Start and run</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const trapTab = (event: KeyboardEvent, container: HTMLElement | null): void => {
  if (!container || event.key !== 'Tab') return;
  const focusable = container.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])');
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
};