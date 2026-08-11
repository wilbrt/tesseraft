import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphEdge } from '../../lib/graphLayout';
import { getJson, postJson } from '../../lib/api';
import { writeWorkflowAsset } from '../../lib/studio';
import type { PiChatMessage, PiSessionStatus } from '../../types/piSessions';
import type { LintReport, NodeTypeId, StudioWorkflow, Transition, WhenMap } from '../../types/studio';
import {
  AUTO_FIELDS,
  autoSnapshot,
  emptyForm,
  stateIdRe,
  titleFromId,
  type CapabilityExecutor,
  type CapabilityHandler,
  type CapabilityNodeType,
  type NodeFormState
} from './model';

export const WhenEditor = ({ value, onChange }: { value: WhenMap; onChange: (next: WhenMap) => void }) => (
  <div className="when-editor">
    {Object.entries(value).length === 0 && <p className="muted">No conditions (transition always matches).</p>}
    {Object.entries(value).map(([key, val], i) => (
      <div className="row" key={i}>
        <input type="text" value={key} placeholder="key e.g. status" onChange={(e) => { const next = { ...value }; delete next[key]; next[e.target.value] = val; onChange(next); }} />
        <span>=</span>
        <input type="text" value={val} placeholder="value e.g. pass" onChange={(e) => { const next = { ...value }; next[key] = e.target.value; onChange(next); }} />
        <button type="button" onClick={() => { const next = { ...value }; delete next[key]; onChange(next); }}>Remove</button>
      </div>
    ))}
    <button type="button" className="link" onClick={() => onChange({ ...value, '': '' })}>+ Add condition</button>
    <label className="check"><input type="checkbox" checked={Boolean(value['else'])} onChange={(e) => { const next = { ...value }; if (e.target.checked) next['else'] = 'true'; else delete next['else']; onChange(next); }} /> else (fallback)</label>
  </div>
);

