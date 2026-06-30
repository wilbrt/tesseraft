import type { EventRecord, RunDetail } from '../types/runConsole';

export const eventName = (event: EventRecord): string => event.event || event.type || 'event';
export const nodeForEvent = (event: EventRecord): string | undefined => event.state || event.from;
export const isActiveRun = (run: RunDetail | null): boolean => Boolean(run && !['done', 'failed', 'error'].includes(run.status || ''));
export const snippet = (value: unknown): string => JSON.stringify(value, null, 2).slice(0, 700);
