import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const safeWriteText = async (target: string, content: string): Promise<void> => {
  const parent = path.dirname(target);
  await fs.promises.mkdir(parent, { recursive: true });
  const temporary = path.join(parent, `.${path.basename(target)}.tmp-${randomUUID()}`);
  try {
    const handle = await fs.promises.open(temporary, 'wx');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(temporary, target);
    try {
      const directory = await fs.promises.open(parent, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch {
      // Directory fsync is unavailable on some supported filesystems.
    }
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

export const safeWriteJson = (target: string, value: unknown): Promise<void> =>
  safeWriteText(target, `${JSON.stringify(value, null, 2)}\n`);
