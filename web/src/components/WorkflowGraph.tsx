import React, { useEffect, useMemo, useState } from 'react';
import { layoutGraph, type GraphEdge, type GraphNode } from '../lib/graphLayout';

type Props = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId?: string | null;
  /** Run's current-state node id; rendered with a distinct `.active` highlight. */
  activeNodeId?: string | null;
  onSelectNode?: (node: GraphNode) => void;
  /** Optional pluggable modal body. When absent, the default workflow-node JSON view is used. */
  renderNodeDetail?: (node: GraphNode) => React.ReactNode;
  /** Optional aria-label overrides for the graph section title and svg. */
  sectionLabel?: string;
};

export const formatCondition = (condition: unknown): string => {
  if (condition === undefined || condition === null || condition === false) return '';
  if (typeof condition === 'string') return condition;
  if (typeof condition === 'number' || typeof condition === 'boolean') return String(condition);
  return JSON.stringify(condition);
};

export const WorkflowGraph = ({ nodes, edges, selectedNodeId = null, activeNodeId = null, onSelectNode, renderNodeDetail, sectionLabel = 'Workflow graph' }: Props) => {
  const [modalNodeId, setModalNodeId] = useState<string | null>(null);
  const layout = useMemo(() => layoutGraph(nodes, edges), [nodes, edges]);
  const modalNode = useMemo(() => modalNodeId ? nodes.find((node) => node.id === modalNodeId) || null : null, [modalNodeId, nodes]);

  return (
    <section className="graph-section" aria-label={sectionLabel}>
      <h3>{sectionLabel}</h3>
      {nodes.length === 0 ? (
        <p className="muted">No graph nodes found.</p>
      ) : (
        <div className="graph-canvas" data-testid="workflow-graph">
          <svg viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="Visual workflow node and edge graph">
            <defs>
              <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L0,6 L9,3 z" />
              </marker>
            </defs>
            {layout.edges.map((edge) => {
              const condition = formatCondition(edge.condition);
              return (
                <g key={`${edge.from}-${edge.to}-${condition}`} className="graph-edge">
                  <line x1={edge.fromX} y1={edge.fromY} x2={edge.toX} y2={edge.toY} markerEnd="url(#arrow)" />
                  {condition && (
                    <text x={(edge.fromX + edge.toX) / 2} y={(edge.fromY + edge.toY) / 2 - 8}>{condition}</text>
                  )}
                </g>
              );
            })}
            {layout.nodes.map((node) => (
              <g key={node.id} className={`graph-node${selectedNodeId === node.id ? ' selected' : ''}${activeNodeId === node.id ? ' active' : ''}`} transform={`translate(${node.x} ${node.y})`}>
                <rect width="150" height="56" rx="10" />
                <text x="14" y="24" className="node-title">{node.title || node.id}</text>
                <text x="14" y="43" className="node-type">{node.type || 'node'}</text>
                <foreignObject x="0" y="0" width="150" height="56">
                  <button className="node-hitbox" type="button" aria-label={`Open node ${node.id} details`} onClick={() => { onSelectNode?.(node); setModalNodeId(node.id); }} />
                </foreignObject>
              </g>
            ))}
          </svg>
        </div>
      )}
      <h3>Graph edges</h3>
      <ul className="item-list compact">
        {edges.length === 0 && <li className="muted">No graph edges found.</li>}
        {edges.map((edge) => {
          const condition = formatCondition(edge.condition);
          return (
            <li key={`${edge.from}-${edge.to}-${condition}`}>
              <strong>{edge.from}</strong> → <strong>{edge.to}</strong>{condition ? <span> when {condition}</span> : null}
            </li>
          );
        })}
      </ul>
      {modalNode && <NodeModal node={modalNode} onClose={() => setModalNodeId(null)} renderNodeDetail={renderNodeDetail} />}
    </section>
  );
};

const NodeModal = ({ node, onClose, renderNodeDetail }: { node: GraphNode; onClose: () => void; renderNodeDetail?: (node: GraphNode) => React.ReactNode }) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Node ${node.id} details`} onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>Node details: {node.id}</h2>
          <button type="button" onClick={onClose} aria-label="Close node details">×</button>
        </div>
        {renderNodeDetail ? renderNodeDetail(node) : (
          <>
            <dl>
              <div className="field-row"><dt>ID</dt><dd>{node.id}</dd></div>
              <div className="field-row"><dt>Type</dt><dd>{String(node.type || '')}</dd></div>
              <div className="field-row"><dt>Title</dt><dd>{String(node.title || '')}</dd></div>
            </dl>
            {'resources' in node && node.resources ? (
              <>
                <h3>Resources</h3>
                <pre>{JSON.stringify(node.resources, null, 2)}</pre>
              </>
            ) : null}
            <h3>Structured JSON</h3>
            <pre>{JSON.stringify(node, null, 2)}</pre>
          </>
        )}
      </div>
    </div>
  );
};