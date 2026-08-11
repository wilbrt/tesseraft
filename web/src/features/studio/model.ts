import type { GraphEdge, GraphNode } from '../../lib/graphLayout';
import type {
  LintReport,
  NodeTypeId,
  StudioNode,
  StudioPositions,
  StudioWorkflow,
  Transition,
  WhenMap
} from '../../types/studio';

export const NODE_W = 150;
export const NODE_H = 56;
export const CANVAS_PAD = 40;
export const stateIdRe = /^[a-z][a-z0-9-]{0,62}$/;

export type CapabilityHandler = { id: string; label: string; 'deprecated?'?: boolean };
export type CapabilityExecutor = { id: string; label: string; 'dispatchable?'?: boolean; availability?: { status?: string } };
export type CapabilityNodeType = { id: NodeTypeId; label: string };
export type CapabilitiesResponse = { node_types: CapabilityNodeType[]; handlers: CapabilityHandler[]; executors: CapabilityExecutor[] };

export type NodeFormState = {
  id: string;
  type: NodeTypeId;
  title: string;
  agentExecutor: string;
  agentPromptTemplate: string;
  agentPromptOutput: string;
  agentStatusPath: string;
  deterministicHandler: string;
  deterministicNext: string;
  processCommand: string;
  processInputMode: string;
  processOutputMode: string;
  processNext: string;
  timerDuration: string;
  timerNext: string;
  approvalMessage: string;
  terminalStatus: string;
  transitions: Transition[] | undefined;
};

export const toGraphNodes = (draft: StudioWorkflow): GraphNode[] =>
  Object.entries(draft.states).map(([id, node]) => ({
    id,
    type: node.type,
    title: node.title || id,
    resources: undefined,
    outputs: undefined
  }));

export const toGraphEdges = (draft: StudioWorkflow): GraphEdge[] => {
  const edges: GraphEdge[] = [];
  for (const [id, node] of Object.entries(draft.states)) {
    if (node.transitions) {
      for (const transition of node.transitions) {
        edges.push({ from: id, to: transition.next, condition: transition.when || undefined });
      }
    } else if (node.next) {
      edges.push({ from: id, to: node.next, condition: undefined });
    }
  }
  return edges;
};

export const defaultPathsFor = (id: string, type: NodeTypeId): Partial<Record<keyof NodeFormState, string>> => {
  if (!id) return {};
  switch (type) {
    case 'agent':
      return {
        agentPromptTemplate: `prompts/${id}.md.tmpl`,
        agentPromptOutput: `prompts/generated/${id}.md`,
        agentStatusPath: `status/${id}-status.json`
      };
    case 'process': return { processCommand: `node scripts/${id}.js` };
    case 'approval': return { approvalMessage: `Approve ${id}?` };
    default: return {};
  }
};

export const titleFromId = (id: string): string =>
  id ? id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' ') : '';

export const buildNodeFields = (form: NodeFormState): Partial<StudioNode> => {
  const node: Partial<StudioNode> = { id: form.id, type: form.type, title: form.title || undefined };
  switch (form.type) {
    case 'agent':
      node.executor = form.agentExecutor || undefined;
      node['prompt-template'] = form.agentPromptTemplate || undefined;
      node['prompt-output'] = form.agentPromptOutput || undefined;
      node.outputs = form.agentStatusPath ? { status: { path: form.agentStatusPath } } : undefined;
      node.transitions = form.transitions || undefined;
      break;
    case 'deterministic':
      node.handler = form.deterministicHandler || undefined;
      node.next = form.deterministicNext || undefined;
      break;
    case 'process':
      node.command = form.processCommand ? form.processCommand.split(/\s+/).filter(Boolean) : undefined;
      node['input-mode'] = form.processInputMode || undefined;
      node['output-mode'] = form.processOutputMode || undefined;
      node.next = form.processNext || undefined;
      break;
    case 'timer':
      node.duration = form.timerDuration || undefined;
      node.next = form.timerNext || undefined;
      break;
    case 'approval':
      node.message = form.approvalMessage || undefined;
      node.transitions = form.transitions || undefined;
      break;
    case 'router': node.transitions = form.transitions || undefined; break;
    case 'terminal': node.status = form.terminalStatus || undefined; break;
  }
  return node;
};

