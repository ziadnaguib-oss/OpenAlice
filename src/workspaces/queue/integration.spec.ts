/**
 * Integration test across the REAL seam the queue unit tests mock: the
 * dispatch loop + store + a real HeadlessTaskRegistry, with a runTask that
 * mirrors service.ts's runQueuedTask (markRunning → run → complete) and an
 * onRetry that resets the record (requeueRecord). This is where QA H-1 lived —
 * the registry state across retries — and it had zero coverage before.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect, beforeEach, vi } from 'vitest'

import type { HeadlessOutcome, HeadlessTaskResult } from '../headless-task.js'
import { HeadlessTaskRegistry } from '../headless-task-registry.js'
import type { Logger } from '../logger.js'
import { QueueDispatchLoop } from './dispatch-loop.js'
import { TaskQueueStore } from './store.js'
import { PRIORITY, type QueueTask, type RunningTask } from './types.js'

const noopLogger = {
  info() {}, warn() {}, error() {}, debug() {}, child() { return noopLogger },
} as unknown as Logger

let root: string
let store: TaskQueueStore
let registry: HeadlessTaskRegistry

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'qint-'))
  store = await TaskQueueStore.open(noopLogger, join(root, 'queue'))
  registry = await HeadlessTaskRegistry.load(join(root, 'reg.json'), noopLogger)
})

function result(over: Partial<HeadlessTaskResult> = {}): HeadlessTaskResult {
  return {
    command: ['x'], cwd: '/', exitCode: 0, signal: null, killed: false, killReason: null,
    durationMs: 5, stdoutTail: '', stderrTail: '', agentSessionId: null, assistantText: 'reply',
    ...over,
  }
}

/** Mirror of service.ts runQueuedTask + onRetry, over the real registry. */
function wire(runResults: () => HeadlessTaskResult) {
  const runTask = async (task: RunningTask): Promise<HeadlessOutcome> => {
    await registry.markRunning(task.id, Date.now())
    const r = runResults()
    const outcome: HeadlessOutcome = r.killed ? 'timeout' : r.exitCode !== 0 ? 'error' : r.assistantText ? 'success' : 'no-report'
    await registry.complete(task.id, {
      status: outcome === 'success' || outcome === 'no-report' ? 'done' : 'failed',
      outcome, killReason: r.killReason, finishedAt: Date.now(),
      durationMs: r.durationMs, exitCode: r.exitCode, signal: r.signal, killed: r.killed,
    })
    return outcome
  }
  return new QueueDispatchLoop({
    store, logger: noopLogger, runTask, tickMs: 10_000,
    onRetry: (t, next) => registry.requeueRecord(t.id, next),
  })
}

function task(over: Partial<QueueTask> = {}): QueueTask {
  return {
    id: 'run-1', source: 'schedule', wsId: 'w1', agent: 'claude', prompt: 'go',
    lane: '', priority: PRIORITY.cron, attempt: 1, maxAttempts: 1, backoffMs: 30_000,
    timeoutMs: 60_000, notBefore: 0, createdAt: Date.now(), ...over,
  }
}

async function seed(t: QueueTask) {
  await registry.create({ taskId: t.id, status: 'queued', wsId: t.wsId, agent: t.agent, prompt: t.prompt, startedAt: Date.now(), attempt: t.attempt, maxAttempts: t.maxAttempts })
  await store.enqueue(t)
}

describe('queue ↔ registry integration', () => {
  it('a successful run flows queued → running → done with a real registry', async () => {
    const loop = wire(() => result({ assistantText: 'here you go' }))
    await seed(task({ id: 'ok' }))
    expect(registry.get('ok')?.status).toBe('queued')
    await loop.tick()
    await vi.waitFor(() => expect(registry.get('ok')?.status).toBe('done'))
    expect(registry.get('ok')?.outcome).toBe('success')
  })

  it('QA H-1: a retrying run shows running (not failed-finished) and advances attempt', async () => {
    let n = 0
    // Fail attempts 1 & 2, succeed on attempt 3.
    const loop = wire(() => (++n < 3 ? result({ exitCode: 1, assistantText: null }) : result()))
    const now = 5_000_000
    ;(loop as unknown as { now: () => number }).now = () => now
    await seed(task({ id: 'flaky', maxAttempts: 3 }))

    // Attempt 1 fails → the record must NOT be left terminal; it goes back to
    // `queued` for the retry with attempt advanced to 2.
    await loop.tick()
    await vi.waitFor(() => {
      const rec = registry.get('flaky')!
      expect(rec.status).toBe('queued')
      expect(rec.attempt).toBe(2)
      // Terminal fields from attempt 1 must be cleared, not lingering.
      expect(rec.finishedAt).toBeUndefined()
      expect(rec.outcome).toBeUndefined()
    })

    // The re-queued task carries the backoff on disk (durable).
    const pending = await store.listPending()
    expect(pending[0]!.task.notBefore).toBeGreaterThan(now)
  })

  it('reconcile on a fresh process re-queues an in-flight record and it can complete', async () => {
    // A run left `running` in the registry + a foreign-owner running/ entry:
    // the reboot path. A new store (new nonce) reconciles the orphan.
    await seed(task({ id: 'ghost', maxAttempts: 2 }))
    await registry.markRunning('ghost', Date.now())
    // Simulate the claim by a previous process.
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      join(root, 'queue', 'running', 'ghost.json'),
      JSON.stringify({ ...task({ id: 'ghost', maxAttempts: 2 }), claimedAt: 1, claimedBy: 'old', claimedByPid: process.pid }),
      'utf8',
    )
    const fresh = await TaskQueueStore.open(noopLogger, join(root, 'queue'))
    const loop = new QueueDispatchLoop({
      store: fresh, logger: noopLogger, tickMs: 10_000,
      runTask: async (t) => { await registry.markRunning(t.id, Date.now()); await registry.complete(t.id, { status: 'done', outcome: 'success', finishedAt: Date.now() }); return 'success' },
    })
    await loop.start() // reconciles the orphan back to pending
    await loop.tick() // start() arms a 10s timer with no immediate tick; drain now
    await vi.waitFor(async () => expect((await fresh.listPending()).length + (await fresh.listRunning()).length).toBe(0))
    loop.stop()
    expect(registry.get('ghost')?.status).toBe('done')
  })
})