const NodeForm = ({ form, setForm, draft, handlers, executors, excludeId, onCompose }: { form: NodeFormState; setForm: React.Dispatch<React.SetStateAction<NodeFormState>>; draft: StudioWorkflow; handlers: CapabilityHandler[]; executors: CapabilityExecutor[]; excludeId?: string; onCompose?: () => void }) => {
  const otherNodeIds = Object.keys(draft.states).filter((id) => id !== excludeId);
  const resolvedTemplatePath = form.agentPromptTemplate || (form.id ? `prompts/${form.id}.md.tmpl` : '');
  const set = (patch: Partial<NodeFormState>): void => setForm((prev) => ({ ...prev, ...patch }));
  const setTransition = (i: number, patch: Partial<Transition>): void => setForm((prev) => {
    const ts = [...(prev.transitions || [])];
    ts[i] = { ...ts[i], ...patch };
    return { ...prev, transitions: ts };
  });
  const addTransition = (): void => setForm((prev) => ({ ...prev, transitions: [...(prev.transitions || []), { when: {}, next: otherNodeIds[0] || '' }] }));

  return (
    <div className="node-form">
      <div className="row"><label htmlFor="studio-node-id">ID (state keyword)</label><input id="studio-node-id" type="text" value={form.id} onChange={(e) => set({ id: e.target.value })} placeholder="e.g. start" required pattern="[a-z][a-z0-9-]{0,62}" /></div>
      <div className="row"><label>Title</label><input type="text" value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="optional" /></div>
      {form.type === 'agent' && (
        <>
          <div className="row"><label>Executor</label><select value={form.agentExecutor} onChange={(e) => set({ agentExecutor: e.target.value })}>
            <option value="">Select an executor…</option>
            {executors.map((executor) => {
              const value = executor.id;
              const unavailable = executor['dispatchable?'] === false || executor.availability?.status === 'unavailable';
              return <option key={executor.id} value={value} disabled={unavailable}>{executor.label}{unavailable ? ' (unavailable)' : ''}</option>;
            })}
          </select></div>
          <div className="row">
            <label>Prompt template</label>
            <div className="prompt-compose-row">
              <button type="button" className="compose-btn" onClick={onCompose}>Compose prompt template…</button>
              {resolvedTemplatePath
                ? <span className="muted">Saves to: <code>{resolvedTemplatePath}</code></span>
                : <span className="muted">Enter an ID first, then compose.</span>}
            </div>
          </div>
          <details className="advanced-section">
            <summary>Advanced: custom template path</summary>
            <div className="row"><label>Template path</label><input type="text" value={form.agentPromptTemplate} onChange={(e) => set({ agentPromptTemplate: e.target.value })} placeholder="prompts/x.md.tmpl" /></div>
            <p className="muted">Niche option. The composer saves the drafted content to this path; the node's <code>:prompt-template</code> field points to it.</p>
          </details>
          <div className="row"><label>Prompt output</label><input type="text" value={form.agentPromptOutput} onChange={(e) => set({ agentPromptOutput: e.target.value })} placeholder="prompts/generated/x.md" /></div>
          <div className="row"><label>Status output path</label><input type="text" value={form.agentStatusPath} onChange={(e) => set({ agentStatusPath: e.target.value })} placeholder="status/status.json" /></div>
        </>
      )}
      {form.type === 'deterministic' && (
        <>
          <div className="row"><label>Handler</label>
            <select value={form.deterministicHandler} onChange={(e) => set({ deterministicHandler: e.target.value })}>
              <option value="">Select a handler…</option>
              {handlers.map((handler) => <option key={handler.id} value={handler.id}>{handler.label}{handler['deprecated?'] ? ' (deprecated)' : ''}</option>)}
            </select>
          </div>
          <div className="row"><label>Next state</label><select value={form.deterministicNext} onChange={(e) => set({ deterministicNext: e.target.value })}><option value="">(none)</option>{otherNodeIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></div>
        </>
      )}
      {form.type === 'process' && (
        <>
          <div className="row"><label>Command (space-separated)</label><input type="text" value={form.processCommand} onChange={(e) => set({ processCommand: e.target.value })} placeholder="node scripts/x.js" /></div>
          <div className="row"><label>Input mode</label><input type="text" value={form.processInputMode} onChange={(e) => set({ processInputMode: e.target.value })} /></div>
          <div className="row"><label>Output mode</label><input type="text" value={form.processOutputMode} onChange={(e) => set({ processOutputMode: e.target.value })} /></div>
          <div className="row"><label>Next state</label><select value={form.processNext} onChange={(e) => set({ processNext: e.target.value })}><option value="">(none)</option>{otherNodeIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></div>
        </>
      )}
      {form.type === 'timer' && (
        <>
          <div className="row"><label>Duration</label><input type="text" value={form.timerDuration} onChange={(e) => set({ timerDuration: e.target.value })} placeholder="30s" /></div>
          <div className="row"><label>Next state</label><select value={form.timerNext} onChange={(e) => set({ timerNext: e.target.value })}><option value="">(none)</option>{otherNodeIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></div>
        </>
      )}
      {form.type === 'approval' && (
        <>
          <div className="row"><label>Message</label><input type="text" value={form.approvalMessage} onChange={(e) => set({ approvalMessage: e.target.value })} placeholder="Approve this change?" /></div>
        </>
      )}
      {form.type === 'terminal' && (
        <div className="row"><label htmlFor="studio-terminal-status">Status</label><select id="studio-terminal-status" value={form.terminalStatus} onChange={(e) => set({ terminalStatus: e.target.value })}><option value="success">success</option><option value="failure">failure</option></select></div>
      )}
      {(form.type === 'agent' || form.type === 'approval' || form.type === 'router') && (
        <fieldset>
          <legend>Transitions</legend>
          {(form.transitions || []).map((t, i) => (
            <div className="transition-row" key={i}>
              <WhenEditor value={t.when || {}} onChange={(when) => setTransition(i, { when })} />
              <div className="row"><label>Next</label><select value={t.next} onChange={(e) => setTransition(i, { next: e.target.value })}>{otherNodeIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></div>
              <button type="button" onClick={() => setForm((prev) => ({ ...prev, transitions: (prev.transitions || []).filter((_, j) => j !== i) }))}>Remove transition</button>
            </div>
          ))}
          <button type="button" onClick={addTransition}>+ Add transition</button>
        </fieldset>
      )}
    </div>
  );
};

export const CreateWorkflowModal = ({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, description?: string) => Promise<void> }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <ModalShell title="Create workflow" onClose={onClose}>
      <div className="row"><label htmlFor="studio-workflow-name">Name (lowercase, hyphens)</label><input id="studio-workflow-name" type="text" value={name} onChange={(e) => setName(e.target.value)} required pattern="[a-z][a-z0-9-]{0,62}" /></div>
      <div className="row"><label>Description (optional)</label><input type="text" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      {error && <div className="error">{error}</div>}
      <div className="modal-actions">
        <button type="button" disabled={busy || !stateIdRe.test(name)} onClick={async () => { setBusy(true); setError(null); try { await onCreate(name, description || undefined); } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); } }}>Create</button>
        <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </ModalShell>
  );
};

export const ModalShell = ({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h2>{title}</h2><button type="button" onClick={onClose} aria-label="Close">×</button></div>
        {children}
      </div>
    </div>
  );
};

