/**
 * 0015_task_queue — stand up the durable task queue (M4).
 *
 * Pre-M4 there was no queue: `dispatchHeadlessTask` spawned immediately under a
 * flat in-memory cap, so there is nothing to drain INTO the queue — a run that
 * was in flight when the old build stopped is already dead, and the registry's
 * own boot reconcile marks it `interrupted`.
 *
 * What this migration DOES do is make the rollback lever discoverable: it seeds
 * `data/queue/lanes.json` with the defaults so an operator can find and edit
 * the one file that restores pre-M4 behaviour (`perWorkspaceSerial: false` +
 * `globalConcurrency: 8` == the old flat cap of 8).
 *
 * Idempotent: an existing lanes.json is never overwritten, and the directories
 * are created with `recursive: true`.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { dataPath } from '@/core/paths.js'
import type { Migration } from '../types.js'
import { DEFAULT_LANES } from '../../workspaces/queue/types.js'

export const migration: Migration = {
  id: '0015_task_queue',
  appVersion: '0.75.0-beta',
  introducedAt: '2026-07-18',
  affects: ['queue/lanes.json'],
  summary: 'Create the durable task-queue directories and seed the default lane config.',
  up: async () => {
    const root = dataPath('queue')
    await mkdir(join(root, 'pending'), { recursive: true })
    await mkdir(join(root, 'running'), { recursive: true })
    try {
      // `wx` — never clobber an operator's tuned lane config on re-run.
      await writeFile(
        join(root, 'lanes.json'),
        JSON.stringify(DEFAULT_LANES, null, 2) + '\n',
        { flag: 'wx' },
      )
    } catch {
      // Already present — nothing to seed.
    }
  },
}
