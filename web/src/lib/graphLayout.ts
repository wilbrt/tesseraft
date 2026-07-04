export type GraphNode = {
  id: string;
  type?: string;
  title?: string;
  outputs?: unknown;
  [key: string]: unknown;
};

export type GraphEdge = {
  from: string;
  to: string;
  condition?: unknown;
  [key: string]: unknown;
};

export type PositionedNode = GraphNode & {
  x: number;
  y: number;
};

export type PositionedEdge = GraphEdge & {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** Optional routed SVG path. When present, WorkflowGraph renders a `<path>`
   * instead of a straight `<line>`. Used for back-edges so they do not pass
   * through intermediate nodes. */
  pathD?: string;
};

export type GraphLayout = {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  width: number;
  height: number;
};

// Geometry constants. Node hitbox/rect is 150x56 (see WorkflowGraph.tsx /
// style.css). Smaller column width + vertical wrapping trades horizontal
// sprawl for vertical extent so the graph fills the canvas rather than
// stretching out a single thin row.
const NODE_W = 150;
const NODE_H = 56;
const columnWidth = 180;
const rowHeight = 110;
const margin = 50; // also reserves headroom for back-edge arcs in band 0
const bandGap = 90; // extra vertical gap between wrapped rows of columns
const colsPerRow = 6; // wrap long DAGs into multiple visual rows

export const layoutGraph = (nodes: GraphNode[], edges: GraphEdge[]): GraphLayout => {
  const nodeDepths = new Map<string, number>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, GraphEdge[]>();

  edges.forEach((edge) => {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from)?.push(edge);
  });

  const visit = (id: string, depth: number, seen: Set<string>): void => {
    if (seen.has(id)) return;
    const currentDepth = nodeDepths.get(id);
    if (currentDepth === undefined || depth > currentDepth) nodeDepths.set(id, depth);
    const nextSeen = new Set(seen);
    nextSeen.add(id);
    (outgoing.get(id) || []).forEach((edge) => {
      if (byId.has(edge.to)) visit(edge.to, depth + 1, nextSeen);
    });
  };

  nodes.forEach((node) => {
    if (!edges.some((edge) => edge.to === node.id)) visit(node.id, 0, new Set());
  });
  nodes.forEach((node) => {
    if (!nodeDepths.has(node.id)) visit(node.id, 0, new Set());
  });

  const columns = new Map<number, GraphNode[]>();
  nodes.forEach((node) => {
    const depth = nodeDepths.get(node.id) || 0;
    if (!columns.has(depth)) columns.set(depth, []);
    columns.get(depth)?.push(node);
  });

  // Compute vertical band tops so wrapped rows stack with a generous gap.
  // Each band holds colsPerRow columns; band height = its tallest column.
  const bandRowCount = new Map<number, number>();
  nodes.forEach((node) => {
    const depth = nodeDepths.get(node.id) || 0;
    const band = Math.floor(depth / colsPerRow);
    const colSize = columns.get(depth)?.length || 0;
    bandRowCount.set(band, Math.max(bandRowCount.get(band) || 0, colSize));
  });

  const bandTop = new Map<number, number>();
  let runningTop = margin;
  for (const band of [...bandRowCount.keys()].sort((a, b) => a - b)) {
    bandTop.set(band, runningTop);
    runningTop += (bandRowCount.get(band) || 1) * rowHeight + bandGap;
  }

  const positioned = nodes.map((node) => {
    const depth = nodeDepths.get(node.id) || 0;
    const band = Math.floor(depth / colsPerRow);
    const column = columns.get(depth) || [];
    const rowIdx = Math.max(column.findIndex((candidate) => candidate.id === node.id), 0);
    return {
      ...node,
      x: margin + (depth % colsPerRow) * columnWidth,
      y: (bandTop.get(band) ?? margin) + rowIdx * rowHeight
    };
  });

  const positionById = new Map(positioned.map((node) => [node.id, node]));

  // Index edges per source/target so we can spread fan-out/fan-in endpoints
  // across the node's edge face instead of sharing one midpoint (which made
  // parallel edges overlap into a single line).
  const outgoingByFrom = new Map<string, GraphEdge[]>();
  const incomingByTo = new Map<string, GraphEdge[]>();
  edges.forEach((edge) => {
    if (!outgoingByFrom.has(edge.from)) outgoingByFrom.set(edge.from, []);
    outgoingByFrom.get(edge.from)?.push(edge);
    if (!incomingByTo.has(edge.to)) incomingByTo.set(edge.to, []);
    incomingByTo.get(edge.to)?.push(edge);
  });

  const spreadEndpoint = (count: number, idx: number, nodeY: number): number => {
    if (count <= 1) return nodeY + NODE_H / 2;
    const span = Math.min(NODE_H - 12, (count - 1) * 14);
    const step = span / (count - 1);
    return nodeY + NODE_H / 2 + (-span / 2 + idx * step);
  };

  const positionedEdges = edges.flatMap((edge) => {
    const from = positionById.get(edge.from);
    const to = positionById.get(edge.to);
    if (!from || !to) return [];
    const outList = outgoingByFrom.get(edge.from) || [];
    const inList = incomingByTo.get(edge.to) || [];
    const fromIdx = Math.max(outList.indexOf(edge), 0);
    const toIdx = Math.max(inList.indexOf(edge), 0);
    const fromX = from.x + NODE_W;
    const fromY = spreadEndpoint(outList.length, fromIdx, from.y);
    const toX = to.x;
    const toY = spreadEndpoint(inList.length, toIdx, to.y);

    let pathD: string | undefined;
    if (toX < fromX) {
      // Back-edge (e.g. review → execute on status: fail): route it as a
      // smooth arc above both endpoints so it does not cross through the
      // intermediate columns' nodes. Control points pulled to a peak Y above
      // the node band.
      // Clamp the arc peak to stay inside the viewBox top (y >= 10). For
      // band-0 row-0 nodes the margin (50) plus this clamp keeps the arc
      // visible above the node row without clipping.
      const peakY = Math.max(10, Math.min(from.y, to.y) - 42);
      pathD = `M ${fromX} ${fromY} C ${fromX + 28} ${peakY}, ${toX - 28} ${peakY}, ${toX} ${toY}`;
    }

    return [{ ...edge, fromX, fromY, toX, toY, pathD }];
  });

  const maxX = positioned.reduce((value, node) => Math.max(value, node.x + NODE_W), margin);
  const maxY = positioned.reduce((value, node) => Math.max(value, node.y), margin);

  return {
    nodes: positioned,
    edges: positionedEdges,
    width: maxX + margin,
    height: maxY + NODE_H + margin
  };
};