import fs from 'node:fs';
import path from 'node:path';

export const isPathWithin = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

export const resolveWithin = (root: string, candidate: string): string | null => {
  const resolved = path.resolve(root, candidate);
  return isPathWithin(root, resolved) ? resolved : null;
};

export const canonicalRoots = (roots: string[] = []): string[] => roots.map((root) => fs.realpathSync(root));

export const isWithinAny = (candidate: string, roots: string[]): boolean => roots.some((root) => isPathWithin(root, candidate));
