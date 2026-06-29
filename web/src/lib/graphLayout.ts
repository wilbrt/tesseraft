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
};

export type GraphLayout = {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  width: number;
  height: number;
};

export const layoutGraph = (nodes: GraphNode[], edges: GraphEdge[]): GraphLayout => {
  const columnWidth = 220;
  const rowHeight = 120;
  const margin = 70;
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

  const positioned = nodes.map((node) => {
    const depth = nodeDepths.get(node.id) || 0;
    const column = columns.get(depth) || [];
    const row = column.findIndex((candidate) => candidate.id === node.id);
    return { ...node, x: margin + depth * columnWidth, y: margin + Math.max(row, 0) * rowHeight };
  });

  const positionById = new Map(positioned.map((node) => [node.id, node]));
  const positionedEdges = edges.flatMap((edge) => {
    const from = positionById.get(edge.from);
    const to = positionById.get(edge.to);
    if (!from || !to) return [];
    return [{ ...edge, fromX: from.x + 150, fromY: from.y + 24, toX: to.x, toY: to.y + 24 }];
  });

  const maxX = positioned.reduce((value, node) => Math.max(value, node.x), margin);
  const maxY = positioned.reduce((value, node) => Math.max(value, node.y), margin);

  return {
    nodes: positioned,
    edges: positionedEdges,
    width: maxX + 220,
    height: maxY + 100
  };
};
