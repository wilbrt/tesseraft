import { useMemo, useState } from 'react';
import { getJson, postJson } from '../lib/api';
import { useProject, projectApiUrl } from '../lib/project';
import type { Artifact, ArtifactRead, Comment, CommentsResponse } from '../types/runConsole';
import { FieldList } from './FieldList';

type Props = { runId: string | null; artifacts: Artifact[]; selectedNodeId: string | null };

export const ArtifactBrowser = ({ runId, artifacts, selectedNodeId }: Props) => {
  const { projectId } = useProject();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ArtifactRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [commentBody, setCommentBody] = useState('');
  const [startLine, setStartLine] = useState('');
  const [endLine, setEndLine] = useState('');
  const [posting, setPosting] = useState(false);
  const filtered = useMemo(() => selectedNodeId ? artifacts.filter((artifact) => artifact.node_id === selectedNodeId || !artifact.node_id) : artifacts, [artifacts, selectedNodeId]);

  const loadComments = async (rid: string, path: string): Promise<void> => {
    try {
      const data = await getJson<CommentsResponse>(projectApiUrl(`/api/runs/${encodeURIComponent(rid)}/comments?path=${encodeURIComponent(path)}`, projectId));
      setComments(data.comments || []);
      setCommentsError(null);
    } catch (err) {
      setComments([]);
      setCommentsError(err instanceof Error ? err.message : String(err));
    }
  };

  const selectArtifact = async (artifact: Artifact): Promise<void> => {
    if (!runId) return;
    setSelectedPath(artifact.path);
    setPreview(null);
    setError(null);
    try {
      const data = await getJson<ArtifactRead>(projectApiUrl(`/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(artifact.path)}`, projectId));
      setPreview(data);
      void loadComments(runId, artifact.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const submitComment = async (): Promise<void> => {
    if (!runId || !selectedPath || !commentBody.trim()) return;
    setPosting(true);
    try {
      const sl = startLine.trim() ? Number(startLine) : null;
      const el = endLine.trim() ? Number(endLine) : null;
      const anchor = (sl != null && el != null) ? { start_line: sl, end_line: el } : undefined;
      await postJson(projectApiUrl(`/api/runs/${encodeURIComponent(runId)}/comments`, projectId), { path: selectedPath, body: commentBody, ...(anchor ? { anchor } : {}) });
      setCommentBody('');
      setStartLine('');
      setEndLine('');
      await loadComments(runId, selectedPath);
    } catch (err) {
      setCommentsError(err instanceof Error ? err.message : String(err));
    } finally {
      setPosting(false);
    }
  };

  return (
    <section className="run-console-section artifact-grid" aria-label="Artifact browser">
      <div>
        <h3>Artifacts</h3>
        <ul className="item-list compact artifact-list">
          {filtered.length === 0 && <li className="muted">No artifacts found.</li>}
          {filtered.map((artifact) => (
            <li key={`${artifact.source || 'artifact'}-${artifact.path}`} className={selectedPath === artifact.path ? 'selected-row' : ''}>
              <button type="button" onClick={() => selectArtifact(artifact)}>{artifact.path}</button>
              <span>{artifact.source} · {artifact.content_type} · {artifact.exists ? `${artifact.size ?? 0} bytes` : 'missing'}{artifact.node_id ? ` · ${artifact.node_id}` : ''}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3>Preview</h3>
        {error && <div className="error">{error}</div>}
        {!preview && !error && <div className="empty">Select a small text, JSON, markdown, EDN, or log artifact.</div>}
        {preview && (
          <div>
            <FieldList fields={[["Path", preview.artifact.path], ["Type", preview.artifact.content_type], ["Size", preview.artifact.size], ["Preview", preview.previewable ? 'yes' : preview.reason]]} />
            {preview.previewable && <pre>{preview.content}</pre>}
          </div>
        )}
        {selectedPath && (
          <div className="comments-section" aria-label={`Comments on ${selectedPath}`}>
            <h4>Comments · {selectedPath}</h4>
            {commentsError && <div className="error inline">{commentsError}</div>}
            <ul className="item-list compact comment-list">
              {comments.length === 0 && <li className="muted">No comments yet.</li>}
              {comments.map((c) => (
                <li key={c.id} className="comment-row">
                  <div className="comment-head">
                    <strong>{c.author && typeof c.author === 'object' ? c.author.name : (c.author || 'unknown')}</strong>
                    {c.anchor && (c.anchor.start_line != null || c.anchor.end_line != null) ? <span className="muted"> · lines {c.anchor.start_line ?? '?'}–{c.anchor.end_line ?? '?'}</span> : null}
                    {c.created_at ? <span className="muted"> · {c.created_at}</span> : null}
                  </div>
                  <div className="comment-body">{c.body}</div>
                </li>
              ))}
            </ul>
            <div className="control-card comment-form">
              <label className="comment-anchor">
                Anchor lines
                <input type="number" min="1" value={startLine} onChange={(e) => setStartLine(e.target.value)} placeholder="start" aria-label="Start line" />
                <input type="number" min="1" value={endLine} onChange={(e) => setEndLine(e.target.value)} placeholder="end" aria-label="End line" />
              </label>
              <textarea value={commentBody} onChange={(e) => setCommentBody(e.target.value)} placeholder="Add a comment anchored to this artifact…" />
              <button type="button" disabled={!runId || !selectedPath || !commentBody.trim() || posting} onClick={() => void submitComment()}>Add comment</button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};