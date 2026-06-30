import { useEffect, useState } from 'react';
import { getJson, postJson } from '../lib/api';
import type { PiSessionDetail, PiSessionEvent, PiSessionSummary } from '../types/piSessions';

export const PiSessionsPanel = () => {
  const [sessions, setSessions] = useState<PiSessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<PiSessionDetail | null>(null);
  const [events, setEvents] = useState<PiSessionEvent[]>([]);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);

  const loadSessions = async (): Promise<PiSessionSummary[]> => {
    const data = await getJson<{ sessions: PiSessionSummary[] }>('/api/pi-sessions');
    setSessions(data.sessions || []);
    return data.sessions || [];
  };

  const loadSession = async (sessionId: string): Promise<void> => {
    setError(null);
    try {
      const [detail, eventData] = await Promise.all([
        getJson<{ session: PiSessionDetail }>(`/api/pi-sessions/${encodeURIComponent(sessionId)}`),
        getJson<{ events: PiSessionEvent[] }>(`/api/pi-sessions/${encodeURIComponent(sessionId)}/events`)
      ]);
      setSelectedSessionId(sessionId);
      setSelectedSession(detail.session);
      setEvents(eventData.events || []);
      setLastRefresh(new Date().toLocaleTimeString());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  };

  const refresh = async (): Promise<void> => {
    setError(null);
    try {
      await loadSessions();
      if (selectedSessionId) await loadSession(selectedSessionId);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  };

  const createSession = async (): Promise<void> => {
    setError(null);
    try {
      const created = await postJson<{ session: PiSessionDetail }>('/api/pi-sessions', { title });
      setTitle('');
      await loadSessions();
      await loadSession(created.session.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    }
  };

  const sendPrompt = async (): Promise<void> => {
    if (!selectedSessionId || !prompt.trim()) return;
    setError(null);
    try {
      await postJson<{ session: PiSessionSummary; events: PiSessionEvent[] }>(`/api/pi-sessions/${encodeURIComponent(selectedSessionId)}/prompts`, { prompt });
      setPrompt('');
      await loadSessions();
      await loadSession(selectedSessionId);
    } catch (promptError) {
      setError(promptError instanceof Error ? promptError.message : String(promptError));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <>
      <section className="panel">
        <h2>Pi Sessions</h2>
        <p className="muted">Pi sessions use the real Pi SDK by default. Set TESSERAFT_PI_ADAPTER=fake on the web server only when you explicitly want local fake responses.</p>
        {error && <div className="error">{error}</div>}
        <div className="control-card pi-session-create">
          <label>
            Optional title
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Pi session title" />
          </label>
          <button type="button" onClick={() => void createSession()}>Create session</button>
          <button type="button" onClick={() => void refresh()}>Refresh sessions</button>
        </div>
        <ul className="item-list">
          {sessions.length === 0 && <li className="muted">No Pi sessions yet. Create one locally to start.</li>}
          {sessions.map((session) => (
            <li key={session.id} className={session.id === selectedSessionId ? 'selected-row' : ''}>
              <button type="button" onClick={() => void loadSession(session.id)}>{session.title}</button>
              <span>{session.id} — {session.status} — {session.event_count} events</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="panel detail">
        <h2>Pi session detail</h2>
        {!selectedSession && <div className="empty">Select or create a Pi session.</div>}
        {selectedSession && (
          <>
            <dl className="field-row">
              <dt>Session ID</dt><dd>{selectedSession.id}</dd>
              <dt>Title</dt><dd>{selectedSession.title}</dd>
              <dt>Status</dt><dd>{selectedSession.status}</dd>
              <dt>Last refresh</dt><dd>{lastRefresh || 'not refreshed'}</dd>
            </dl>
            <div className="control-card pi-prompt-form">
              <label>
                Prompt
                <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Send a prompt to the local Pi session" />
              </label>
              <button type="button" disabled={!prompt.trim()} onClick={() => void sendPrompt()}>Send prompt</button>
              <button type="button" onClick={() => void loadSession(selectedSession.id)}>Refresh events</button>
            </div>
          </>
        )}
        <h3>Events / output</h3>
        <ol className="event-list pi-event-list">
          {events.length === 0 && <li className="muted">No Pi session events found.</li>}
          {events.map((event) => (
            <li key={event.id}>
              <code>{event.sequence}. {event.event}{event.role ? ` (${event.role})` : ''}</code>
              {event.text && <p>{event.text}</p>}
              <pre>{JSON.stringify(event, null, 2)}</pre>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
};
