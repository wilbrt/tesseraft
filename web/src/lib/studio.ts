// Workflow Studio API client helpers. The server is the EDN serialization +
// lint authority; the UI only sends/receives JSON drafts.

import type { LintReport, StudioPositions, StudioWorkflow } from '../types/studio';
import { getJson, postJson, putJson, RequestJsonError } from './api';

export type CreateStudioWorkflowResponse = { workflow: { name: string; path: string } };
export type StudioSidecar = { status: string; draft?: StudioWorkflow; positions?: StudioPositions; lint?: LintReport };
export type GetStudioWorkflowResponse = {
  workflow: { name: string; path: string; normalized?: StudioWorkflow };
  state: StudioSidecar;
};
export const createStudioWorkflow = (name: string, description?: string): Promise<CreateStudioWorkflowResponse> =>
  postJson<CreateStudioWorkflowResponse>('/api/studio/workflows', { name, description });

export const getStudioWorkflow = (name: string): Promise<GetStudioWorkflowResponse> =>
  getJson<GetStudioWorkflowResponse>(`/api/studio/workflows/${encodeURIComponent(name)}`);

export type SaveStudioResult =
  | { ok: true; save_mode: 'draft' | 'completed'; lint: LintReport | null }
  | { ok: false; save_mode: 'completed'; lint: LintReport };

export const saveStudioWorkflow = (name: string, draft: StudioWorkflow, positions: StudioPositions, saveMode: 'draft' | 'completed'): Promise<SaveStudioResult> =>
  putJson<Record<string, unknown>>(`/api/studio/workflows/${encodeURIComponent(name)}`, { draft, positions, save_mode: saveMode })
    .then((data) => ({ ok: true as const, save_mode: saveMode, lint: (data.lint as LintReport | undefined) || null }))
    .catch((error: unknown) => {
      if (saveMode === 'completed' && error instanceof RequestJsonError && error.statusCode === 422) {
        const details = error.responseBody.error && typeof error.responseBody.error === 'object'
          ? (error.responseBody.error as { details?: { diagnostics?: unknown[] } }).details : undefined;
        const diagnostics = details?.diagnostics || [];
        return { ok: false as const, save_mode: 'completed' as const,
          lint: { ok: false, errors: diagnostics, warnings: [], diagnostics } };
      }
      throw error;
    });

export const lintStudioWorkflow = (name: string, draft: StudioWorkflow): Promise<LintReport> =>
  postJson<LintReport>(`/api/studio/workflows/${encodeURIComponent(name)}/lint`, { draft }).then((res) => ({ ok: res.ok, errors: res.errors || [], warnings: res.warnings || [], diagnostics: res.diagnostics || [] }));

// Workflow package asset read/write (prompt templates, etc.). The asset path
// is a safe relative path under `.tesseraft/workflows/<name>/` (e.g.
// `prompts/<id>.md.tmpl`). Slashes are valid path separators and the path is
// validated server-side, so encodeURI (keeps slashes) is the right encoder.
export type WorkflowAsset = { workflow: string; path: string; rel_path: string; content: string };
export type WorkflowAssetWriteResult = { ok: boolean; workflow: string; path: string; rel_path: string };

export const readWorkflowAsset = (name: string, assetPath: string): Promise<WorkflowAsset> =>
  getJson<WorkflowAsset>(`/api/studio/workflows/${encodeURIComponent(name)}/assets/${encodeURI(assetPath)}`);

export const writeWorkflowAsset = (name: string, assetPath: string, content: string): Promise<WorkflowAssetWriteResult> =>
  putJson<WorkflowAssetWriteResult>(`/api/studio/workflows/${encodeURIComponent(name)}/assets/${encodeURI(assetPath)}`, { content });
