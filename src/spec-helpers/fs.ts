/**
 * Shared filesystem helpers for Vitest specs. NOT part of the runtime — only
 * `*.spec.ts` files may import from `src/spec-helpers/`.
 */

import { rm } from 'node:fs/promises'

/**
 * Recursive, force-deleting `rm` with retries — the default cleanup for
 * spec temp dirs.
 *
 * Plain `rm(dir, { recursive: true, force: true })` races any concurrent
 * writer/deleter of the same tree (e.g. code under test doing fire-and-forget
 * file deletions) and throws ENOTEMPTY/EBUSY on Windows when the parent rmdir
 * lands mid-race. `maxRetries` makes Node retry exactly that error class
 * (EBUSY, EMFILE, ENFILE, ENOTEMPTY, EPERM) with linear backoff, while a
 * genuinely held handle still fails after the retries — so real leaks in the
 * code under test keep surfacing.
 */
export async function rmrf(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
