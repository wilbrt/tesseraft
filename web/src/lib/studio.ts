// Workflow Studio API client helpers. The server is the EDN serialization +
// lint authority; the UI only sends/receives JSON drafts.

import type { LintReport, StudioPositions, StudioWorkflow } from '../types/studio';
import { getJson, postJson } from './api';

export type CreateStudioWorkflowResponse = { workflow: { name: string; path: string } };
export type StudioSidecar = { status: string; draft?: StudioWorkflow; positions?: StudioPositions; lint?: LintReport };
export type GetStudioWorkflowResponse = {
  workflow: { name: string; path: string; edn: string };
  state: StudioSidecar;
};
export const createStudioWorkflow = (name: string, description?: string): Promise<CreateStudioWorkflowResponse> =>
  postJson<CreateStudioWorkflowResponse>('/api/studio/workflows', { name, description });

export const getStudioWorkflow = (name: string): Promise<GetStudioWorkflowResponse> =>
  getJson<GetStudioWorkflowResponse>(`/api/studio/workflows/${encodeURIComponent(name)}`);

export type SaveStudioResult =
  | { ok: true; save_mode: 'draft' | 'completed'; lint: LintReport | null }
  | { ok: false; save_mode: 'completed'; lint: LintReport };

export const saveStudioWorkflow = async (name: string, draft: StudioWorkflow, positions: StudioPositions, saveMode: 'draft' | 'completed'): Promise<SaveStudioResult> => {
  const response = await fetch(`/api/studio/workflows/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ draft, positions, save_mode: saveMode })
  });
  const data = await response.json().catch(() => ({})) as { ok?: boolean; save_mode?: string; lint?: LintReport; error?: { message?: string } };
  if (response.ok) {
    return { ok: true, save_mode: (data.save_mode as 'draft' | 'completed') || saveMode, lint: data.lint || null };
  }
  if (response.status === 422 && data.lint) {
    return { ok: false, save_mode: 'completed', lint: data.lint };
  }
  throw new Error(data.error?.message || `Save failed: ${response.status}`);
};

export const lintStudioWorkflow = (name: string): Promise<LintReport> =>
  postJson<LintReport>(`/api/studio/workflows/${encodeURIComponent(name)}/lint`, {}).then((res) => ({ ok: res.ok, errors: res.errors || [], warnings: res.warnings || [], diagnostics: res.diagnostics || [] }));