export const AUTO_FIELDS: Array<keyof NodeFormState> = [
  'agentPromptTemplate', 'agentPromptOutput', 'agentStatusPath',
  'processCommand', 'approvalMessage', 'title'
];

export const emptyForm = (type: NodeTypeId): NodeFormState => ({
  id: '', type, title: '', agentExecutor: 'pi-cli', agentPromptTemplate: '',
  agentPromptOutput: '', agentStatusPath: '', deterministicHandler: '',
  deterministicNext: '', processCommand: '', processInputMode: 'json-stdin',
  processOutputMode: 'json-stdout', processNext: '', timerDuration: '30s',
  timerNext: '', approvalMessage: '', terminalStatus: 'success', transitions: undefined
});

export const autoSnapshot = (id: string, type: NodeTypeId): Partial<NodeFormState> => ({
  title: titleFromId(id),
  ...defaultPathsFor(id, type)
});

export const formFromNode = (node: StudioNode): NodeFormState => ({
  ...emptyForm(node.type),
  id: node.id,
  type: node.type,
  title: node.title || '',
  agentExecutor: node.executor || 'pi-cli',
  agentPromptTemplate: node['prompt-template'] || '',
  agentPromptOutput: node['prompt-output'] || '',
  agentStatusPath: (node.outputs as { status?: { path?: string } } | undefined)?.status?.path || '',
  deterministicHandler: node.handler || '',
  deterministicNext: node.next || '',
  processCommand: Array.isArray(node.command) ? node.command.join(' ') : '',
  processInputMode: node['input-mode'] || 'json-stdin',
  processOutputMode: node['output-mode'] || 'json-stdout',
  processNext: node.next || '',
  timerDuration: node.duration || '30s',
  timerNext: node.next || '',
  approvalMessage: node.message || '',
  terminalStatus: node.status || 'success',
  transitions: node.transitions
});

export type StudioDocumentState = {
  draft: StudioWorkflow | null;
  positions: StudioPositions;
  dirty: boolean;
  lint: LintReport | null;
};

export type StudioDocumentAction =
  | { type: 'loaded'; draft: StudioWorkflow; positions?: StudioPositions; lint?: LintReport | null }
  | { type: 'update-node'; id: string; patch: Partial<StudioNode> }
  | { type: 'remove-node'; id: string }
  | { type: 'add-node'; form: NodeFormState }
  | { type: 'edit-node'; id: string; form: NodeFormState }
  | { type: 'add-transition'; fromId: string; toId: string; when: WhenMap }
  | { type: 'remove-edge'; fromId: string; toId: string; condition: unknown }
  | { type: 'edit-edge'; fromId: string; toId: string; oldCondition: unknown; when: WhenMap }
  | { type: 'move-node'; id: string; x: number; y: number }
  | { type: 'clear' }
  | { type: 'linted'; lint: LintReport }
  | { type: 'saved'; lint: LintReport };

export const initialStudioDocument: StudioDocumentState = {
  draft: null,
  positions: {},
  dirty: false,
  lint: null
};

