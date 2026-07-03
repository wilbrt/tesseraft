import type { Request } from 'express';
import { runControlPlane } from './cli.js';

/**
 * Build an approval-decision author from the request git-user identity,
 * matching the control-plane convention. Returns undefined when no configured
 * identity exists (the runtime then falls back to a default author).
 */
export const makeGitUserAuthor = async (_req: Request): Promise<{ name: string; email: string } | undefined> => {
  const result = await runControlPlane(['git-user']);
  const body = result.body as { git_user?: { name?: string | null; email?: string | null } } | undefined;
  const user = body?.git_user;
  if (user && user.name && user.email) return { name: String(user.name), email: String(user.email) };
  return undefined;
};

/**
 * Resolve the run directory path for a run id (used when a POST handler needs
 * to pass --run-dir to the runtime CLI, e.g. for `decide`). Returns null when
 * the run cannot be resolved or has no path.
 */
export const readRunDir = async (runId: string): Promise<string | null> => {
  const detail = await runControlPlane(['run', runId]);
  if (detail.status !== 200) return null;
  const run = (detail.body as { run?: { path?: unknown } } | undefined)?.run;
  return run && typeof run.path === 'string' ? run.path : null;
};