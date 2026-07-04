// Workflow Studio authoring state types.
//
// The draft workflow is a JSON-shaped mirror of the EDN workflow file. Keys
// that are EDN keywords in the file are stored as strings here; keyword-valued
// fields (e.g. `type: ':agent'`) keep their leading colon so the server's
// EDN emitter writes them as keywords. The file is the source of truth once
// saved; draft state in React is disposable/reconstructable (design doc).

export type NodeTypeId = ':agent' | ':deterministic' | ':process' | ':timer' | ':approval' | ':router' | ':terminal';

export const NODE_TYPES: NodeTypeId[] = [':agent', ':deterministic', ':process', ':timer', ':approval', ':router', ':terminal'];

export type WhenMap = Record<string, string>;

export type Transition = {
  when?: WhenMap;
  next: string;
  effects?: string[];
};

export type StudioNode = {
  id: string;          // state keyword sans colon, e.g. "start"
  type: NodeTypeId;
  title?: string;
  // type-specific fields (kept loose; the linter is the final authority)
  executor?: string;        // :agent
  'prompt-template'?: string; // :agent
  'prompt-output'?: string;   // :agent
  'session-name'?: string;     // :agent
  handler?: string;        // :deterministic
  command?: string[];      // :process
  'input-mode'?: string;   // :process
  'output-mode'?: string;  // :process
  duration?: string;       // :timer
  message?: string;        // :approval
  status?: string;         // :terminal (':success' | ':failure')
  next?: string;           // simple shorthand
  transitions?: Transition[];
  // Optional structured fields kept loose so the editor can render/round-trip
  // outputs/resources without enumerating every shape. The linter is the
  // final authority on validity.
  outputs?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  [key: string]: unknown;
};

export type StudioWorkflow = {
  'api-version': 'tesseraft.workflow/v1';
  kind: ':workflow';
  metadata: { name: string; description?: string };
  initial: string | null;
  states: Record<string, StudioNode>;
};

export type StudioPosition = { x: number; y: number };
export type StudioPositions = Record<string, StudioPosition>;

export type LintReport = { ok: boolean; errors: unknown[]; warnings: unknown[]; diagnostics?: unknown[] };

export type StudioState = {
  draft: StudioWorkflow;
  positions: StudioPositions;
  /** Whether the draft has unsaved changes relative to the loaded file. */
  dirty: boolean;
  /** Last lint result (from save or explicit preview). */
  lint: LintReport | null;
  saving: boolean;
  error: string | null;
};

export const emptyDraft = (name: string, description?: string): StudioWorkflow => ({
  'api-version': 'tesseraft.workflow/v1',
  kind: ':workflow',
  metadata: description ? { name, description } : { name },
  initial: null,
  states: {}
});