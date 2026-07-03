import { useEffect, useState } from 'react';
import { getJson, postJson } from '../lib/api';
import type { ApprovalRequest, ApprovalsResponse, MutationResult } from '../types/runConsole';

type Props = { runId: string | null; onRefresh: (runId?: string) => Promise<void> };

/** Returns the latest pending approval (if any) for the run, or null. */
const usePendingApproval = (runId: string | null): { approval: ApprovalRequest | null; loading: boolean; error: string | null; reload: () => Promise<void> } => {
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async (): Promise<void> => {
    if (!runId) { setApproval(null); return; }
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<ApprovalsResponse>(`/api/runs/${encodeURIComponent(runId)}/approvals`);
      const pending = (data.approvals || []).find((a) => !a.decision);
      setApproval(pending || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setApproval(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, [runId]);

  return { approval, loading, error, reload };
};

const decodeDecisionLabels = (approval: ApprovalRequest | null): string[] => {
  // The node's transitions are not exposed over the API in v1, so derive
  // common decision labels from the artifact and default to approve /
  // changes-requested when unknown. The runtime matches the decision string
  // against transition :when {:decision "..."}.
  return ['approve', 'changes-requested'];
};

export const ApprovalPanel = ({ runId, onRefresh }: Props) => {
  const { approval, loading, error, reload } = usePendingApproval(runId);
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  if (!runId) return null;
  if (loading) return null;
  if (error) return null;
  if (!approval) return null;

  const decide = async (decision: string): Promise<void> => {
    setBusy(true);
    setDecisionError(null);
    try {
      await postJson<{ operation?: string; status?: string }>(`/api/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approval.approval_id)}`, { decision, ...(summary.trim() ? { summary: summary.trim() } : {}) });
      setSummary('');
      await reload();
      await onRefresh(runId);
    } catch (err) {
      setDecisionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const artifactPath = approval.artifact?.path;
  const labels = decodeDecisionLabels(approval);

  return (
    <section className="panel approval-panel" aria-label="Approval decision">
      <h2>Manual input · approval</h2>
      <p className="muted">This run is paused at an approval node waiting for a decision. The decision (e.g. <code>approve</code>) advances the run through the matching transition; the UI never redefines transitions.</p>
      {decisionError && <div className="error inline">{decisionError}</div>}
      <dl className="field-row">
        <dt>State</dt><dd>{approval.state}</dd>
        <dt>Attempt</dt><dd>{approval.attempt}</dd>
        <dt>Approval id</dt><dd><code>{approval.approval_id}</code></dd>
        <dt>Message</dt><dd>{approval.message || ''}</dd>
        {artifactPath && <dt className="artifact-dt">Artifact</dt>}
        {artifactPath && <dd><code>{artifactPath}</code></dd>}
      </dl>
      <label className="comment-anchor">Summary (optional)
        <textarea value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Optional comment summarizing the decision." />
      </label>
      <div className="control-card approval-buttons">
        {labels.map((label) => (
          <button key={label} type="button" disabled={busy} onClick={() => void decide(label)}>{label}</button>
        ))}
      </div>
    </section>
  );
};