export const studioDocumentReducer = (
  state: StudioDocumentState,
  action: StudioDocumentAction
): StudioDocumentState => {
  const draft = state.draft;
  switch (action.type) {
    case 'loaded':
      return { draft: action.draft, positions: action.positions || {}, dirty: false, lint: action.lint || null };
    case 'update-node':
      return !draft ? state : {
        ...state,
        dirty: true,
        draft: { ...draft, states: { ...draft.states, [action.id]: { ...draft.states[action.id], ...action.patch } } }
      };
    case 'remove-node': {
      if (!draft) return state;
      const states = { ...draft.states };
      delete states[action.id];
      for (const id of Object.keys(states)) {
        const node = states[id];
        if (node.transitions) states[id] = { ...node, transitions: node.transitions.filter((transition) => transition.next !== action.id) };
        if (node.next === action.id) states[id] = { ...states[id], next: undefined };
      }
      const positions = { ...state.positions };
      delete positions[action.id];
      return { ...state, dirty: true, positions, draft: { ...draft, states, initial: draft.initial === action.id ? null : draft.initial } };
    }
    case 'add-node': {
      if (!draft) return state;
      const node = { id: action.form.id, type: action.form.type, ...buildNodeFields(action.form) } as StudioNode;
      const count = Object.keys(state.positions).length;
      return {
        ...state,
        dirty: true,
        positions: { ...state.positions, [action.form.id]: { x: CANVAS_PAD + (count % 4) * 200, y: CANVAS_PAD + Math.floor(count / 4) * 100 } },
        draft: { ...draft, states: { ...draft.states, [action.form.id]: node }, initial: draft.initial || action.form.id }
      };
    }
    case 'edit-node': {
      if (!draft) return state;
      const node = { id: action.form.id, type: action.form.type, ...buildNodeFields(action.form) } as StudioNode;
      const states = { ...draft.states };
      const positions = { ...state.positions };
      let initial = draft.initial;
      if (action.id !== action.form.id) {
        delete states[action.id];
        for (const id of Object.keys(states)) {
          const existing = states[id];
          if (existing.next === action.id) states[id] = { ...existing, next: action.form.id };
          if (states[id].transitions) states[id] = { ...states[id], transitions: states[id].transitions!.map((transition) => transition.next === action.id ? { ...transition, next: action.form.id } : transition) };
        }
        positions[action.form.id] = positions[action.id] || { x: CANVAS_PAD, y: CANVAS_PAD };
        delete positions[action.id];
        if (initial === action.id) initial = action.form.id;
      }
      states[action.form.id] = node;
      return { ...state, dirty: true, positions, draft: { ...draft, states, initial } };
    }
    case 'add-transition': {
      if (!draft?.states[action.fromId]) return state;
      const node = draft.states[action.fromId];
      const conditional = Object.keys(action.when).length > 0;
      const nextNode: StudioNode = conditional
        ? { ...node, transitions: [...(node.transitions || []).filter((transition) => transition.next !== action.toId), { when: action.when, next: action.toId }], next: undefined }
        : { ...node, next: action.toId, transitions: undefined };
      return { ...state, dirty: true, draft: { ...draft, states: { ...draft.states, [action.fromId]: nextNode } } };
    }
    case 'remove-edge': {
      if (!draft?.states[action.fromId]) return state;
      const node = draft.states[action.fromId];
      const condition = JSON.stringify(action.condition);
      const nextNode = node.transitions
        ? { ...node, transitions: node.transitions.filter((transition) => !(transition.next === action.toId && JSON.stringify(transition.when) === condition)) }
        : node.next === action.toId ? { ...node, next: undefined } : node;
      return { ...state, dirty: true, draft: { ...draft, states: { ...draft.states, [action.fromId]: nextNode } } };
    }
    case 'edit-edge': {
      if (!draft?.states[action.fromId]) return state;
      const node = draft.states[action.fromId];
      const oldCondition = JSON.stringify(action.oldCondition);
      const nextNode = node.transitions
        ? { ...node, transitions: node.transitions.map((transition) => transition.next === action.toId && JSON.stringify(transition.when) === oldCondition ? { ...transition, when: action.when } : transition) }
        : node.next === action.toId ? { ...node, next: undefined, transitions: [{ when: action.when, next: action.toId }] } : node;
      return { ...state, dirty: true, draft: { ...draft, states: { ...draft.states, [action.fromId]: nextNode } } };
    }
    case 'move-node':
      return { ...state, dirty: true, positions: { ...state.positions, [action.id]: { x: action.x, y: action.y } } };
    case 'clear':
      return !draft ? state : { ...state, dirty: true, positions: {}, lint: null, draft: { ...draft, states: {}, initial: null } };
    case 'linted': return { ...state, lint: action.lint };
    case 'saved': return { ...state, dirty: false, lint: action.lint };
  }
};
