import type { EventRecord, Liveness, RunDetail } from '../types/runConsole';

export const eventName = (event: EventRecord): string => event.event || event.type || 'event';
export const nodeForEvent = (event: EventRecord): string | undefined => event.state || event.from;
export const isActiveRun = (run: RunDetail | null): boolean => Boolean(run && !['done', 'failed', 'error', 'cancelled'].includes(run.status || ''));
export const snippet = (value: unknown): string => JSON.stringify(value, null, 2).slice(0, 700);

export const TERMINAL_LIVENESS: Liveness[] = ['done', 'failed', 'cancelled'];
export const isTerminalLiveness = (liveness: Liveness | undefined | null): boolean =>
  liveness != null && TERMINAL_LIVENESS.includes(liveness);

/** A run is finished if its liveness is terminal, or its status is terminal/errored. */
export const TERMINAL_STATUS = ['done', 'failed', 'error', 'cancelled'] as const;
export const isFinishedRun = (run: { liveness?: Liveness | null; status?: string }): boolean =>
  isTerminalLiveness(run.liveness) || (run.status != null && (TERMINAL_STATUS as readonly string[]).includes(run.status));

/** Maps a run's liveness (or status fallback) to a status-pill class name. */
export const livenessPillClass = (run: { status?: string; liveness?: Liveness | null }): string => {
  if (run.liveness) return run.liveness;
  if (run.status === 'done') return 'done';
  if (run.status === 'cancelled') return 'cancelled';
  if (run.status === 'failed' || run.status === 'error') return 'failed';
  return 'parked';
};

/** Human label for a staleness duration, e.g. "no events for 142s". */
export const stalenessLabel = (seconds: number | null | undefined): string | null => {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const rounded = Math.floor(seconds);
  return `no events for ${rounded}s`;
};

/** Compact human duration like "2m13s" / "3h" / "42s". Null-safe. */
export const formatDuration = (seconds: number | null | undefined): string => {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  if (total < 1) return '0s';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ''}`;
  if (minutes > 0) return `${minutes}m${secs > 0 ? `${secs}s` : ''}`;
  return `${secs}s`;
};

/** Elapsed since `created_at` to `updated_at`/now. Null-safe: returns `—` if missing. */
export const runDurationLabel = (run: { created_at?: string | null; updated_at?: string | null }): string => {
  if (!run.created_at) return '—';
  const start = Date.parse(run.created_at);
  if (!Number.isFinite(start)) return '—';
  const endRaw = run.updated_at ? Date.parse(run.updated_at) : NaN;
  const end = Number.isFinite(endRaw) ? endRaw : Date.now();
  const seconds = (end - start) / 1000;
  return formatDuration(seconds);
};
