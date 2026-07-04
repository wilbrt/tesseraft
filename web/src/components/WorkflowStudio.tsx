import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GraphEdge, GraphNode } from '../lib/graphLayout';
import { createStudioWorkflow, getStudioWorkflow, lintStudioWorkflow, saveStudioWorkflow, writeWorkflowAsset, type SaveStudioResult } from '../lib/studio';
import { postJson } from '../lib/api';
import type { PiChatMessage } from '../types/piSessions';
import { KNOWN_HANDLERS, CUSTOM_HANDLER_SENTINEL, NODE_TYPES, emptyDraft, type LintReport, type NodeTypeId, type StudioNode, type StudioPositions, type StudioWorkflow, type Transition, type WhenMap } from '../types/studio';

const NODE_W = 150;
const NODE_H = 56;
const CANVAS_PAD = 40;

type ContextMenu =
  | { kind: 'node'; x: number; y: number; nodeId: string }
  | { kind: 'edge'; x: number; y: number; edge: GraphEdge }
  | null;

type Modal =
  | { kind: 'create' }
  | { kind: 'addNode' }
  | { kind: 'editNode'; nodeId: string }
  | null;

type Props = {
  /** When set, the Studio opens directly to this workflow (e.g. just created). */
  initialWorkflowName: string | null;
  /** Called when the user dismisses Studio back to the Workflows list. */
  onExit: () => void;
  /** Refresh the workflows list after create/save. */
  onWorkflowsChanged: () => void;
};

const stateIdRe = /^[a-z][a-z0-9-]{0,62}$/;

const toGraphNodes = (draft: StudioWorkflow): GraphNode[] => Object.entries(draft.states).map(([id, node]) => ({ id, type: node.type.replace(/^:/, ''), title: node.title || id, resources: undefined, outputs: undefined }));
const toGraphEdges = (draft: StudioWorkflow): GraphEdge[] => {
  const edges: GraphEdge[] = [];
  for (const [id, node] of Object.entries(draft.states)) {
    if (node.transitions) {
      for (const t of node.transitions) {
        edges.push({ from: id, to: t.next, condition: t.when || undefined });
      }
    } else if (node.next) {
      edges.push({ from: id, to: node.next, condition: undefined });
    }
  }
  return edges;
};

const makeNodeKeyword = (id: string): string => `:${id}`;

// Sensible default values derived from a node id. Applied only to fields that
// are still empty/still hold a previous auto-derived value, so user edits are
// never clobbered. The linter remains the final authority.
const defaultPathsFor = (id: string, type: NodeTypeId): Partial<Record<keyof NodeFormState, string>> => {
  if (!id) return {};
  switch (type) {
    case ':agent':
      return {
        agentPromptTemplate: `prompts/${id}.md.tmpl`,
        agentPromptOutput: `prompts/generated/${id}.md`,
        agentStatusPath: `status/${id}-status.json`
      };
    case ':process':
      return { processCommand: `node scripts/${id}.js` };
    case ':approval':
      return { approvalMessage: `Approve ${id}?` };
    default:
      return {};
  }
};

const titleFromId = (id: string): string => {
  if (!id) return '';
  return id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' ');
};

const buildNodeFields = (form: NodeFormState): Partial<StudioNode> => {
  const node: Partial<StudioNode> = { id: form.id, type: form.type, title: form.title || undefined };
  switch (form.type) {
    case ':agent':
      node.executor = form.agentExecutor || undefined;
      node['prompt-template'] = form.agentPromptTemplate || undefined;
      node['prompt-output'] = form.agentPromptOutput || undefined;
      node.outputs = form.agentStatusPath ? { status: { path: form.agentStatusPath } } : undefined;
      node.transitions = form.transitions || undefined;
      break;
    case ':deterministic':
      node.handler = form.deterministicHandler || undefined;
      node.next = form.deterministicNext || undefined;
      break;
    case ':process':
      node.command = form.processCommand ? form.processCommand.split(/\s+/).filter(Boolean) : undefined;
      node['input-mode'] = form.processInputMode || undefined;
      node['output-mode'] = form.processOutputMode || undefined;
      node.next = form.processNext || undefined;
      break;
    case ':timer':
      node.duration = form.timerDuration || undefined;
      node.next = form.timerNext || undefined;
      break;
    case ':approval':
      node.message = form.approvalMessage || undefined;
      node.transitions = form.transitions || undefined;
      break;
    case ':router':
      node.transitions = form.transitions || undefined;
      break;
    case ':terminal':
      node.status = form.terminalStatus || undefined;
      break;
  }
  return node;
};

