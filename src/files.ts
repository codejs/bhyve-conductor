import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';

export interface AtomicWriteOptions {
  /** File permissions for the new file (e.g. those of the file it replaces). */
  mode?: number;
  /**
   * Called after the new content is written and just before it replaces the target; throw to abort
   * (e.g. the target changed meanwhile). The target is then left as it was.
   */
  beforeReplace?: () => Promise<void>;
}

/**
 * Replaces `path` with `data` so that a crash never leaves half a file, and without trusting anything
 * already in the folder:
 *  - the temporary file has an unpredictable name and is created exclusively ("wx"), so a file or
 *    symlink planted at that name makes the write fail instead of being followed (which would let
 *    whoever can write to the folder overwrite another file with our permissions);
 *  - rename() replaces the directory entry: if `path` itself is a symlink, the link is replaced, and the
 *    file it pointed to is left alone.
 */
export const writeFileAtomic = async (path: string, data: string, opts: AtomicWriteOptions = {}): Promise<void> => {
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let created = false;
  try {
    await writeFile(tmp, data, { encoding: 'utf8', flag: 'wx', ...(opts.mode !== undefined ? { mode: opts.mode } : {}) });
    created = true;
    await opts.beforeReplace?.();
    await rename(tmp, path);
  } catch (err) {
    // Clean up our own temporary file only: never remove something we didn't create.
    if (created) await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
};
