import { useCallback, useEffect, useMemo, useState } from 'react';
import { getJson, postJson } from '../lib/api';
import { projectApiUrl, useProject } from '../lib/project';
import type { ApprovalAnnotation, ApprovalAnnotationAnchor, ApprovalArtifact, ApprovalDecisionOption, ApprovalRequest, ArtifactRead, PendingApprovalsResponse } from '../types/runConsole';
import { FullWidthPage } from './PageLayout';

type RenderLine = { artifactLine: number; text: string; file?: string; side?: 'old' | 'new'; line?: number; kind: 'diff' | 'text' };

const diffLines = (content: string): RenderLine[] => {
  let file: string | undefined;
  let oldLine = 0;
  let newLine = 0;
  return content.split('\n').map((text, index) => {
    if (text.startsWith('+++ ')) file = text.slice(4).replace(/^b\//, '').trim();
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); }
    const base = { artifactLine: index + 1, text, file, kind: 'diff' as const };
    if (hunk || text.startsWith('diff ') || text.startsWith('--- ') || text.startsWith('+++ ')) return base;
    if (text.startsWith('+')) return { ...base, side: 'new' as const, line: newLine++ };
    if (text.startsWith('-')) return { ...base, side: 'old' as const, line: oldLine++ };
    if (text.startsWith(' ')) { const line = newLine++; oldLine += 1; return { ...base, side: 'new' as const, line }; }
    return base;
  });
};

const renderLines = (content: string, kind?: string): RenderLine[] =>
  kind === 'diff' || /^diff --git |^@@ /m.test(content)
    ? diffLines(content)
    : content.split('\n').map((text, index) => ({ artifactLine: index + 1, text, line: index + 1, kind: 'text' }));

const artifactKey = (artifact: ApprovalArtifact): string => artifact.path || artifact.label || 'artifact';
const approvalKey = (approval: Pick<ApprovalRequest, 'run_id' | 'approval_id'>): string => `${approval.run_id}:${approval.approval_id}`;