type NodeFormState = {
  id: string;
  type: NodeTypeId;
  title: string;
  // agent
  agentExecutor: string;
  agentPromptTemplate: string;
  agentPromptOutput: string;
  agentStatusPath: string;
  // deterministic
  deterministicHandler: string;
  deterministicNext: string;
  // process
  processCommand: string;
  processInputMode: string;
  processOutputMode: string;
  processNext: string;
  // timer
  timerDuration: string;
  timerNext: string;
  // approval
  approvalMessage: string;
  // terminal
  terminalStatus: string;
  // transitions (agent/approval/router)
  transitions: Transition[] | undefined;
};

// Keys on NodeFormState that `defaultPathsFor` may auto-fill. Tracked so that
// editing the id only overwrites a field when it still equals a prior
// auto-derived value (not a user edit).
const AUTO_FIELDS: Array<keyof NodeFormState> = [
  'agentPromptTemplate', 'agentPromptOutput', 'agentStatusPath',
  'processCommand', 'approvalMessage', 'title'
];

const emptyForm = (type: NodeTypeId): NodeFormState => ({
  id: '',
  type,
  title: '',
  agentExecutor: ':pi-cli',
  agentPromptTemplate: '',
  agentPromptOutput: '',
  agentStatusPath: '',
  deterministicHandler: '',
  deterministicNext: '',
  processCommand: '',
  processInputMode: ':json-stdin',
  processOutputMode: ':json-stdout',
  processNext: '',
  timerDuration: '30s',
  timerNext: '',
  approvalMessage: '',
  terminalStatus: ':success',
  transitions: undefined
});

// Snapshot of the auto-derived values for the current id/type, used to detect
// whether a field still holds an auto value (and can be safely replaced when
// the id changes) versus a user edit (must be preserved).
const autoSnapshot = (id: string, type: NodeTypeId): Partial<NodeFormState> => {
  const snap: Partial<NodeFormState> = { title: titleFromId(id) };
  Object.assign(snap, defaultPathsFor(id, type));
  return snap;
};

const formFromNode = (node: StudioNode): NodeFormState => {
  const base = emptyForm(node.type);
  return {
    ...base,
    id: node.id,
    type: node.type,
    title: node.title || '',
    agentExecutor: node.executor || ':pi-cli',
    agentPromptTemplate: node['prompt-template'] || '',
    agentPromptOutput: node['prompt-output'] || '',
    agentStatusPath: (node.outputs as { status?: { path?: string } } | undefined)?.status?.path || '',
    deterministicHandler: node.handler || '',
    deterministicNext: node.next || '',
    processCommand: Array.isArray(node.command) ? node.command.join(' ') : '',
    processInputMode: node['input-mode'] || ':json-stdin',
    processOutputMode: node['output-mode'] || ':json-stdout',
    processNext: node.next || '',
    timerDuration: node.duration || '30s',
    timerNext: node.next || '',
    approvalMessage: node.message || '',
    terminalStatus: node.status || ':success',
    transitions: node.transitions
  };
};

