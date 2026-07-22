import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect, beforeEach, vi } from 'vitest'

import type { HeadlessOutcome } from '../headless-task.js'
import type { Logger } from '../logger.js'
import { QueueDispatchLoop } from './dispatch-loop.js'
import { TaskQueueStore } from './store.js'
import { PRIORITY, type QueueTask, type RunningTask } from './types.js'

const noopLogger = {
  info() {}, warn() {}, error() {}, debug() {}, child() { return noopLogger },
} as unknown as Logger

let root: string
let store: TaskQueueStore
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'qloop-'))
  store = await TaskQueueStore.open(noopLogger, root)
})

function task(over: Partial<QueueTask> = {}): QueueTask {
  return {
    id: over.id ?? `t-${Math.random().toString(16).slice(2, 10)}`,
    source: 'schedule',
    wsId: 'w1',
    agent: 'claude',
    prompt: 'go',
    lane: '',
    priority: PRIORITY.cron,
    attempt: 1,
    maxAttempts: 1,
    backoffMs: 30_000,
    timeoutMs: 60_000,
    notBefore: 0,
    createdAt: Date.now(),
    ...over,
  }
}

/** A loop whose runTask resolution we control, with never-firing timers. */
function loopWith(
  runTask: (t: RunningTask) => Promise<HeadlessOutcome>,
  extra: Partial<ConstructorParameters<typeof QueueDispatchLoop>[0]> = {},
) {
  return new QueueDispatchLoop({
    store, logger: noopLogger, runTask, tickMs: 10_000, ...extra,
  })
}

