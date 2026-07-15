import type { GraphEdge, GraphNode } from '../lib/graphLayout';

/** Per-entry shadowing/conflict record used by `conflicts` and `duplicates`. */
export type WorkflowShadowEntry = { scope: string; path: string; precedence: number };

/**
 * A discovered workflow summary as returned by the control-plane list endpoint.
 * `source` (configured/global/project) and `precedence` are always present;
 * `conflicts` (equal-precedence same-name entries) and `duplicates`
 * (lower-precedence same-name entries this one overrides) are populated only
 * when non-empty. P1.1: scope/shadowing metadata, precedence semantics
 * unchanged — these fields are purely inspectable.
 */
export type WorkflowSummary = {
  name: string;
  path?: string;
  source?: string;
  precedence?: number;
  conflicts?: WorkflowShadowEntry[];
  duplicates?: WorkflowShadowEntry[];
};
export type WorkflowInputDefinition = { type?: string; required?: boolean; default?: string | number | boolean | null; description?: string; title?: string; enum?: Array<string | number | boolean> };
export type WorkflowDetail = {
  name: string;
  path?: string;
  source?: string;
  precedence?: number;
  conflicts?: WorkflowShadowEntry[];
  duplicates?: WorkflowShadowEntry[];
  api_version?: string;
  lint?: { ok?: boolean };
  normalized?: { inputs?: Record<string, WorkflowInputDefinition>; metadata?: { title?: string; description?: string } };
};
export type Attempt = { attempt?: number; node_id?: string; state?: string; status?: string; started_at?: string; finished_at?: string; next_state?: string; error?: string; result?: unknown; effects?: string[] };
export type Failure = { source?: string; message?: string; path?: string; node_id?: string };
export type Artifact = { path: string; name?: string; source?: string; node_id?: string; attempt?: number; kind?: string; exists?: boolean; size?: number; content_type?: string; read_url?: string };
export type ArtifactRead = { artifact: Artifact; previewable?: boolean; content?: string; reason?: string };
export type Liveness = 'executing' | 'parked' | 'orphaned' | 'stale' | 'done' | 'failed' | 'cancelled';

/** Liveness values that are safe to delete (never `executing`). */
export const DELETABLE_LIVENESS: Liveness[] = ['done', 'failed', 'cancelled', 'orphaned', 'stale', 'parked'];
export const isDeletableLiveness = (liveness: Liveness | null | undefined): boolean =>
  liveness != null && DELETABLE_LIVENESS.includes(liveness);
export type RunSummary = {
  run_id: string;
  workflow_name?: string;
  status?: string;
  liveness?: Liveness;
  staleness_seconds?: number | null;
  /** ISO timestamp the run was first created (emitted by the control plane). */
  created_at?: string | null;
  /** ISO timestamp of the last run update (emitted by the control plane). */
  updated_at?: string | null;
  /** Current workflow state id for the run (emitted by the control plane/run detail). */
  state?: string | null;
};
export type RunDetail = RunSummary & { round?: number; attempt?: number; path?: string; attempts?: Attempt[]; failures?: Failure[] };
export type EventRecord = { event?: string; type?: string; state?: string; from?: string; attempt?: number; [key: string]: unknown };
export type Comment = { id: string; path: string; anchor?: { start_line?: number | null; end_line?: number | null } | null; body: string; author?: { name?: string; email?: string } | string | null; created_at?: string };
export type CommentsResponse = { run_id: string; path: string; comments: Comment[] };
export type ApprovalArtifact = { path?: string; kind?: string; label?: string; render?: string; required?: boolean };
export type ApprovalDecisionOption = { decision: string; label?: string; next?: string; consequence?: string };
export type ApprovalRouting = { kind?: string };
export type ApprovalRequest = {
  approval_id: string;
  run_id: string;
  state: string;
  attempt: number;
  message?: string;
  artifact?: { path?: string; kind?: string } | null;
  /** Presentation contract (P0.2): the UI renders the decision screen from
   * these durable fields instead of hard-coded labels. Synthesized by the
   * runtime when the node does not author a `:presentation` block. */
  question?: string | null;
  artifacts?: ApprovalArtifact[] | null;
  decisions?: ApprovalDecisionOption[] | null;
  routing?: ApprovalRouting | null;
  requested_at?: string;
  status?: string;
  decision?: ApprovalDecision | null;
};
export type ApprovalDecision = { approval_id: string; decision: string; summary?: string | null; author: { name: string; email: string }; decided_at: string };
export type ApprovalsResponse = { run_id: string; approvals: ApprovalRequest[] };
export type ApprovalResponse = { approval: ApprovalRequest };
export type MutationResult = { operation?: string; status?: string; code?: string; run_id?: string; approval_id?: string; decision?: string; cli?: unknown; latest_runtime?: unknown; run_detail?: unknown };

/** Git author identity for a run's agent commits. Both fields present or both absent. */
export type GitUser = { name: string; email: string };

// ---- Project abstraction types (design §4.1) ----
// A first-class Project owns a workspace root, run root, workflow discovery
// context, non-secret settings, and project-specific Jira/GitHub connections.
// Raw credentials never appear here; connections carry only a `credential_ref`
// plus masked present/absent state.

/** Credential reference of the form `<store>:<path>` (e.g. `env:GITHUB_TOKEN`). */
export type CredentialRef = string;
/** Masked token state: never contains the raw secret. */
export type MaskedCredential = { present: boolean; credential_ref?: CredentialRef; preview?: string; unresolved?: string; error?: string };

export type ProjectDiscovery = { workflow_roots?: string[] | null; tesseraft_home?: string | null };
export type ProjectSettings = {
  pi_default_provider?: string | null;
  pi_default_model?: string | null;
  default_repo_root?: string | null;
  github_token?: MaskedCredential | null;
  jira_token?: MaskedCredential | null;
};
export type ProjectConnection = {
  base_url?: string;
  credential_ref?: CredentialRef;
  credential_state?: MaskedCredential | null;
};
export type ProjectConnections = { jira?: ProjectConnection; github?: ProjectConnection };

export type ProjectSummary = { project_id: string; name?: string; source?: 'manifest' | 'implicit' };
export type ProjectDetail = {
  project_id: string;
  name?: string;
  workspace_root?: string;
  runs_root?: string;
  discovery?: ProjectDiscovery;
  settings?: ProjectSettings;
  connections?: ProjectConnections;
  migrated_from?: string;
};
export type ProjectsResponse = { projects: ProjectSummary[] };
export type ProjectConnectionsResponse = { connections: ProjectConnections };
export type StartRunPayload = { workflow_name: string | null; run_id: string; inputs: Record<string, string>; max_steps: number; git_user?: GitUser };
export type LoadState<T> = { data: T; error: string | null };
export type WorkflowGraphState = { nodes: GraphNode[]; edges: GraphEdge[] };