export const LintMessageList = ({ report }: { report: LintReport | null }) => {
  if (!report) return null;
  const items = [...(report.errors || []), ...(report.warnings || [])] as Array<{ severity?: string; code?: string; message?: string; path?: string[] }>;
  if (items.length === 0 && report.ok) return <p className="muted">Linter: no issues.</p>;
  return (
    <ul className="lint-list">
      {items.map((item, i) => (
        <li key={i} className={`lint-${item.severity || 'warning'}`}><strong>{item.code || item.severity}</strong> {item.message}{item.path && item.path.length ? ` (path: ${item.path.join('/')})` : ''}</li>
      ))}
    </ul>
  );
};
// Bespoke Pi-session chat surface for drafting an agent-node prompt template.
// Creates a Pi session on open, seeds it with a prompt-engineering instruction,
// streams the assistant draft, and lets the user accept the draft and save it
// to the workflow package as a `.md.tmpl` asset. The server asset route is the
// write authority; the node's `:prompt-template` field is set to that path.
const COMPOSE_SEED = (title: string, nodeId: string): string =>
  `Draft a Tesseraft agent-node prompt template for a workflow node titled "${title || nodeId}" (id: ${nodeId}) of type agent. ` +
  'Use Tesseraft template variables where appropriate: {{inputs.*}}, {{run.*}}, {{node.*}}, and {{artifacts.*}}. ' +
  `The template body will be saved to prompts/${nodeId}.md.tmpl and referenced by the node's :prompt-template field. ` +
  'Output only the template body (no prose commentary, no code fences).';

type PromptComposerModalProps = {
  workflowName: string;
  nodeId: string;
  nodeTitle: string;
  currentPath: string;
  onSaved: (path: string) => void;
  onClose: () => void;
};

