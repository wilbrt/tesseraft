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

const decodeDecisionLabels = (approval: ApprovalRequest | null): { decision: string; label: string }[] => {
  // Render decision options from the durable approval request record
  // (presentation contract, P0.2 review) instead of a hard-coded array. The
  // runtime materializes a `decisions` list from the node's transitions; the
  // submitted `decision` string still matches transition :when {:decision "..."}.
  // Fall back to the v1 hard-coded pair for records written before this
  // contract shipped, so older paused runs keep rendering a decision UI.
  const fromRecord = (approval?.decisions || [])
    .filter((d) => d && typeof d.decision === 'string' && d.decision.length > 0)
    .map((d) => ({ decision: d.decision, label: d.label?.trim() || d.decision }));
  return fromRecord.length > 0
    ? fromRecord
    : [{ decision: 'approve', label: 'approve' }, { decision: 'changes-requested', label: 'changes-requested' }];
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
  const question = approval.question?.trim() || approval.message?.trim() || '';
  const presentationArtifacts = (approval.artifacts || []).filter((a) => a && typeof a.path === 'string');
  const options = decodeDecisionLabels(approval);
  const routingKind = approval.routing?.kind || 'self';

  const decideWith = (decision: string): Promise<void> => decide(decision);

  return (
    <section className="panel approval-panel" aria-label="Approval decision">
      <h2>Manual input · approval</h2>
      <p className="muted">This run is paused at an approval node waiting for a decision. The decision (e.g. <code>approve</code>) advances the run through the matching transition; the UI never redefines transitions.</p>
      {decisionError && <div className="error inline">{decisionError}</div>}
      <dl className="field-row">
        <dt>State</dt><dd>{approval.state}</dd>
        <dt>Attempt</dt><dd>{approval.attempt}</dd>
        <dt>Approval id</dt><dd><code>{approval.approval_id}</code></dd>
        {question && <dt className="question-dt">Question</dt>}
        {question && <dd>{question}</dd>}
        {!question && approval.message && <dt>Message</dt>}
        {!question && approval.message && <dd>{approval.message}</dd>}
        {presentationArtifacts.length > 0 && <dt className="artifact-dt">Artifacts</dt>}
        {presentationArtifacts.length > 0 && (
          <dd>
            <ul className="approval-artifacts">
              {presentationArtifacts.map((a) => (
                <li key={a.path}><code>{a.path}</code>{a.label ? ` — ${a.label}` : ''}{a.kind ? ` (${a.kind})` : ''}</li>
              ))}
            </ul>
          </dd>
        )}
        {presentationArtifacts.length === 0 && artifactPath && <dt className="artifact-dt">Artifact</dt>}
        {presentationArtifacts.length === 0 && artifactPath && <dd><code>{artifactPath}</code></dd>}
        {routingKind !== 'self' && <dt>Routing</dt>}
        {routingKind !== 'self' && <dd>{routingKind}</dd>}
      </dl>
      <label className="comment-anchor">Summary (optional)
        <textarea value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Optional comment summarizing the decision." />
      </label>
      <div className="control-card approval-buttons">
        {options.map((opt) => (
          <button key={opt.decision} type="button" disabled={busy} onClick={() => void decideWith(opt.decision)}>{opt.label}</button>
        ))}
      </div>
    </section>
  );
};