const WhenEditor = ({ value, onChange }: { value: WhenMap; onChange: (next: WhenMap) => void }) => (
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

const NodeForm = ({ form, setForm, draft, excludeId, onCompose }: { form: NodeFormState; setForm: React.Dispatch<React.SetStateAction<NodeFormState>>; draft: StudioWorkflow; excludeId?: string; onCompose?: () => void }) => {
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
      <div className="row"><label>ID (state keyword)</label><input type="text" value={form.id} onChange={(e) => set({ id: e.target.value })} placeholder="e.g. start" required pattern="[a-z][a-z0-9-]{0,62}" /></div>
      <div className="row"><label>Title</label><input type="text" value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="optional" /></div>
      {form.type === ':agent' && (
        <>
          <div className="row"><label>Executor</label><input type="text" value={form.agentExecutor} onChange={(e) => set({ agentExecutor: e.target.value })} placeholder=":pi-cli" /></div>
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
      {form.type === ':deterministic' && (
        <>
          <div className="row"><label>Handler</label>
            <select value={KNOWN_HANDLERS.includes(form.deterministicHandler) ? form.deterministicHandler : CUSTOM_HANDLER_SENTINEL}
              onChange={(e) => set({ deterministicHandler: e.target.value === CUSTOM_HANDLER_SENTINEL ? '' : e.target.value })}>
              {KNOWN_HANDLERS.map((h) => <option key={h} value={h}>{h}</option>)}
              <option value={CUSTOM_HANDLER_SENTINEL}>Custom…</option>
            </select>
            {!KNOWN_HANDLERS.includes(form.deterministicHandler) && (
              <input type="text" className="mt" value={form.deterministicHandler} onChange={(e) => set({ deterministicHandler: e.target.value })} placeholder=":my-org/my-handler" />
            )}
          </div>
          <div className="row"><label>Next state</label><select value={form.deterministicNext} onChange={(e) => set({ deterministicNext: e.target.value })}><option value="">(none)</option>{otherNodeIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></div>
        </>
      )}
      {form.type === ':process' && (
        <>
          <div className="row"><label>Command (space-separated)</label><input type="text" value={form.processCommand} onChange={(e) => set({ processCommand: e.target.value })} placeholder="node scripts/x.js" /></div>
          <div className="row"><label>Input mode</label><input type="text" value={form.processInputMode} onChange={(e) => set({ processInputMode: e.target.value })} /></div>
          <div className="row"><label>Output mode</label><input type="text" value={form.processOutputMode} onChange={(e) => set({ processOutputMode: e.target.value })} /></div>
          <div className="row"><label>Next state</label><select value={form.processNext} onChange={(e) => set({ processNext: e.target.value })}><option value="">(none)</option>{otherNodeIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></div>
        </>
      )}
      {form.type === ':timer' && (
        <>
          <div className="row"><label>Duration</label><input type="text" value={form.timerDuration} onChange={(e) => set({ timerDuration: e.target.value })} placeholder="30s" /></div>
          <div className="row"><label>Next state</label><select value={form.timerNext} onChange={(e) => set({ timerNext: e.target.value })}><option value="">(none)</option>{otherNodeIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></div>
        </>
      )}
      {form.type === ':approval' && (
        <>
          <div className="row"><label>Message</label><input type="text" value={form.approvalMessage} onChange={(e) => set({ approvalMessage: e.target.value })} placeholder="Approve this change?" /></div>
        </>
      )}
      {form.type === ':terminal' && (
        <div className="row"><label>Status</label><select value={form.terminalStatus} onChange={(e) => set({ terminalStatus: e.target.value })}><option value=":success">:success</option><option value=":failure">:failure</option></select></div>
      )}
      {(form.type === ':agent' || form.type === ':approval' || form.type === ':router') && (
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

const CreateWorkflowModal = ({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, description?: string) => Promise<void> }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <ModalShell title="Create workflow" onClose={onClose}>
      <div className="row"><label>Name (lowercase, hyphens)</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} required pattern="[a-z][a-z0-9-]{0,62}" /></div>
      <div className="row"><label>Description (optional)</label><input type="text" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      {error && <div className="error">{error}</div>}
      <div className="modal-actions">
        <button type="button" disabled={busy || !stateIdRe.test(name)} onClick={async () => { setBusy(true); setError(null); try { await onCreate(name, description || undefined); } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); } }}>Create</button>
        <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </ModalShell>
  );
};

const ModalShell = ({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) => {
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

const LintMessageList = ({ report }: { report: LintReport | null }) => {
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

export const WorkflowStudio = ({ initialWorkflowName, onExit, onWorkflowsChanged }: Props) => {
  const [draft, setDraft] = useState<StudioWorkflow | null>(null);
  const [positions, setPositions] = useState<StudioPositions>({});
  const [dirty, setDirty] = useState(false);
  const [lint, setLint] = useState<LintReport | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [menu, setMenu] = useState<ContextMenu>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [whenForConnect, setWhenForConnect] = useState<WhenMap>({});
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [connectTarget, setConnectTarget] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(initialWorkflowName);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);

  // Load workflow by name.
  const load = useCallback(async (workflowName: string): Promise<void> => {
    setError(null);
    try {
      const res = await getStudioWorkflow(workflowName);
      const loaded = res.state.draft || emptyDraft(workflowName);
      setDraft(loaded);
      setPositions(res.state.positions || {});
      setLint(res.state.lint || null);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDraft(emptyDraft(workflowName));
    }
  }, []);

  useEffect(() => { if (name) void load(name); }, [name, load]);

  const graphNodes = useMemo(() => (draft ? toGraphNodes(draft) : []), [draft]);
  const graphEdges = useMemo(() => (draft ? toGraphEdges(draft) : []), [draft]);

  const positionedNodes = useMemo(() => {
    return graphNodes.map((node, i) => {
      const p = positions[node.id];
      if (p) return { ...node, x: p.x, y: p.y };
      const col = i % 4;
      const row = Math.floor(i / 4);
      return { ...node, x: CANVAS_PAD + col * 200, y: CANVAS_PAD + row * 100 };
    });
  }, [graphNodes, positions]);

  const maxX = positionedNodes.reduce((m, n) => Math.max(m, n.x + NODE_W), 600);
  const maxY = positionedNodes.reduce((m, n) => Math.max(m, n.y + NODE_H), 400);

  const updateNode = useCallback((id: string, patch: Partial<StudioNode>): void => {
    setDraft((prev) => prev ? { ...prev, states: { ...prev.states, [id]: { ...prev.states[id], ...patch } } } : prev);
    setDirty(true);
  }, []);

  const removeNode = useCallback((id: string): void => {
    setDraft((prev) => {
      if (!prev) return prev;
      const states = { ...prev.states };
      delete states[id];
      // remove transitions/next pointing to it
      for (const nid of Object.keys(states)) {
        const n = states[nid];
        if (n.transitions) states[nid] = { ...n, transitions: n.transitions.filter((t) => t.next !== id).map((t) => t) };
        if (n.next === id) states[nid] = { ...n, next: undefined };
      }
      let initial = prev.initial;
      if (initial === id) initial = null;
      return { ...prev, states, initial };
    });
    setPositions((prev) => { const next = { ...prev }; delete next[id]; return next; });
    setDirty(true);
  }, []);

  const addNodeFromForm = useCallback((form: NodeFormState): string | null => {
    if (!stateIdRe.test(form.id)) return 'ID must match /^[a-z][a-z0-9-]{0,62}$/';
    setDraft((prev) => {
      if (!prev) return prev;
      const fields = buildNodeFields(form);
      const node: StudioNode = { id: form.id, type: form.type, ...fields } as StudioNode;
      const states = { ...prev.states, [form.id]: node };
      // Auto-set initial to first node if none set
      let initial = prev.initial;
      if (!initial) initial = form.id;
      return { ...prev, states, initial };
    });
    // place near center top
    setPositions((prev) => ({ ...prev, [form.id]: { x: CANVAS_PAD + (Object.keys(prev).length % 4) * 200, y: CANVAS_PAD + Math.floor(Object.keys(prev).length / 4) * 100 } }));
    setDirty(true);
    return null;
  }, []);

  const editNodeFromForm = useCallback((id: string, form: NodeFormState): string | null => {
    if (id !== form.id && !stateIdRe.test(form.id)) return 'ID must match /^[a-z][a-z0-9-]{0,62}$/';
    setDraft((prev) => {
      if (!prev) return prev;
      const fields = buildNodeFields(form);
      const node: StudioNode = { id: form.id, type: form.type, ...fields } as StudioNode;
      const states = { ...prev.states };
      if (id !== form.id) {
        delete states[id];
        // rewire references
        for (const nid of Object.keys(states)) {
          const n = states[nid];
          if (n.next === id) states[nid] = { ...n, next: form.id };
          if (n.transitions) states[nid] = { ...n, transitions: n.transitions.map((t) => t.next === id ? { ...t, next: form.id } : t) };
        }
        let initial = prev.initial;
        if (initial === id) initial = form.id;
        return { ...prev, states: { ...states, [form.id]: node }, initial };
      }
      return { ...prev, states: { ...states, [form.id]: node } };
    });
    setPositions((prev) => {
      if (id !== form.id) { const next = { ...prev }; next[form.id] = next[id] || { x: CANVAS_PAD, y: CANVAS_PAD }; delete next[id]; return next; }
      return prev;
    });
    setDirty(true);
    return null;
  }, []);

  const addTransition = useCallback((fromId: string, toId: string, when: WhenMap): void => {
    setDraft((prev) => {
      if (!prev) return prev;
      const node = prev.states[fromId];
      if (!node) return prev;
      const transition: Transition = { when, next: toId };
      // For nodes that used :next shorthand, convert to transitions (or keep next if no when)
      if (when && Object.keys(when).length > 0) {
        const transitions = [...(node.transitions || [])];
        // drop existing same target/when
        const filtered = transitions.filter((t) => !(t.next === toId));
        filtered.push(transition);
        const newNode: StudioNode = { ...node, transitions: filtered, next: undefined };
        return { ...prev, states: { ...prev.states, [fromId]: newNode } };
      }
      // else: simple next
      const newNode: StudioNode = { ...node, next: toId, transitions: undefined };
      return { ...prev, states: { ...prev.states, [fromId]: newNode } };
    });
    setDirty(true);
  }, []);

  const removeEdge = useCallback((fromId: string, toId: string, condition: unknown): void => {
    setDraft((prev) => {
      if (!prev) return prev;
      const node = prev.states[fromId];
      if (!node) return prev;
      if (node.transitions) {
        const cond = JSON.stringify(condition);
        const transitions = node.transitions.filter((t) => !(t.next === toId && JSON.stringify(t.when) === cond));
        return { ...prev, states: { ...prev.states, [fromId]: { ...node, transitions } } };
      }
      if (node.next === toId) return { ...prev, states: { ...prev.states, [fromId]: { ...node, next: undefined } } };
      return prev;
    });
    setDirty(true);
  }, []);

  const editEdgeWhen = useCallback((fromId: string, toId: string, oldCondition: unknown, when: WhenMap): void => {
    setDraft((prev) => {
      if (!prev) return prev;
      const node = prev.states[fromId];
      if (!node) return prev;
      if (node.transitions) {
        const cond = JSON.stringify(oldCondition);
        const transitions = node.transitions.map((t) => t.next === toId && JSON.stringify(t.when) === cond ? { ...t, when } : t);
        return { ...prev, states: { ...prev.states, [fromId]: { ...node, transitions } } };
      }
      if (node.next === toId) {
        return { ...prev, states: { ...prev.states, [fromId]: { ...node, next: undefined, transitions: [{ when, next: toId }] } } };
      }
      return prev;
    });
    setDirty(true);
  }, []);

  // ---- Drag handlers ----
  const onNodePointerDown = (e: React.PointerEvent, nodeId: string): void => {
    if (connectFrom) return; // in connect mode, click selects target
    e.preventDefault();
    const node = positionedNodes.find((n) => n.id === nodeId);
    if (!node) return;
    const svgRect = svgRef.current?.getBoundingClientRect();
    if (!svgRect) return;
    const scaleX = svgRect.width / (maxX || 1);
    const scaleY = svgRect.height / (maxY || 1);
    dragRef.current = { id: nodeId, offsetX: e.clientX - svgRect.left - node.x * scaleX, offsetY: e.clientY - svgRect.top - node.y * scaleY };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onSvgPointerMove = (e: React.PointerEvent): void => {
    if (!dragRef.current) return;
    const svgRect = svgRef.current?.getBoundingClientRect();
    if (!svgRect) return;
    const scaleX = (maxX || 1) / svgRect.width;
    const scaleY = (maxY || 1) / svgRect.height;
    const x = (e.clientX - svgRect.left - dragRef.current.offsetX) * scaleX;
    const y = (e.clientY - svgRect.top - dragRef.current.offsetY) * scaleY;
    setPositions((prev) => ({ ...prev, [dragRef.current!.id]: { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) } }));
  };
  const onSvgPointerUp = (): void => { dragRef.current = null; };

  // ---- Context menus ----
  const onNodeContextMenu = (e: React.MouseEvent, nodeId: string): void => {
    e.preventDefault();
    setMenu({ kind: 'node', x: e.clientX, y: e.clientY, nodeId });
  };
  const onEdgeContextMenu = (e: React.MouseEvent, edge: GraphEdge): void => {
    e.preventDefault();
    setMenu({ kind: 'edge', x: e.clientX, y: e.clientY, edge });
  };

  // Close menu on outside click / escape
  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey); };
  }, [menu]);

  // ---- Save ----
  const parseEdnDraft = (edn: string): StudioWorkflow | null => {
    // Naive: we don't parse EDN; rely on server sidecar draft. For reloads we
    // use the sidecar. Returning null means "use sidecar".
    void edn;
    return null;
  };
  void parseEdnDraft;

  const doSave = async (mode: 'draft' | 'completed'): Promise<void> => {
    if (!draft || !name) return;
    setSaving(true); setError(null);
    try {
      const result: SaveStudioResult = await saveStudioWorkflow(name, draft, positions, mode);
      if (result.ok) {
        setLint(result.lint);
        setDirty(false);
        setToast(mode === 'completed' ? 'Saved completed (lint passed).' : 'Saved draft.');
        onWorkflowsChanged();
      } else {
        setLint(result.lint);
        setError('Save completed blocked by linter. See issues below.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
      setTimeout(() => setToast(null), 2500);
    }
  };

  const doLintPreview = async (): Promise<void> => {
    if (!name) return;
    try {
      const report = await lintStudioWorkflow(name);
      setLint(report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const clearCanvas = (): void => {
    if (!draft) return;
    if (!window.confirm('Clear the canvas? Unsaved changes will be lost. This does not delete a saved file.')) return;
    setDraft({ ...draft, states: {}, initial: null });
    setPositions({});
    setDirty(true);
    setLint(null);
  };

  const onCreate = async (newName: string, description?: string): Promise<void> => {
    await createStudioWorkflow(newName, description);
    onWorkflowsChanged();
    setName(newName);
    setModal(null);
  };

  const handleCanvasClick = (e: React.MouseEvent): void => {
    if (!connectFrom) return;
    // Only treat a click on the SVG background itself as a backdrop cancel.
    // A click on a node hitbox button bubbles here too; node handler stops
    // propagation, so this guard is a secondary safeguard.
    if (e.target !== e.currentTarget) return;
    setConnectFrom(null);
  };

  const onNodeClickDuringConnect = (nodeId: string): void => {
    if (!connectFrom) return;
    if (connectFrom === nodeId) { setConnectFrom(null); return; }
    setWhenForConnect({});
    setConnectTarget(nodeId);
    setShowConnectModal(true);
  };

  if (!draft) {
    return (
      <section className="panel detail">
        <h2>Workflow Studio</h2>
        {error && <div className="error">{error}</div>}
        <button type="button" onClick={() => setModal({ kind: 'create' })}>Create workflow</button>
        {modal?.kind === 'create' && <CreateWorkflowModal onClose={() => setModal(null)} onCreate={onCreate} />}
        <button type="button" onClick={onExit}>Back to workflows</button>
      </section>
    );
  }

  return (
    <section className="panel detail studio" aria-label="Workflow Studio">
      <div className="studio-header">
        <h2>Workflow Studio — {draft.metadata.name}{dirty ? ' ·' : ''}</h2>
        <div className="studio-toolbar">
          <button type="button" onClick={() => setModal({ kind: 'addNode' })}>Add node</button>
          <button type="button" onClick={() => doSave('draft')} disabled={saving}>Save draft</button>
          <button type="button" onClick={() => void doSave('completed')} disabled={saving}>Save completed</button>
          <button type="button" onClick={doLintPreview}>Lint preview</button>
          <button type="button" onClick={clearCanvas}>Clear canvas</button>
          <button type="button" onClick={() => setModal({ kind: 'create' })}>New workflow</button>
          <button type="button" onClick={onExit}>Back</button>
        </div>
      </div>
      {connectFrom && <div className="studio-banner">Connecting from <strong>{connectFrom}</strong> — click a target node. <button type="button" className="link" onClick={() => setConnectFrom(null)}>Cancel</button></div>}
      {error && <div className="error">{error}</div>}
      {toast && <div className="toast">{toast}</div>}
      <LintMessageList report={lint} />

      <div className="graph-canvas studio-canvas" data-testid="studio-canvas">
        <svg ref={svgRef} viewBox={`0 0 ${maxX} ${maxY}`} role="img" aria-label="Workflow Studio canvas" onClick={handleCanvasClick} onPointerMove={onSvgPointerMove} onPointerUp={onSvgPointerUp}>
          <defs>
            <marker id="studio-arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L0,6 L9,3 z" />
            </marker>
          </defs>
          {graphEdges.map((edge) => {
            const from = positionedNodes.find((n) => n.id === edge.from);
            const to = positionedNodes.find((n) => n.id === edge.to);
            if (!from || !to) return null;
            const cond = edge.condition;
            const condStr = cond && typeof cond === 'object' ? JSON.stringify(cond) : (typeof cond === 'string' ? cond : '');
            const midX = (from.x + NODE_W + to.x) / 2;
            const midY = (from.y + to.y) / 2 - 8;
            return (
              <g key={`${edge.from}-${edge.to}-${condStr}`} className="graph-edge studio-edge" onContextMenu={(e) => onEdgeContextMenu(e, edge)} style={{ cursor: 'context-menu' }}>
                <line x1={from.x + NODE_W} y1={from.y + NODE_H / 2} x2={to.x} y2={to.y + NODE_H / 2} markerEnd="url(#studio-arrow)" />
                {condStr && <text x={midX} y={midY}>{condStr}</text>}
              </g>
            );
          })}
          {positionedNodes.map((node) => (
            <g key={node.id} className={`graph-node studio-node${connectFrom === node.id ? ' active' : ''}`} transform={`translate(${node.x} ${node.y})`} style={{ cursor: connectFrom ? 'pointer' : 'grab' }} onContextMenu={(e) => onNodeContextMenu(e, node.id)}>
              <rect width={NODE_W} height={NODE_H} rx="10" />
              <text x="14" y="24" className="node-title">{node.title || node.id}</text>
              <text x="14" y="43" className="node-type">{node.type || 'node'}</text>
              <foreignObject x="0" y="0" width={NODE_W} height={NODE_H}>
                <button className="node-hitbox" type="button" aria-label={`Node ${node.id}`}
                  onPointerDown={(e) => onNodePointerDown(e, node.id)}
                  onClick={(e) => { if (connectFrom) { e.stopPropagation(); onNodeClickDuringConnect(node.id); } }}
                />
              </foreignObject>
            </g>
          ))}
        </svg>
      </div>

      {/* Node context menu */}
      {menu?.kind === 'node' && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={() => { setModal({ kind: 'editNode', nodeId: menu.nodeId }); setMenu(null); }}>Edit</button>
          <button type="button" onClick={() => { if (window.confirm(`Delete node ${menu.nodeId}?`)) removeNode(menu.nodeId); setMenu(null); }}>Delete</button>
          <button type="button" onClick={() => { setConnectFrom(menu.nodeId); setMenu(null); }}>Connect</button>
        </div>
      )}
      {/* Edge context menu */}
      {menu?.kind === 'edge' && (
        <EdgeMenu menu={menu} draft={draft} onClose={() => setMenu(null)} onDelete={() => removeEdge(menu.edge.from, menu.edge.to, menu.edge.condition)} onEdit={(when) => editEdgeWhen(menu.edge.from, menu.edge.to, menu.edge.condition, when)} />
      )}

      {/* Add/Edit node modal */}
      {modal?.kind === 'addNode' && (
        <NodeFormModal title="Add node" draft={draft} initial={emptyForm(':deterministic')} onClose={() => setModal(null)}
          onSubmit={(form) => { const err = addNodeFromForm(form); if (err) return err; setModal(null); return null; }} />
      )}
      {modal?.kind === 'editNode' && modal.nodeId && draft.states[modal.nodeId] && (
        <NodeFormModal title={`Edit node: ${modal.nodeId}`} draft={draft} initial={formFromNode(draft.states[modal.nodeId])} excludeId={modal.nodeId} onClose={() => setModal(null)}
          onSubmit={(form) => { const err = editNodeFromForm(modal.nodeId, form); if (err) return err; setModal(null); return null; }} />
      )}

      {/* Connect: when editor modal */}
      {showConnectModal && connectFrom && connectTarget && (
        <ModalShell title={`Connect ${connectFrom} → ${connectTarget}`} onClose={() => { setShowConnectModal(false); setConnectFrom(null); setConnectTarget(null); }}>
          <p>Set the <code>:when</code> condition for this transition.</p>
          <WhenEditor value={whenForConnect} onChange={setWhenForConnect} />
          <div className="modal-actions">
            <button type="button" onClick={() => { addTransition(connectFrom, connectTarget, whenForConnect); setShowConnectModal(false); setConnectFrom(null); setConnectTarget(null); }}>Connect</button>
            <button type="button" onClick={() => { setShowConnectModal(false); setConnectFrom(null); setConnectTarget(null); }}>Cancel</button>
          </div>
        </ModalShell>
      )}

      {/* New workflow modal */}
      {modal?.kind === 'create' && <CreateWorkflowModal onClose={() => setModal(null)} onCreate={onCreate} />}
    </section>
  );
};

// Bespoke Pi-session chat surface for drafting an agent-node prompt template.
// Creates a Pi session on open, seeds it with a prompt-engineering instruction,
// streams the assistant draft, and lets the user accept the draft and save it
// to the workflow package as a `.md.tmpl` asset. The server asset route is the
// write authority; the node's `:prompt-template` field is set to that path.
const COMPOSE_SEED = (title: string, nodeId: string): string =>
  `Draft a Tesseraft agent-node prompt template for a workflow node titled "${title || nodeId}" (id: ${nodeId}) of type :agent. ` +
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
        const snap = JSON.parse((event as MessageEvent).data) as { messages?: PiChatMessage[] };
        setMessages(snap.messages || []);
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
  const hasNoDraft = !busy && messages.length > 0 && !lastAssistant && !piError;

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

const NodeFormModal = ({ title, draft, initial, excludeId, onClose, onSubmit }: { title: string; draft: StudioWorkflow; initial: NodeFormState; excludeId?: string; onClose: () => void; onSubmit: (form: NodeFormState) => string | null }) => {
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
      <div className="row"><label>Node type</label>
        <select value={form.type} onChange={(e) => { const t = e.target.value as NodeTypeId; setForm((prev) => ({ ...emptyForm(t), id: prev.id, title: prev.id ? titleFromId(prev.id) : '' })); rederive(form.id, t, true); }}>
          {NODE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <NodeForm form={form} setForm={setFormTracked} draft={draft} excludeId={excludeId} onCompose={() => setComposerOpen(true)} />
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

const EdgeMenu = ({ menu, draft, onClose, onDelete, onEdit }: { menu: Extract<ContextMenu, { kind: 'edge' }>; draft: StudioWorkflow; onClose: () => void; onDelete: () => void; onEdit: (when: WhenMap) => void }) => {
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