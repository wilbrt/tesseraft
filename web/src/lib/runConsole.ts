import type { EventRecord, Liveness, RunDetail } from '../types/runConsole';

export const eventName = (event: EventRecord): string => event.event || event.type || 'event';
export const nodeForEvent = (event: EventRecord): string | undefined => event.state || event.from;
export const isActiveRun = (run: RunDetail | null): boolean => Boolean(run && !['done', 'failed', 'error'].includes(run.status || ''));
export const snippet = (value: unknown): string => JSON.stringify(value, null, 2).slice(0, 700);

export const TERMINAL_LIVENESS: Liveness[] = ['done', 'failed'];
export const isTerminalLiveness = (liveness: Liveness | undefined | null): boolean =>
  liveness != null && TERMINAL_LIVENESS.includes(liveness);

/** Maps a run's liveness (or status fallback) to a status-pill class name. */
export const livenessPillClass = (run: { status?: string; liveness?: Liveness | null }): string => {
  if (run.liveness) return run.liveness;
  if (run.status === 'done') return 'done';
  if (run.status === 'failed' || run.status === 'error') return 'failed';
  return 'parked';
};

/** Human label for a staleness duration, e.g. "no events for 142s". */
export const stalenessLabel = (seconds: number | null | undefined): string | null => {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const rounded = Math.floor(seconds);
  return `no events for ${rounded}s`;
};
