import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { GraphEdge } from '../lib/graphLayout';
import { createStudioWorkflow, getStudioWorkflow, lintStudioWorkflow, saveStudioWorkflow, type SaveStudioResult } from '../lib/studio';
import { getJson } from '../lib/api';
import { emptyDraft, type WhenMap } from '../types/studio';
import {
  CANVAS_PAD, NODE_H, NODE_W, emptyForm, formFromNode,
  initialStudioDocument, stateIdRe, studioDocumentReducer, toGraphEdges, toGraphNodes,
  type CapabilitiesResponse, type NodeFormState
} from '../features/studio/model';
import { CreateWorkflowModal, EdgeMenu, LintMessageList, ModalShell, NodeFormModal, WhenEditor } from '../features/studio/StudioDialogs';

type ContextMenu =
  | { kind: 'node'; x: number; y: number; nodeId: string }
  | { kind: 'edge'; x: number; y: number; edge: GraphEdge }
  | null;

type Modal = { kind: 'create' } | { kind: 'addNode' } | { kind: 'editNode'; nodeId: string } | null;

type Props = {
  initialWorkflowName: string | null;
  onExit: () => void;
  onWorkflowsChanged: () => void;
};
export const WorkflowStudio = ({ initialWorkflowName, onExit, onWorkflowsChanged }: Props) => {
  const [document, dispatch] = useReducer(studioDocumentReducer, initialStudioDocument);
  const { draft, positions, dirty, lint } = document;
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
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse>({ node_types: [], handlers: [], executors: [] });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getJson<CapabilitiesResponse>('/api/capabilities')
      .then((response) => { if (!cancelled) setCapabilities(response); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, []);

  // Load workflow by name.
  const load = useCallback(async (workflowName: string): Promise<void> => {
    setError(null);
    try {
      const res = await getStudioWorkflow(workflowName);
      const loaded = res.state.draft || res.workflow.normalized || emptyDraft(workflowName);
      dispatch({ type: 'loaded', draft: loaded, positions: res.state.positions, lint: res.state.lint });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      dispatch({ type: 'loaded', draft: emptyDraft(workflowName) });
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

  const removeNode = useCallback((id: string): void => {
    dispatch({ type: 'remove-node', id });
  }, []);

  const addNodeFromForm = useCallback((form: NodeFormState): string | null => {
    if (!stateIdRe.test(form.id)) return 'ID must match /^[a-z][a-z0-9-]{0,62}$/';
    dispatch({ type: 'add-node', form });
    return null;
  }, []);

  const editNodeFromForm = useCallback((id: string, form: NodeFormState): string | null => {
    if (id !== form.id && !stateIdRe.test(form.id)) return 'ID must match /^[a-z][a-z0-9-]{0,62}$/';
    dispatch({ type: 'edit-node', id, form });
    return null;
  }, []);

  const addTransition = useCallback((fromId: string, toId: string, when: WhenMap): void => {
    dispatch({ type: 'add-transition', fromId, toId, when });
  }, []);

  const removeEdge = useCallback((fromId: string, toId: string, condition: unknown): void => {
    dispatch({ type: 'remove-edge', fromId, toId, condition });
  }, []);

  const editEdgeWhen = useCallback((fromId: string, toId: string, oldCondition: unknown, when: WhenMap): void => {
    dispatch({ type: 'edit-edge', fromId, toId, oldCondition, when });
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
    dispatch({ type: 'move-node', id: dragRef.current.id, x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) });
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
  const doSave = async (mode: 'draft' | 'completed'): Promise<void> => {
    if (!draft || !name) return;
    setSaving(true); setError(null);
    try {
      const result: SaveStudioResult = await saveStudioWorkflow(name, draft, positions, mode);
      if (result.ok) {
        dispatch({ type: 'saved', lint: result.lint });
        setToast(mode === 'completed' ? 'Saved completed (lint passed).' : 'Saved draft.');
        onWorkflowsChanged();
      } else {
        dispatch({ type: 'linted', lint: result.lint });
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
      if (!draft) return;
      const report = await lintStudioWorkflow(name, draft);
      dispatch({ type: 'linted', lint: report });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const clearCanvas = (): void => {
    if (!draft) return;
    if (!window.confirm('Clear the canvas? Unsaved changes will be lost. This does not delete a saved file.')) return;
    dispatch({ type: 'clear' });
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
        <NodeFormModal title="Add node" draft={draft} nodeTypes={capabilities.node_types} handlers={capabilities.handlers} executors={capabilities.executors} initial={emptyForm('deterministic')} onClose={() => setModal(null)}
          onSubmit={(form) => { const err = addNodeFromForm(form); if (err) return err; setModal(null); return null; }} />
      )}
      {modal?.kind === 'editNode' && modal.nodeId && draft.states[modal.nodeId] && (
        <NodeFormModal title={`Edit node: ${modal.nodeId}`} draft={draft} nodeTypes={capabilities.node_types} handlers={capabilities.handlers} executors={capabilities.executors} initial={formFromNode(draft.states[modal.nodeId])} excludeId={modal.nodeId} onClose={() => setModal(null)}
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
