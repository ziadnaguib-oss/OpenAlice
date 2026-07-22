/**
 * TaskQueueStore — the durable, file-backed queue (M4 / ai-os-design § 5).
 *
 *   <OPENALICE_HOME>/data/queue/
 *   ├── pending/<priority>-<ts>-<id>.json   one file per waiting task
 *   ├── running/<id>.json                   claimed tasks (+ owner pid)
 *   └── lanes.json                          lane definitions + concurrency
 *
 * The claim is an EXCLUSIVE CREATE of `running/<id>.json` (`wx` →
 * `O_CREAT|O_EXCL`), followed by removing the pending file. Exactly one of N
 * concurrent claimers can create the file; the losers get EEXIST. That is the
 * whole mutual-exclusion mechanism — no lockfiles, no leases, no coordination
 * service.
 *
 * NOTE: ai-os-design § 5 originally specified claim-by-`rename`. That is NOT
 * safe on Windows — two concurrent `fs.rename` calls on the same source both
 * report success there (verified: sequential renames correctly ENOENT, but a
 * `Promise.all` pair of renames both fulfil, because libuv's Windows rename
 * retries internally). Exclusive create is atomic on both platforms, so it is
 * the primitive we use. The crash window (created running/, not yet removed
 * pending/) is closed by `claimable()` skipping ids already running and by
 * `release()` sweeping any lingering pending file for the id.
 *
 * There is deliberately NO `done/` journal: HeadlessTaskRegistry already is the
 * run journal (with its own pruning), and a second overlapping journal would be
 * two sources of truth for the same fact. A completed task's running file is
 * simply removed once the registry record is finalized.
 *
 * Crash safety: a `running/` entry records the PID of the Alice process that
 * claimed it. Headless children are in-process, so that PID dying orphans the
 * run — on boot any entry whose owner is gone is re-queued with attempt+1.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { dataPath } from '@/core/paths.js'
import type { Logger } from '../logger.js'

import {
  DEFAULT_LANES,
  laneConcurrency,
  pendingFileName,
  resolveLane,
  type LaneConfig,
  type QueueTask,
  type RunningTask,
} from './types.js'

export interface QueueSnapshot {
  pending: QueueTask[]
  running: RunningTask[]
  lanes: LaneConfig
}

export class TaskQueueStore {
  private lanesCache: LaneConfig | null = null
  /** Unique to THIS process lifetime — stamped on every claim so reconcile can
   *  tell "claimed by the live me" from "claimed by a dead previous process"
   *  without trusting PID liveness (PIDs get reused after a reboot). */
  private readonly ownerId = randomUUID()

  private constructor(
    private readonly root: string,
    private readonly logger: Logger,
  ) {}

  static async open(logger: Logger, root = dataPath('queue')): Promise<TaskQueueStore> {
    const store = new TaskQueueStore(root, logger)
    await mkdir(join(root, 'pending'), { recursive: true })
    await mkdir(join(root, 'running'), { recursive: true })
    return store
  }

  private pendingDir(): string { return join(this.root, 'pending') }
  private runningDir(): string { return join(this.root, 'running') }
  private lanesFile(): string { return join(this.root, 'lanes.json') }

  /** Lane config from disk (defaults when absent/corrupt), cached per process. */
  async lanes(): Promise<LaneConfig> {
    if (this.lanesCache) return this.lanesCache
    try {
      const raw = JSON.parse(await readFile(this.lanesFile(), 'utf8')) as Partial<LaneConfig>
      this.lanesCache = {
        globalConcurrency: typeof raw.globalConcurrency === 'number' ? raw.globalConcurrency : DEFAULT_LANES.globalConcurrency,
        perWorkspaceSerial: typeof raw.perWorkspaceSerial === 'boolean' ? raw.perWorkspaceSerial : DEFAULT_LANES.perWorkspaceSerial,
        lanes: raw.lanes && typeof raw.lanes === 'object' ? raw.lanes : {},
      }
    } catch {
      this.lanesCache = { ...DEFAULT_LANES }
    }
    return this.lanesCache
  }

  /** Write the lane config (used by the migration to seed defaults). */
  async writeLanes(cfg: LaneConfig): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await writeFile(this.lanesFile(), JSON.stringify(cfg, null, 2) + '\n', 'utf8')
    this.lanesCache = cfg
  }

  /**
   * The id of an ALREADY-ACTIVE (pending or running) task for this issue, or
   * null. Used to keep per-issue enqueues idempotent: a scheduled issue that is
   * blocked on a dependency must not accumulate a fresh copy every tick, and a
   * chained follow-up must not double up with the issue's own schedule.
   */
  async activeTaskFor(wsId: string, issueId: string): Promise<string | null> {
    for (const { task } of await this.listPending()) {
      if (task.wsId === wsId && task.issueId === issueId) return task.id
    }
    for (const task of await this.listRunning()) {
      if (task.wsId === wsId && task.issueId === issueId) return task.id
    }
    return null
  }

  /** Add a task. The filename encodes claim order, so no index is needed. */
  async enqueue(task: QueueTask): Promise<void> {
    const file = join(this.pendingDir(), pendingFileName(task))
    // `wx` — never clobber an existing task with the same id.
    await writeFile(file, JSON.stringify(task, null, 2) + '\n', { flag: 'wx' })
  }

  /** Pending tasks in claim order (priority, then enqueue time). */
  async listPending(): Promise<Array<{ file: string; task: QueueTask }>> {
    let names: string[]
    try {
      names = await readdir(this.pendingDir())
    } catch {
      return []
    }
    const out: Array<{ file: string; task: QueueTask }> = []
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      const file = join(this.pendingDir(), name)
      try {
        out.push({ file, task: JSON.parse(await readFile(file, 'utf8')) as QueueTask })
      } catch {
        // A half-written or corrupt entry must not wedge the loop.
        this.logger.warn('queue.pending_unreadable', { file })
      }
    }
    return out
  }

  async listRunning(): Promise<RunningTask[]> {
    let names: string[]
    try {
      names = await readdir(this.runningDir())
    } catch {
      return []
    }
    const out: RunningTask[] = []
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      try {
        out.push(JSON.parse(await readFile(join(this.runningDir(), name), 'utf8')) as RunningTask)
      } catch {
        this.logger.warn('queue.running_unreadable', { file: name })
      }
    }
    return out
  }

  /**
   * Try to claim a pending task by exclusively creating its `running/` entry.
   * Returns the running record on success, or null when another claimer won
   * (EEXIST) — the ONLY mutual-exclusion primitive in the queue.
   */
  async claim(entry: { file: string; task: QueueTask }): Promise<RunningTask | null> {
    const running: RunningTask = {
      ...entry.task,
      claimedAt: Date.now(),
      claimedBy: this.ownerId,
      claimedByPid: process.pid,
    }
    const dest = join(this.runningDir(), `${entry.task.id}.json`)
    try {
      // `wx` == O_CREAT|O_EXCL: atomic winner-takes-all on POSIX and Windows.
      await writeFile(dest, JSON.stringify(running, null, 2) + '\n', { flag: 'wx' })
    } catch {
      return null // lost the race — not an error
    }
    // Won. Drop the pending entry; if this fails the task is still protected
    // by the running/ entry (claimable() skips ids already running).
    try {
      await rm(entry.file, { force: true })
    } catch (err) {
      this.logger.warn('queue.pending_cleanup_failed', { id: entry.task.id, err })
    }
    return running
  }

  /** Drop a running entry — the run reached a terminal state. Also sweeps any
   *  pending file left behind by a crash between claim's two steps, so a
   *  completed task can never be resurrected. */
  async release(id: string): Promise<void> {
    await rm(join(this.runningDir(), `${id}.json`), { force: true })
    try {
      for (const name of await readdir(this.pendingDir())) {
        if (name.endsWith(`-${id}.json`)) {
          await rm(join(this.pendingDir(), name), { force: true })
        }
      }
    } catch { /* pending dir missing — nothing to sweep */ }
  }

  /** Move a running task back to pending (retry), applying backoff. */
  async requeue(task: QueueTask, opts: { attempt: number; notBefore: number }): Promise<void> {
    const next: QueueTask = { ...task, attempt: opts.attempt, notBefore: opts.notBefore }
    await this.release(task.id)
    try {
      await this.enqueue(next)
    } catch (err) {
      this.logger.warn('queue.requeue_failed', { id: task.id, err })
    }
  }

  /**
   * Boot reconcile: re-queue tasks claimed by a PREVIOUS process. Headless
   * children die with their Alice, so a `running/` entry not carrying this
   * process's `ownerId` is from a crashed predecessor and its run never
   * finished. Re-queued exactly once with attempt+1; a task that has exhausted
   * its attempts is released (the registry records the interruption).
   *
   * Ownership is by nonce, never PID: a rebooted host reuses PIDs, so a dead
   * owner's PID can read "alive" and silently defeat recovery.
   *
   * Returns the ids re-queued and abandoned, for logging/tests.
   */
  async reconcile(): Promise<{ requeued: string[]; abandoned: string[] }> {
    const requeued: string[] = []
    const abandoned: string[] = []
    for (const task of await this.listRunning()) {
      if (task.claimedBy === this.ownerId) continue // claimed by the live me
      if (task.attempt < task.maxAttempts) {
        await this.requeue(task, { attempt: task.attempt + 1, notBefore: Date.now() })
        requeued.push(task.id)
      } else {
        await this.release(task.id)
        abandoned.push(task.id)
      }
    }
    if (requeued.length > 0 || abandoned.length > 0) {
      this.logger.info('queue.reconciled', { requeued: requeued.length, abandoned: abandoned.length })
    }
    return { requeued, abandoned }
  }

  /** Read-only view for the API/UI. */
  async snapshot(): Promise<QueueSnapshot> {
    return {
      pending: (await this.listPending()).map((e) => e.task),
      running: await this.listRunning(),
      lanes: await this.lanes(),
    }
  }

  /**
   * Which tasks may be claimed right now: honours notBefore, global capacity,
   * and per-lane capacity (counting what is already running). Dependency
   * gating is applied by the caller, which owns issue state.
   */
  async claimable(nowMs: number): Promise<Array<{ file: string; task: QueueTask }>> {
    const cfg = await this.lanes()
    const running = await this.listRunning()
    if (running.length >= cfg.globalConcurrency) return []

    const perLane = new Map<string, number>()
    for (const r of running) {
      const lane = resolveLane(r, cfg)
      perLane.set(lane, (perLane.get(lane) ?? 0) + 1)
    }
    let budget = cfg.globalConcurrency - running.length
    // A pending file may linger if a crash hit between claim's create and its
    // cleanup — never hand back a task that is already running.
    const runningIds = new Set(running.map((r) => r.id))

    const out: Array<{ file: string; task: QueueTask }> = []
    for (const entry of await this.listPending()) {
      if (budget <= 0) break
      if (runningIds.has(entry.task.id)) continue
      if (entry.task.notBefore > nowMs) continue
      const lane = resolveLane(entry.task, cfg)
      const used = perLane.get(lane) ?? 0
      if (used >= laneConcurrency(lane, cfg)) continue
      perLane.set(lane, used + 1) // reserve so one tick cannot oversubscribe
      budget -= 1
      out.push(entry)
    }
    return out
  }
}
