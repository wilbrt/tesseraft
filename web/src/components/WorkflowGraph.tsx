import React, { useMemo, useState } from 'react';
import { layoutGraph, type GraphEdge, type GraphNode } from '../lib/graphLayout';

type Props = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export const WorkflowGraph = ({ nodes, edges }: Props) => {
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const layout = useMemo(() => layoutGraph(nodes, edges), [nodes, edges]);

  return (
    <section className="graph-section" aria-label="Workflow graph">
      <h3>Workflow graph</h3>
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
            {layout.edges.map((edge) => (
              <g key={`${edge.from}-${edge.to}-${edge.condition || ''}`} className="graph-edge">
                <line x1={edge.fromX} y1={edge.fromY} x2={edge.toX} y2={edge.toY} markerEnd="url(#arrow)" />
                {edge.condition && (
                  <text x={(edge.fromX + edge.toX) / 2} y={(edge.fromY + edge.toY) / 2 - 8}>{edge.condition}</text>
                )}
              </g>
            ))}
            {layout.nodes.map((node) => (
              <g key={node.id} className="graph-node" transform={`translate(${node.x} ${node.y})`}>
                <rect width="150" height="56" rx="10" />
                <text x="14" y="24" className="node-title">{node.title || node.id}</text>
                <text x="14" y="43" className="node-type">{node.type || 'node'}</text>
                <foreignObject x="0" y="0" width="150" height="56">
                  <button className="node-hitbox" type="button" aria-label={`Open node ${node.id} details`} onClick={() => setSelectedNode(node)} />
                </foreignObject>
              </g>
            ))}
          </svg>
        </div>
      )}
      <h3>Graph edges</h3>
      <ul className="item-list compact">
        {edges.length === 0 && <li className="muted">No graph edges found.</li>}
        {edges.map((edge) => (
          <li key={`${edge.from}-${edge.to}-${edge.condition || ''}`}>
            <strong>{edge.from}</strong> → <strong>{edge.to}</strong>{edge.condition ? <span> when {edge.condition}</span> : null}
          </li>
        ))}
      </ul>
      {selectedNode && <NodeModal node={selectedNode} onClose={() => setSelectedNode(null)} />}
    </section>
  );
};

const NodeModal = ({ node, onClose }: { node: GraphNode; onClose: () => void }) => (
  <div className="modal-backdrop" role="presentation" onClick={onClose}>
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Node ${node.id} details`} onClick={(event) => event.stopPropagation()}>
      <div className="modal-header">
        <h2>Node details: {node.id}</h2>
        <button type="button" onClick={onClose} aria-label="Close node details">×</button>
      </div>
      <dl>
        <div className="field-row"><dt>ID</dt><dd>{node.id}</dd></div>
        <div className="field-row"><dt>Type</dt><dd>{String(node.type || '')}</dd></div>
        <div className="field-row"><dt>Title</dt><dd>{String(node.title || '')}</dd></div>
      </dl>
      <h3>Structured JSON</h3>
      <pre>{JSON.stringify(node, null, 2)}</pre>
    </div>
  </div>
);
