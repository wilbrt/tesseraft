import { useEffect, useState } from 'react';
import { getJson } from '../lib/api';
import { useProject } from '../lib/project';

export type DoctorStatus = 'ready' | 'not-configured' | 'unreachable' | 'invalid';
export type DoctorMode = 'static' | 'read-only';
export type DoctorCheck = {
  id: string;
  label: string;
  status: DoctorStatus;
  mode: DoctorMode;
  summary: string;
  remediation: string | null;
  duration_ms: number;
};
export type DoctorReport = {
  project_id: string;
  summary: Record<DoctorStatus, number>;
  checks: DoctorCheck[];
};

const statusLabel: Record<DoctorStatus, string> = {
  ready: 'Ready',
  'not-configured': 'Not configured',
  unreachable: 'Unreachable',
  invalid: 'Invalid'
};

const modeLabel: Record<DoctorMode, string> = {
  static: 'Static configuration',
  'read-only': 'Read-only check'
};

export const ConnectionsDoctorPanel = () => {
  const { projectId } = useProject();
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<DoctorReport>(`/api/projects/${encodeURIComponent(projectId || 'default')}/doctor`);
      setReport(data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
      setReport(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [projectId]);

  return (
    <div className="control-card connections-doctor" aria-label="Connections Doctor">
      <div className="doctor-header">
        <div>
          <h3>Connections Doctor</h3>
          <p className="muted">Project-scoped local checks for credentials, tools, repository readiness, workflow discovery, and run storage. Checks are static or read-only and never display raw secret values.</p>
        </div>
        <button type="button" disabled={loading} onClick={() => void load()}>Run checks</button>
      </div>
      {loading && <p className="muted">Running checks…</p>}
      {error && <div className="error" role="alert">{error}</div>}
      {report && (
        <>
          <div className="doctor-summary" aria-label="Connections Doctor summary">
            {(Object.keys(statusLabel) as DoctorStatus[]).map((status) => (
              <span key={status} className={`status-pill doctor-status ${status}`}>
                {statusLabel[status]}: {report.summary[status] || 0}
              </span>
            ))}
          </div>
          <ul className="doctor-checks">
            {report.checks.map((check) => (
              <li key={check.id} className="doctor-check">
                <div className="doctor-check-title">
                  <strong>{check.label}</strong>
                  <span className={`status-pill doctor-status ${check.status}`}>{statusLabel[check.status]}</span>
                  <span className="status-pill mode-pill">{modeLabel[check.mode]}</span>
                </div>
                <p>{check.summary}</p>
                {check.remediation && <p className="muted"><strong>Remediation:</strong> {check.remediation}</p>}
                <small className="muted">{check.duration_ms} ms</small>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
};