describe('QueueDispatchLoop', () => {
  it('claims and runs a due task, then releases it', async () => {
    const ran: string[] = []
    const loop = loopWith(async (t) => { ran.push(t.id); return 'success' })
    await store.enqueue(task({ id: 'a' }))
    await loop.tick()
    await vi.waitFor(async () => expect(await store.listRunning()).toHaveLength(0))
    expect(ran).toEqual(['a'])
    expect(await store.listPending()).toHaveLength(0)
  })

  it('per-workspace serial lane: two issues in one workspace never run concurrently', async () => {
    let concurrent = 0
    let peak = 0
    const release: Array<() => void> = []
    const loop = loopWith(async () => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      await new Promise<void>((r) => release.push(r))
      concurrent -= 1
      return 'success'
    })
    await store.enqueue(task({ id: 'w1-a', wsId: 'w1', createdAt: 1 }))
    await store.enqueue(task({ id: 'w1-b', wsId: 'w1', createdAt: 2 }))

    await loop.tick()
    await vi.waitFor(() => expect(concurrent).toBe(1))
    await loop.tick() // second tick while the first still runs
    expect(peak).toBe(1) // the lane held the sibling back

    release.forEach((r) => r())
    await vi.waitFor(async () => expect(loop.activeCount()).toBe(0))
    await loop.tick() // now the sibling may run
    await vi.waitFor(() => expect(peak).toBe(1))
  })

  it('different workspaces run in parallel', async () => {
    let concurrent = 0
    let peak = 0
    const release: Array<() => void> = []
    const loop = loopWith(async () => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      await new Promise<void>((r) => release.push(r))
      concurrent -= 1
      return 'success'
    })
    await store.enqueue(task({ id: 'w1', wsId: 'w1', createdAt: 1 }))
    await store.enqueue(task({ id: 'w2', wsId: 'w2', createdAt: 2 }))
    await loop.tick()
    await vi.waitFor(() => expect(peak).toBe(2))
    release.forEach((r) => r())
  })

  it('retries a failed task via notBefore backoff (durable, not an in-memory timer)', async () => {
    const now = 1_000_000
    const loop = loopWith(async () => 'error', { now: () => now })
    await store.enqueue(task({ id: 'r', attempt: 1, maxAttempts: 3, backoffMs: 30_000 }))
    await loop.tick()
    // requeue is release-then-enqueue: wait on the END state, not the gap.
    await vi.waitFor(async () => expect(await store.listPending()).toHaveLength(1))
    expect(await store.listRunning()).toHaveLength(0)

    const pending = await store.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.task.attempt).toBe(2)
    // The delay lives on disk, so a restart cannot lose it (the M3 gap).
    expect(pending[0]!.task.notBefore).toBe(now + 30_000)
  })

  it('fires onRetry with the next attempt BEFORE re-queuing (QA H-1 wiring)', async () => {
    const now = 1_000_000
    const calls: Array<{ id: string; nextAttempt: number }> = []
    const loop = loopWith(async () => 'error', {
      now: () => now,
      onRetry: async (t, nextAttempt) => { calls.push({ id: t.id, nextAttempt }) },
    })
    await store.enqueue(task({ id: 'r', attempt: 1, maxAttempts: 3 }))
    await loop.tick()
    await vi.waitFor(async () => expect(await store.listPending()).toHaveLength(1))
    expect(calls).toEqual([{ id: 'r', nextAttempt: 2 }])
  })

  it('stops retrying once attempts are exhausted', async () => {
    const loop = loopWith(async () => 'error')
    await store.enqueue(task({ id: 'x', attempt: 3, maxAttempts: 3 }))
    await loop.tick()
    await vi.waitFor(async () => expect(await store.listRunning()).toHaveLength(0))
    expect(await store.listPending()).toHaveLength(0)
  })

  it('does not retry a no-report outcome (a clean no-op would loop)', async () => {
    const loop = loopWith(async () => 'no-report')
    await store.enqueue(task({ id: 'n', attempt: 1, maxAttempts: 3 }))
    await loop.tick()
    await vi.waitFor(async () => expect(await store.listRunning()).toHaveLength(0))
    expect(await store.listPending()).toHaveLength(0)
  })

  it('chain.onSuccess enqueues the follow-up; onFailure does not fire', async () => {
    const built: string[] = []
    const loop = loopWith(async () => 'success', {
      buildChainTask: async (parent, issueId) => {
        built.push(issueId)
        return task({ id: `chained-${issueId}`, wsId: parent.wsId, source: 'chain' })
      },
    })
    await store.enqueue(task({ id: 'p', chain: { onSuccess: 'next-issue', onFailure: 'oops' } }))
    await loop.tick()
    await vi.waitFor(async () => expect(await store.listPending()).toHaveLength(1))
    expect(built).toEqual(['next-issue'])
    expect((await store.listPending())[0]!.task.source).toBe('chain')
  })

  it('chain.onFailure fires on a failed terminal outcome', async () => {
    const built: string[] = []
    const loop = loopWith(async () => 'error', {
      buildChainTask: async (_p, issueId) => { built.push(issueId); return null },
    })
    // maxAttempts 1 ⇒ the failure is terminal, so the chain fires.
    await store.enqueue(task({ id: 'p', maxAttempts: 1, chain: { onSuccess: 'good', onFailure: 'bad' } }))
    await loop.tick()
    await vi.waitFor(() => expect(built).toEqual(['bad']))
  })

  it('depends_on holds a task back until its blockers are terminal', async () => {
    let met = false
    const ran: string[] = []
    const loop = loopWith(async (t) => { ran.push(t.id); return 'success' }, {
      dependenciesMet: async () => met,
    })
    await store.enqueue(task({ id: 'blocked', dependsOn: ['prereq'] }))

    await loop.tick()
    expect(ran).toEqual([])                       // gated
    expect(await store.listPending()).toHaveLength(1) // still queued, not lost

    met = true
    await loop.tick()
    await vi.waitFor(() => expect(ran).toEqual(['blocked']))
  })

  it('a run that throws is treated as an error outcome, not a crash', async () => {
    const loop = loopWith(async () => { throw new Error('spawn blew up') })
    await store.enqueue(task({ id: 'boom', maxAttempts: 1 }))
    await loop.tick()
    await vi.waitFor(async () => expect(await store.listRunning()).toHaveLength(0))
    expect(await store.listPending()).toHaveLength(0)
  })

  it('start() reconciles orphans from a dead process before ticking', async () => {
    const orphan: RunningTask = {
      ...task({ id: 'ghost', attempt: 1, maxAttempts: 2 }),
      claimedAt: 1, claimedBy: 'dead-owner-nonce', claimedByPid: 0x7ffffff0,
    }
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(root, 'running', 'ghost.json'), JSON.stringify(orphan), 'utf8')
    const loop = loopWith(async () => 'success')
    await loop.start()
    loop.stop()
    const pending = await store.listPending()
    expect(pending.map((p) => p.task.id)).toEqual(['ghost'])
    expect(pending[0]!.task.attempt).toBe(2)
  })
})
