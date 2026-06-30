import { useEffect, useState } from 'react';
import { getJson, postJson } from '../lib/api';
import type { PiChatMessage, PiSessionDetail, PiSessionEvent, PiSessionSummary } from '../types/piSessions';

const DEFAULT_VISIBLE_EVENTS = 50;

type PiSessionSnapshot = {
  session: PiSessionDetail;
  messages: PiChatMessage[];
};

const eventSummary = (event: PiSessionEvent): string => event.text || event.prompt || event.event;

export const PiSessionsPanel = () => {
  const [sessions, setSessions] = useState<PiSessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<PiSessionDetail | null>(null);
  const [messages, setMessages] = useState<PiChatMessage[]>([]);
  const [events, setEvents] = useState<PiSessionEvent[]>([]);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<'disconnected' | 'connected' | 'error'>('disconnected');
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(new Set());

  const applySnapshot = (snapshot: PiSessionSnapshot): void => {
    setSelectedSession(snapshot.session);
    setMessages(snapshot.messages || snapshot.session.messages || []);
    setEvents(snapshot.session.events || []);
    setLastRefresh(new Date().toLocaleTimeString());
  };

  const loadSessions = async (): Promise<PiSessionSummary[]> => {
    const data = await getJson<{ sessions: PiSessionSummary[] }>('/api/pi-sessions');
    setSessions(data.sessions || []);
    return data.sessions || [];
  };

  const loadSession = async (sessionId: string): Promise<void> => {
    setError(null);
    try {
      const detail = await getJson<{ session: PiSessionDetail }>(`/api/pi-sessions/${encodeURIComponent(sessionId)}`);
      setSelectedSessionId(sessionId);
      applySnapshot({ session: detail.session, messages: detail.session.messages || [] });
      setExpandedEventIds(new Set());
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
    const promptToSend = prompt;
    setPrompt('');
    setError(null);
    try {
      await postJson<{ session: PiSessionSummary; events: PiSessionEvent[]; messages: PiChatMessage[] }>(`/api/pi-sessions/${encodeURIComponent(selectedSessionId)}/prompts`, { prompt: promptToSend });
      await loadSessions();
    } catch (promptError) {
      setPrompt(promptToSend);
      setError(promptError instanceof Error ? promptError.message : String(promptError));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!selectedSessionId) {
      setStreamStatus('disconnected');
      return undefined;
    }

    const source = new EventSource(`/api/pi-sessions/${encodeURIComponent(selectedSessionId)}/stream`);
    setStreamStatus('connected');
    source.addEventListener('snapshot', (event) => {
      try {
        applySnapshot(JSON.parse((event as MessageEvent).data) as PiSessionSnapshot);
        setStreamStatus('connected');
      } catch (parseError) {
        setError(parseError instanceof Error ? parseError.message : String(parseError));
      }
    });
    source.onerror = () => setStreamStatus('error');

    return () => {
      source.close();
      setStreamStatus('disconnected');
    };
  }, [selectedSessionId]);

  const hiddenEventCount = Math.max(0, events.length - DEFAULT_VISIBLE_EVENTS);
  const visibleEvents = events.slice(-DEFAULT_VISIBLE_EVENTS);
  const toggleEvent = (eventId: string): void => {
    setExpandedEventIds((current) => {
      const next = new Set(current);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  };

  return (
    <>
      <section className="panel">
        <h2>Pi Sessions</h2>
        <p className="muted">Uses the real Pi SDK by default. Set TESSERAFT_PI_ADAPTER=fake on the web server only for local fake responses.</p>
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
              <span className="meta-line">{session.status} · {session.event_count} events · <code>{session.id}</code></span>
            </li>
          ))}
        </ul>
      </section>
      <section className="panel detail">
        <h2>Pi session chat</h2>
        {!selectedSession && <div className="empty">Select or create a Pi session.</div>}
        {selectedSession && (
          <>
            <dl className="field-row">
              <dt>Session ID</dt><dd>{selectedSession.id}</dd>
              <dt>Title</dt><dd>{selectedSession.title}</dd>
              <dt>Status</dt><dd>{selectedSession.status}</dd>
              <dt>Stream</dt><dd><span className={`status-pill ${streamStatus}`}>{streamStatus}</span></dd>
              <dt>Last refresh</dt><dd>{lastRefresh || 'not refreshed'}</dd>
            </dl>
            <div className="pi-chat-transcript" aria-label="Pi session chat transcript">
              {messages.length === 0 && <div className="empty">No chat messages yet. Send a prompt to start the conversation.</div>}
              {messages.map((message) => (
                <article key={message.id} className={`pi-chat-message ${message.role}`}>
                  <div className="pi-chat-meta">{message.role}{message.status ? ` · ${message.status}` : ''}</div>
                  <p>{message.text}</p>
                </article>
              ))}
            </div>
            <div className="control-card pi-prompt-form">
              <label>
                Prompt
                <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Send a prompt to the local Pi session" />
              </label>
              <button type="button" disabled={!prompt.trim()} onClick={() => void sendPrompt()}>Send prompt</button>
              <button type="button" onClick={() => void loadSession(selectedSession.id)}>Refresh chat</button>
            </div>
          </>
        )}
        <details className="pi-diagnostics" open={showDiagnostics} onToggle={(event) => setShowDiagnostics(event.currentTarget.open)}>
          <summary>Diagnostics: raw Pi session events</summary>
          {hiddenEventCount > 0 && (
            <p className="muted">Showing latest {visibleEvents.length} of {events.length} events to keep this view responsive.</p>
          )}
          <ol className="event-list pi-event-list" start={hiddenEventCount + 1}>
            {events.length === 0 && <li className="muted">No Pi session events found.</li>}
            {visibleEvents.map((event) => {
              const expanded = expandedEventIds.has(event.id);
              return (
                <li key={event.id}>
                  <div className="event-head">
                    <code>{event.sequence}. {event.event}{event.role ? ` (${event.role})` : ''}</code>
                    <button type="button" className="link-button" onClick={() => toggleEvent(event.id)}>{expanded ? 'Hide JSON' : 'Show JSON'}</button>
                  </div>
                  <p>{eventSummary(event)}</p>
                  {expanded && <pre>{JSON.stringify(event, null, 2)}</pre>}
                </li>
              );
            })}
          </ol>
        </details>
      </section>
    </>
  );
};
