/**
 * QueueDispatchLoop — the worker pool (M4 / ai-os-design § 5).
 *
 * "Workers" are not processes: this loop claims due tasks and spawns the
 * headless CLI runs that ARE the workers (invariant 1 — the model loop lives
 * in the agent CLI, never in Alice). Each tick it:
 *
 *   1. asks the store which tasks fit the lane/global budget,
 *   2. drops any whose `dependsOn` issues are not terminal yet,
 *   3. claims each by exclusive create, then spawns it,
 *   4. on terminal outcome: retries with backoff (`notBefore`) or releases and
 *      fires the `chain` follow-up.
 *
 * The loop owns NO scheduling semantics of its own — cadence lives in issue
 * files (ScheduleScanner) and ordering lives in the queue's filenames.
 */

import type { Logger } from '../logger.js'
import { isRetryableOutcome, type HeadlessOutcome } from '../headless-task.js'
import type { TaskQueueStore } from './store.js'
import type { QueueTask, RunningTask } from './types.js'

export const DEFAULT_TICK_MS = 1_000

export interface DispatchLoopDeps {
  store: TaskQueueStore
  logger: Logger
  /**
   * Run one claimed task to completion. Returns its classified outcome — the
   * loop stays ignorant of adapters, prompts and process mechanics.
   */
  runTask: (task: RunningTask) => Promise<HeadlessOutcome>
  /**
   * Are every one of these issue ids terminal (done/canceled) in `wsId`?
   * Absent ⇒ dependencies are treated as satisfied.
   */
  dependenciesMet?: (wsId: string, issueIds: string[]) => Promise<boolean>
  /** Build a follow-up task from a chain reference; null ⇒ nothing to enqueue. */
  buildChainTask?: (parent: QueueTask, issueId: string) => Promise<QueueTask | null>
  /**
   * Called just before a retryable task is re-queued, with the NEXT attempt
   * number. The owner uses it to reset the run record back to `queued` so the
   * panel does not show a retrying task as failed-and-finished.
   */
  onRetry?: (task: RunningTask, nextAttempt: number) => Promise<void>
  /**
   * Called once a task reaches a TERMINAL outcome (no retry left / not
   * retryable), after its queue entry is released. The owner uses it for
   * side-effects the queue must not know about — closing a one-shot issue.
   */
  onTerminal?: (task: RunningTask, outcome: HeadlessOutcome) => Promise<void>
  now?: () => number
  tickMs?: number
}

export class QueueDispatchLoop {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private ticking = false
  /** Ids currently executing in THIS process (guards against double-spawn). */
  private readonly inFlight = new Set<string>()
  private readonly now: () => number
  private readonly tickMs: number

  constructor(private readonly deps: DispatchLoopDeps) {
    this.now = deps.now ?? Date.now
    this.tickMs = deps.tickMs ?? DEFAULT_TICK_MS
  }

  /** Reconcile orphans from a previous process, then begin ticking. */
  async start(): Promise<void> {
    if (this.timer || this.stopped) return
    await this.deps.store.reconcile()
    this.arm()
    this.deps.logger.info('queue.loop_started', { tickMs: this.tickMs })
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** In-flight count — used by tests and the capacity view. */
  activeCount(): number {
    return this.inFlight.size
  }

  private arm(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => void this.tickAndRearm(), this.tickMs)
    this.timer.unref?.()
  }

  private async tickAndRearm(): Promise<void> {
    this.timer = null
    if (this.stopped) return
    try {
      await this.tick()
    } catch (err) {
      this.deps.logger.warn('queue.tick_failed', { err })
    }
    if (!this.stopped) this.arm()
  }

  /** One pass: claim what fits and spawn it. Public for tests / "run now". */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const entry of await this.deps.store.claimable(this.now())) {
        if (this.stopped) break
        if (this.inFlight.has(entry.task.id)) continue

        // Dependency gate: hold the task until its blockers are terminal.
        const deps = entry.task.dependsOn ?? []
        if (deps.length > 0 && this.deps.dependenciesMet) {
          if (!(await this.deps.dependenciesMet(entry.task.wsId, deps))) {
            continue // stays pending; re-evaluated next tick
          }
        }

        const claimed = await this.deps.store.claim(entry)
        if (!claimed) continue // another claimer won

        this.inFlight.add(claimed.id)
        // Fire-and-forget: the loop must keep claiming while runs execute.
        void this.execute(claimed).finally(() => this.inFlight.delete(claimed.id))
      }
    } finally {
      this.ticking = false
    }
  }

  /** Run one claimed task, then retry / release / chain. */
  private async execute(task: RunningTask): Promise<void> {
    let outcome: HeadlessOutcome
    try {
      outcome = await this.deps.runTask(task)
    } catch (err) {
      this.deps.logger.warn('queue.run_failed', { id: task.id, wsId: task.wsId, err })
      outcome = 'error'
    }

    if (isRetryableOutcome(outcome) && task.attempt < task.maxAttempts) {
      // Exponential backoff expressed as a claim gate, so the delay survives a
      // restart (unlike M3's in-memory timer, which a shutdown silently lost).
      const nextAttempt = task.attempt + 1
      const notBefore = this.now() + task.backoffMs * 2 ** (task.attempt - 1)
      if (this.deps.onRetry) {
        try {
          await this.deps.onRetry(task, nextAttempt)
        } catch (err) {
          this.deps.logger.warn('queue.retry_hook_failed', { id: task.id, err })
        }
      }
      await this.deps.store.requeue(task, { attempt: nextAttempt, notBefore })
      this.deps.logger.info('queue.retry_scheduled', {
        id: task.id, wsId: task.wsId, issueId: task.issueId,
        outcome, attempt: task.attempt, maxAttempts: task.maxAttempts, notBefore,
      })
      return
    }

    await this.deps.store.release(task.id)

    if (this.deps.onTerminal) {
      try {
        await this.deps.onTerminal(task, outcome)
      } catch (err) {
        this.deps.logger.warn('queue.terminal_hook_failed', { id: task.id, err })
      }
    }

    const followUp = outcome === 'success' ? task.chain?.onSuccess : task.chain?.onFailure
    if (followUp && this.deps.buildChainTask) {
      try {
        const next = await this.deps.buildChainTask(task, followUp)
        if (next) {
          await this.deps.store.enqueue(next)
          this.deps.logger.info('queue.chain_enqueued', {
            parent: task.id, issueId: followUp, next: next.id, outcome,
          })
        }
      } catch (err) {
        this.deps.logger.warn('queue.chain_failed', { parent: task.id, issueId: followUp, err })
      }
    }
  }
}
