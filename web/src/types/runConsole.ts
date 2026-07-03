import type { GraphEdge, GraphNode } from '../lib/graphLayout';

export type WorkflowSummary = { name: string; path?: string };
export type WorkflowInputDefinition = { type?: string; required?: boolean; default?: string | number | boolean | null; description?: string; title?: string; enum?: Array<string | number | boolean> };
export type WorkflowDetail = { name: string; path?: string; api_version?: string; lint?: { ok?: boolean }; normalized?: { inputs?: Record<string, WorkflowInputDefinition>; metadata?: { title?: string; description?: string } } };
export type Attempt = { attempt?: number; node_id?: string; state?: string; status?: string; started_at?: string; finished_at?: string; next_state?: string; error?: string; result?: unknown; effects?: string[] };
export type Failure = { source?: string; message?: string; path?: string; node_id?: string };
export type Artifact = { path: string; name?: string; source?: string; node_id?: string; attempt?: number; kind?: string; exists?: boolean; size?: number; content_type?: string; read_url?: string };
export type ArtifactRead = { artifact: Artifact; previewable?: boolean; content?: string; reason?: string };
export type Liveness = 'executing' | 'parked' | 'orphaned' | 'stale' | 'done' | 'failed';

/** Liveness values that are safe to delete (never `executing`). */
export const DELETABLE_LIVENESS: Liveness[] = ['done', 'failed', 'orphaned', 'stale', 'parked'];
export const isDeletableLiveness = (liveness: Liveness | null | undefined): boolean =>
  liveness != null && DELETABLE_LIVENESS.includes(liveness);
export type RunSummary = { run_id: string; workflow_name?: string; status?: string; liveness?: Liveness; staleness_seconds?: number | null };
export type RunDetail = RunSummary & { state?: string; round?: number; attempt?: number; path?: string; attempts?: Attempt[]; failures?: Failure[] };
export type EventRecord = { event?: string; type?: string; state?: string; from?: string; attempt?: number; [key: string]: unknown };
export type MutationResult = { operation?: string; status?: string; code?: string; run_id?: string; cli?: unknown; latest_runtime?: unknown; run_detail?: unknown };

/** Git author identity for a run's agent commits. Both fields present or both absent. */
export type GitUser = { name: string; email: string };
export type StartRunPayload = { workflow_name: string | null; run_id: string; inputs: Record<string, string>; max_steps: number; git_user?: GitUser };
export type LoadState<T> = { data: T; error: string | null };
export type WorkflowGraphState = { nodes: GraphNode[]; edges: GraphEdge[] };