export const ApprovalInbox = (): JSX.Element => {
  const { projectId } = useProject();
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedArtifact, setSelectedArtifact] = useState<ApprovalArtifact | null>(null);
  const [preview, setPreview] = useState<ArtifactRead | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [resume, setResume] = useState(true);
  const [annotations, setAnnotations] = useState<ApprovalAnnotation[]>([]);
  const [anchor, setAnchor] = useState<ApprovalAnnotationAnchor | null>(null);
  const [annotationBody, setAnnotationBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const selected = approvals.find((approval) => approvalKey(approval) === selectedKey) || approvals[0] || null;

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const data = await getJson<PendingApprovalsResponse>(projectApiUrl('/api/approvals', projectId));
      setApprovals(data.approvals || []);
      setSelectedKey((current) => (data.approvals || []).some((item) => approvalKey(item) === current)
        ? current
        : data.approvals?.[0] ? approvalKey(data.approvals[0]) : null);
      setError(null);
    } catch (err) {
      setApprovals([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    setMessage(''); setAnnotations([]); setAnchor(null); setAnnotationBody(''); setPreview(null);
    const artifact = selected?.artifacts?.[0] || (selected?.artifact ? { ...selected.artifact } : null);
    setSelectedArtifact(artifact);
  }, [selected?.approval_id, selected?.run_id]);

  useEffect(() => {
    const path = selectedArtifact?.path;
    if (!selected || !path) { setPreview(null); return; }
    let live = true;
    setPreview(null);
    getJson<ArtifactRead>(projectApiUrl(`/api/runs/${encodeURIComponent(selected.run_id)}/artifact?path=${encodeURIComponent(path)}`, projectId))
      .then((data) => { if (live) { setPreview(data); setError(null); } })
      .catch((err) => { if (live) setError(err instanceof Error ? err.message : String(err)); });
    return () => { live = false; };
  }, [projectId, selected?.approval_id, selected?.run_id, selectedArtifact?.path]);

  const lines = useMemo(() => preview?.previewable && typeof preview.content === 'string'
    ? renderLines(preview.content, selectedArtifact?.kind) : [], [preview, selectedArtifact?.kind]);

  const selectLine = (line: RenderLine): void => {
    setAnchor({ kind: line.kind, artifact_line: line.artifactLine, ...(line.file ? { file: line.file } : {}), ...(line.side ? { side: line.side } : {}), ...(line.line ? { line: line.line, start_line: line.line, end_line: line.line } : {}) });
    setAnnotationBody('');
  };

  const addAnnotation = (): void => {
    if (!selectedArtifact?.path || !anchor || !annotationBody.trim()) return;
    setAnnotations((current) => [...current, { id: `a-${Date.now()}-${current.length + 1}`, artifact_path: selectedArtifact.path!, body: annotationBody.trim(), anchor }]);
    setAnchor(null); setAnnotationBody('');
  };

  const decide = async (option: ApprovalDecisionOption): Promise<void> => {
    if (!selected) return;
    const requiresMessage = option.requires_message === true || option['requires-message'] === true;
    if (requiresMessage && !message.trim()) { setError('This decision requires an overall message.'); return; }
    setSubmitting(true); setError(null);
    try {
      await postJson(projectApiUrl(`/api/approvals/${encodeURIComponent(selected.approval_id)}/decisions`, projectId), {
        run_id: selected.run_id, decision: option.decision, message: message.trim(), annotations, resume, max_steps: 100
      });
      await reload();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSubmitting(false); }
  };

  return (
    <FullWidthPage className="approval-workspace" aria-label="Approval inbox">
      <aside className="approval-queue panel">
        <div className="approval-queue-heading"><div><h2>Approvals</h2><p className="muted">Pending across this project</p></div><span className="status-pill parked">{approvals.length}</span></div>
        <button type="button" className="approval-refresh" onClick={() => void reload()} disabled={loading}>Refresh</button>
        <ul>
          {approvals.map((approval) => (
            <li key={approvalKey(approval)}>
              <button type="button" className={approvalKey(approval) === (selected ? approvalKey(selected) : null) ? 'active' : ''} onClick={() => setSelectedKey(approvalKey(approval))}>
                <strong>{approval.question || approval.message || approval.state}</strong>
                <span>{approval.workflow_name} · {approval.run_id}</span>
                <span>{approval.state} · attempt {approval.attempt}</span>
              </button>
            </li>
          ))}
          {!loading && approvals.length === 0 && <li className="empty">No pending approvals.</li>}
        </ul>
      </aside>
      <section className="approval-review panel">
        {error && <div className="error" role="alert">{error}</div>}
        {loading && <div className="loading">Loading pending approvals…</div>}
        {!loading && !selected && <div className="approval-empty"><h2>You’re caught up</h2><p>No run is waiting for a decision in this project.</p></div>}
        {selected && (
          <>
            <header className="approval-review-heading">
              <div><p className="approval-eyebrow">{selected.workflow_name} · {selected.run_id} · {selected.state}/{selected.attempt}</p><h2>{selected.question || selected.message || 'Decision required'}</h2></div>
              <code>{selected.approval_id}</code>
            </header>
            <div className="approval-context-tabs" role="tablist" aria-label="Approval evidence">
              {(selected.artifacts || (selected.artifact ? [selected.artifact] : [])).map((artifact) => (
                <button key={artifactKey(artifact)} type="button" role="tab" aria-selected={selectedArtifact?.path === artifact.path} className={selectedArtifact?.path === artifact.path ? 'active' : ''} onClick={() => setSelectedArtifact(artifact)}>{artifact.label || artifact.path}{artifact.kind ? ` · ${artifact.kind}` : ''}</button>
              ))}
            </div>
            <div className="approval-evidence" aria-label="Approval evidence viewer">
              {!selectedArtifact && <div className="empty">This approval declares no context artifacts.</div>}
              {selectedArtifact && !preview && !error && <div className="loading">Loading {selectedArtifact.path}…</div>}
              {preview && !preview.previewable && <div className="empty">Preview unavailable: {preview.reason}</div>}
              {preview?.previewable && (
                <div className={`approval-source ${selectedArtifact?.kind === 'diff' ? 'diff' : 'text'}`}>
                  {lines.map((line) => {
                    const comments = annotations.filter((item) => item.artifact_path === selectedArtifact?.path && item.anchor.artifact_line === line.artifactLine);
                    return <div key={line.artifactLine} className={`approval-source-row ${line.text.startsWith('+') && !line.text.startsWith('+++') ? 'added' : ''} ${line.text.startsWith('-') && !line.text.startsWith('---') ? 'removed' : ''}`}>
                      <button type="button" className="line-number" title="Annotate this line" onClick={() => selectLine(line)}>{line.side === 'old' ? `${line.line ?? ''}−` : line.side === 'new' ? `${line.line ?? ''}+` : line.artifactLine}</button>
                      <code>{line.text || ' '}</code>
                      {comments.map((comment) => <div className="draft-annotation" key={comment.id}><strong>Draft annotation</strong><span>{comment.body}</span><button type="button" onClick={() => setAnnotations((current) => current.filter((item) => item.id !== comment.id))}>Remove</button></div>)}
                    </div>;
                  })}
                </div>
              )}
            </div>
            {anchor && selectedArtifact?.path && <div className="annotation-composer">
              <strong>Annotate {selectedArtifact.path} · {anchor.file ? `${anchor.file}:` : 'line '}{anchor.line || anchor.artifact_line}</strong>
              <textarea autoFocus value={annotationBody} onChange={(event) => setAnnotationBody(event.target.value)} placeholder="Explain what should change at this line…" />
              <div><button type="button" onClick={() => { setAnchor(null); setAnnotationBody(''); }}>Cancel</button><button type="button" disabled={!annotationBody.trim()} onClick={addAnnotation}>Add annotation</button></div>
            </div>}
            <footer className="approval-decision-area">
              <label>Overall message<textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Explain the decision or give the next node guidance…" /></label>
              <label className="approval-resume"><input type="checkbox" checked={resume} onChange={(event) => setResume(event.target.checked)} /> Resume the run immediately</label>
              <div className="approval-decision-options">
                {(selected.decisions || []).map((option) => <button key={option.decision} type="button" className={`decision-${option.intent || 'default'}`} disabled={submitting} onClick={() => void decide(option)}><strong>{option.label || option.decision}</strong><span>{option.consequence || option.consequences || `Continue through the ${option.decision} transition.`}</span>{(option.requires_message || option['requires-message']) && <em>Message required</em>}</button>)}
              </div>
              <p className="muted">{annotations.length} draft annotation{annotations.length === 1 ? '' : 's'} will be recorded with this decision.</p>
            </footer>
          </>
        )}
      </section>
    </FullWidthPage>
  );
};