const PromptComposerModal = ({ workflowName, nodeId, nodeTitle, currentPath, onSaved, onClose }: PromptComposerModalProps) => {
  const resolvedPath = currentPath || (nodeId ? `prompts/${nodeId}.md.tmpl` : 'prompts/template.md.tmpl');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<PiChatMessage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [streamStatus, setStreamStatus] = useState<'disconnected' | 'connected' | 'error'>('disconnected');
  const [sessionStatus, setSessionStatus] = useState<PiSessionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draftContent, setDraftContent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Create + seed a Pi session on open. The seed is a fixed frontend string so
  // the server stays generic (no Tesseraft-specific prompt knowledge there).
  useEffect(() => {
    if (!nodeId) return;
    const sessionTitle = `studio:${workflowName}:${nodeId}`;
    let cancelled = false;
    void (async () => {
      try {
        setBusy(true); setError(null);
        const created = await postJson<{ session: { id: string } }>('/api/pi-sessions', { title: sessionTitle });
        if (cancelled) return;
        const id = created.session.id;
        setSessionId(id);
        await postJson(`/api/pi-sessions/${encodeURIComponent(id)}/prompts`, { prompt: COMPOSE_SEED(nodeTitle, nodeId) });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [workflowName, nodeId, nodeTitle]);

  // Stream snapshots (reuses the Pi Sessions EventSource pattern).
  useEffect(() => {
    if (!sessionId) return undefined;
    const source = new EventSource(`/api/pi-sessions/${encodeURIComponent(sessionId)}/stream`);
    setStreamStatus('connected');
    source.addEventListener('snapshot', (event) => {
      try {
        const snap = JSON.parse((event as MessageEvent).data) as { messages?: PiChatMessage[]; session?: { status?: PiSessionStatus } };
        setMessages(snap.messages || []);
        if (snap.session?.status) setSessionStatus(snap.session.status);
        setStreamStatus('connected');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
    source.onerror = () => setStreamStatus('error');
    return () => { source.close(); setStreamStatus('disconnected'); };
  }, [sessionId]);

  const lastAssistant = useMemo(() => {
    const asst = messages.filter((m) => m.role === 'assistant');
    return asst.length > 0 ? asst[asst.length - 1] : null;
  }, [messages]);

  // Surface Pi/SDK failures prominently. The real adapter can emit a
  // session.error event (status='error') with empty assistant content when
  // the upstream model errors (e.g. usage limit). Without this, the modal
  // shows a 'connected' stream, no draft, and no indication that Pi failed.
  const piError = useMemo(() => {
    const err = messages.find((m) => m.status === 'error');
    return err ? err.text : null;
  }, [messages]);
  // When the session reached 'done' with no assistant draft and no error,
  // the adapter completed but produced nothing — usually a misconfigured
  // provider/model (e.g. real SDK without TESSERAFT_PI_ADAPTER=fake). This
  // is distinct from a hard 'error' status and from a still-running session,
  // so it gets a specific diagnostic instead of the generic nudge hint.
  const completedNoDraft = !busy && sessionStatus === 'done' && messages.length > 0 && !lastAssistant && !piError;
  const hasNoDraft = !busy && sessionStatus !== 'done' && messages.length > 0 && !lastAssistant && !piError;

  const sendPrompt = async (): Promise<void> => {
    if (!sessionId || !prompt.trim()) return;
    const toSend = prompt;
    setPrompt('');
    setError(null);
    try {
      setBusy(true);
      await postJson(`/api/pi-sessions/${encodeURIComponent(sessionId)}/prompts`, { prompt: toSend });
    } catch (e) {
      setPrompt(toSend);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!draftContent) return;
    setSaving(true); setError(null);
    try {
      await writeWorkflowAsset(workflowName, resolvedPath, draftContent);
      onSaved(resolvedPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title={`Compose prompt template — ${nodeId || 'new node'}`} onClose={onClose} wide>
      <dl className="field-row">
        <dt>Workflow</dt><dd>{workflowName}</dd>
        <dt>Node</dt><dd>{nodeId || '(unset)'}</dd>
        <dt>Save to</dt><dd><code>{resolvedPath}</code></dd>
        <dt>Stream</dt><dd><span className={`status-pill ${streamStatus}`}>{streamStatus}</span></dd>
      </dl>
      {error && <div className="error">{error}</div>}
      {piError && <div className="error">Pi returned an error: {piError}. Refine the prompt and send again to retry.</div>}
      {completedNoDraft && <div className="error">Pi completed without generating a response. The Pi adapter may not be configured with a provider/model. Set TESSERAFT_PI_ADAPTER=fake on the server for local testing, or configure a default provider/model in Settings. Refine the prompt and send again to retry.</div>}
      {streamStatus === 'error' && <div className="error">Live stream disconnected. Reopen the composer to reconnect.</div>}
      {busy && <div className="muted">Working…</div>}
      {hasNoDraft && <div className="muted">No assistant draft yet. Send a follow-up prompt to nudge Pi.</div>}
      <div className="pi-chat-transcript" aria-label="Prompt composer transcript">
        {messages.length === 0 && <div className="empty">Seeding the draft with Pi…</div>}
        {messages.map((m) => (
          <article key={m.id} className={`pi-chat-message ${m.role}`}>
            <div className="pi-chat-meta">{m.role}{m.status ? ` · ${m.status}` : ''}</div>
            <pre className="pi-chat-text">{m.text}</pre>
          </article>
        ))}
      </div>
      <div className="control-card pi-prompt-form">
        <label>Prompt<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Refine the draft with a follow-up prompt" /></label>
        <button type="button" disabled={!prompt.trim() || busy} onClick={() => void sendPrompt()}>Send</button>
      </div>
      <div className="composer-preview">
        <h3>Preview</h3>
        {draftContent
          ? <pre className="composer-preview-body">{draftContent}</pre>
          : <p className="muted">Click "Use as template" to snapshot the latest assistant draft.</p>}
      </div>
      <div className="modal-actions">
        <button type="button" disabled={!lastAssistant} onClick={() => setDraftContent(lastAssistant ? lastAssistant.text : null)}>Use as template</button>
        <button type="button" disabled={!draftContent || saving} onClick={() => void save()}>Save to workflow</button>
        <button type="button" onClick={onClose} disabled={saving}>Cancel</button>
      </div>
    </ModalShell>
  );
};

export const NodeFormModal = ({ title, draft, nodeTypes, handlers, executors, initial, excludeId, onClose, onSubmit }: { title: string; draft: StudioWorkflow; nodeTypes: CapabilityNodeType[]; handlers: CapabilityHandler[]; executors: CapabilityExecutor[]; initial: NodeFormState; excludeId?: string; onClose: () => void; onSubmit: (form: NodeFormState) => string | null }) => {
  const [form, setForm] = useState<NodeFormState>(initial);
  const [error, setError] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);

  // Tracks the auto-derived values last applied for the current id/type, so
  // that changing the id re-derives defaults only for fields whose value still
  // equals the previous auto value (untouched by the user). A user edit that
  // differs from the prior auto value is never clobbered.
  const autoRef = useRef<{ id: string; type: NodeTypeId; values: Partial<NodeFormState> }>({ id: initial.id, type: initial.type, values: initial.id ? autoSnapshot(initial.id, initial.type) : {} });

  // Re-derive auto defaults for `id`/`t`. Called on first mount (fill empties
  // only) and whenever the id input changes (refresh fields still at their
  // prior auto value). `force` fills even non-empty fields on first mount for
  // an empty form (e.g. Add node), but never overwrites user edits on edit.
  const rederive = (id: string, t: NodeTypeId, force: boolean): void => {
    const prev = autoRef.current;
    const next = id ? autoSnapshot(id, t) : {} as Partial<NodeFormState>;
    setForm((cur) => {
      const patch: Partial<NodeFormState> = {};
      for (const key of AUTO_FIELDS) {
        const oldAuto = prev.values[key];
        const curVal = cur[key] as string;
        if (force && curVal === '') {
          (patch as Record<string, unknown>)[key] = (next as Record<string, unknown>)[key] ?? '';
        } else if (!force && (curVal === '' || (oldAuto !== undefined && curVal === oldAuto))) {
          (patch as Record<string, unknown>)[key] = (next as Record<string, unknown>)[key] ?? '';
        }
      }
      return { ...cur, ...patch };
    });
    autoRef.current = { id, type: t, values: next };
  };

  // First mount: derive once. For an empty form (Add node) with no id yet,
  // there's nothing to derive; id-input changes will fill as the user types.
  // For an Edit-node form with an existing id and real values, only empties
  // are filled (force=true targets empties only).
  useEffect(() => { if (initial.id) rederive(initial.id, initial.type, true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Intercept setForm: when the id changes, re-derive defaults for the new
  // id and apply both the new id and rederived values in a single render.
  const setFormTracked: React.Dispatch<React.SetStateAction<NodeFormState>> = (updater) => {
    setForm((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      if (next.id === prev.id) return next;
      // id changed: rederive against the new id/type.
      const prevAuto = autoRef.current.values;
      const snap = next.id ? autoSnapshot(next.id, next.type) : {} as Partial<NodeFormState>;
      for (const key of AUTO_FIELDS) {
        const oldAuto = prevAuto[key];
        const curVal = (next as Record<string, unknown>)[key] as string;
        if (curVal === '' || (oldAuto !== undefined && curVal === oldAuto)) {
          (next as Record<string, unknown>)[key] = (snap as Record<string, unknown>)[key] ?? '';
        }
      }
      autoRef.current = { id: next.id, type: next.type, values: snap };
      return next;
    });
  };

  return (
    <ModalShell title={title} onClose={onClose} wide>
      <div className="row"><label htmlFor="studio-node-type">Node type</label>
        <select id="studio-node-type" value={form.type} onChange={(e) => { const t = e.target.value as NodeTypeId; setForm((prev) => ({ ...emptyForm(t), id: prev.id, title: prev.id ? titleFromId(prev.id) : '' })); rederive(form.id, t, true); }}>
          {nodeTypes.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </div>
      <NodeForm form={form} setForm={setFormTracked} draft={draft} handlers={handlers} executors={executors} excludeId={excludeId} onCompose={() => setComposerOpen(true)} />
      {error && <div className="error">{error}</div>}
      <div className="modal-actions">
        <button type="button" onClick={() => { const err = onSubmit(form); if (err) setError(err); }}>Save node</button>
        <button type="button" onClick={onClose}>Cancel</button>
      </div>
      {composerOpen && (
        <PromptComposerModal
          workflowName={draft.metadata.name}
          nodeId={form.id}
          nodeTitle={form.title || form.id}
          currentPath={form.agentPromptTemplate}
          onSaved={(path) => { setForm((prev) => ({ ...prev, agentPromptTemplate: path })); setComposerOpen(false); }}
          onClose={() => setComposerOpen(false)}
        />
      )}
    </ModalShell>
  );
};

export const EdgeMenu = ({ menu, draft, onClose, onDelete, onEdit }: { menu: { x: number; y: number; edge: GraphEdge }; draft: StudioWorkflow; onClose: () => void; onDelete: () => void; onEdit: (when: WhenMap) => void }) => {
  const [editing, setEditing] = useState(false);
  const [when, setWhen] = useState<WhenMap>(menu.edge.condition && typeof menu.edge.condition === 'object' ? menu.edge.condition as WhenMap : {});
  void draft;
  return (
    <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
      {editing ? (
        <div className="edge-when-popup">
          <WhenEditor value={when} onChange={setWhen} />
          <button type="button" onClick={() => { onEdit(when); onClose(); }}>Save</button>
        </div>
      ) : (
        <>
          <button type="button" onClick={() => setEditing(true)}>Edit when</button>
          <button type="button" onClick={() => { onDelete(); onClose(); }}>Delete</button>
        </>
      )}
    </div>
  );
};
