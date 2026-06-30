import { useMemo, useState } from 'react';
import { getJson } from '../lib/api';
import type { Artifact, ArtifactRead } from '../types/runConsole';
import { FieldList } from './FieldList';

type Props = { runId: string | null; artifacts: Artifact[]; selectedNodeId: string | null };

export const ArtifactBrowser = ({ runId, artifacts, selectedNodeId }: Props) => {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ArtifactRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filtered = useMemo(() => selectedNodeId ? artifacts.filter((artifact) => artifact.node_id === selectedNodeId || !artifact.node_id) : artifacts, [artifacts, selectedNodeId]);

  const selectArtifact = async (artifact: Artifact): Promise<void> => {
    if (!runId) return;
    setSelectedPath(artifact.path);
    setPreview(null);
    setError(null);
    try {
      const data = await getJson<ArtifactRead>(`/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(artifact.path)}`);
      setPreview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
      </div>
    </section>
  );
};
