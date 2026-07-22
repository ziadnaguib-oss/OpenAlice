import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect, beforeEach } from 'vitest'

import { rmrf } from '@/spec-helpers/fs.js'
import type { Logger } from '../logger.js'
import { TaskQueueStore } from './store.js'
import { PRIORITY, resolveLane, type QueueTask, type RunningTask } from './types.js'

const noopLogger = {
  info() {}, warn() {}, error() {}, debug() {}, child() { return noopLogger },
} as unknown as Logger

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'queue-'))
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

const open = () => TaskQueueStore.open(noopLogger, root)

describe('TaskQueueStore claim protocol', () => {
  it('two claimers cannot both win the same task (100 iterations)', async () => {
    const store = await open()
    for (let i = 0; i < 100; i++) {
      const t = task({ id: `race-${i}` })
      await store.enqueue(t)
      const [entry] = await store.listPending()
      // Two concurrent claim attempts on the identical pending entry.
      const [a, b] = await Promise.all([store.claim(entry!), store.claim(entry!)])
      const winners = [a, b].filter((r): r is RunningTask => r !== null)
      expect(winners).toHaveLength(1)
      expect(winners[0]!.id).toBe(t.id)
      expect(await store.listPending()).toHaveLength(0)
      await store.release(t.id)
    }
  })

  it('claim records the owning pid and moves the file out of pending', async () => {
    const store = await open()
    const t = task()
    await store.enqueue(t)
    const claimed = await store.claim((await store.listPending())[0]!)
    expect(claimed?.claimedByPid).toBe(process.pid)
    expect(await store.listPending()).toHaveLength(0)
    expect((await store.listRunning()).map((r) => r.id)).toEqual([t.id])
  })

  it('claiming a vanished entry returns null instead of throwing', async () => {
    const store = await open()
    const t = task()
    await store.enqueue(t)
    const entry = (await store.listPending())[0]!
    expect(await store.claim(entry)).not.toBeNull()
    expect(await store.claim(entry)).toBeNull() // already gone
  })

  it('enqueue refuses to clobber an existing task id', async () => {
    const store = await open()
    const t = task({ id: 'dup', createdAt: 1 })
    await store.enqueue(t)
    await expect(store.enqueue(t)).rejects.toThrow()
  })
})

describe('claim ordering and capacity', () => {
  it('claims by priority first, then enqueue time', async () => {
    const store = await open()
    await store.enqueue(task({ id: 'cron-old', priority: PRIORITY.cron, createdAt: 1 }))
    await store.enqueue(task({ id: 'interactive', priority: PRIORITY.interactive, createdAt: 9 }))
    await store.enqueue(task({ id: 'event', priority: PRIORITY.event, createdAt: 5 }))
    const order = (await store.listPending()).map((e) => e.task.id)
    expect(order).toEqual(['interactive', 'event', 'cron-old'])
  })

  it('honours notBefore (retry backoff) — a future task is not claimable', async () => {
    const store = await open()
    const now = Date.now()
    await store.enqueue(task({ id: 'later', notBefore: now + 60_000 }))
    await store.enqueue(task({ id: 'now', notBefore: now - 1 }))
    const ids = (await store.claimable(now)).map((e) => e.task.id)
    expect(ids).toEqual(['now'])
  })

  it('per-workspace lane is serial: a second task in the same ws is held back', async () => {
    const store = await open()
    await store.enqueue(task({ id: 'a', wsId: 'w1', createdAt: 1 }))
    await store.enqueue(task({ id: 'b', wsId: 'w1', createdAt: 2 }))
    await store.enqueue(task({ id: 'c', wsId: 'w2', createdAt: 3 }))
    // Nothing running yet: w1 may start ONE, w2 may start one.
    const first = await store.claimable(Date.now())
    expect(first.map((e) => e.task.id).sort()).toEqual(['a', 'c'])

    await store.claim(first.find((e) => e.task.id === 'a')!)
    // With w1 busy, 'b' must wait; w2's 'c' is still free.
    const second = await store.claimable(Date.now())
    expect(second.map((e) => e.task.id)).toEqual(['c'])
  })

  it('respects the global concurrency cap', async () => {
    const store = await open()
    await store.writeLanes({ globalConcurrency: 2, perWorkspaceSerial: false, lanes: {} })
    for (let i = 0; i < 5; i++) await store.enqueue(task({ id: `g${i}`, createdAt: i }))
    expect(await store.claimable(Date.now())).toHaveLength(2)
  })

  it('named lanes get their own concurrency (fan-out)', async () => {
    const store = await open()
    await store.writeLanes({ globalConcurrency: 8, perWorkspaceSerial: true, lanes: { fanout: { concurrency: 3 } } })
    for (let i = 0; i < 5; i++) await store.enqueue(task({ id: `f${i}`, lane: 'fanout', createdAt: i }))
    expect(await store.claimable(Date.now())).toHaveLength(3)
  })

  it('default lane config restores pre-M4 behavior when perWorkspaceSerial is off', async () => {
    const store = await open()
    await store.writeLanes({ globalConcurrency: 8, perWorkspaceSerial: false, lanes: {} })
    for (let i = 0; i < 10; i++) await store.enqueue(task({ id: `p${i}`, wsId: 'w1', createdAt: i }))
    expect(await store.claimable(Date.now())).toHaveLength(8) // the old flat cap
  })
})

describe('crash reconcile', () => {
  it('re-queues a task orphaned by a dead owner exactly once, with attempt+1', async () => {
    const store = await open()
    const t = task({ id: 'orphan', attempt: 1, maxAttempts: 3 })
    // Simulate a previous Alice: a running entry owned by an impossible pid.
    const dead: RunningTask = { ...t, claimedAt: Date.now() - 1000, claimedBy: 'dead-owner-nonce', claimedByPid: 0x7ffffff0 }
    await writeFile(join(root, 'running', 'orphan.json'), JSON.stringify(dead), 'utf8')

    const first = await store.reconcile()
    expect(first.requeued).toEqual(['orphan'])
    expect(await store.listRunning()).toHaveLength(0)
    const pending = await store.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.task.attempt).toBe(2)

    // Idempotent: a second boot must not duplicate it.
    const second = await store.reconcile()
    expect(second.requeued).toEqual([])
    expect(await store.listPending()).toHaveLength(1)
  })

  it('re-queues an orphan even when its recorded PID is ALIVE (PID reuse, QA M-2)', async () => {
    // The killer case: after a crash+reboot the OS reuses PIDs, so a dead
    // owner's PID can belong to a live process. Trusting PID liveness would
    // leave the run stranded. Using process.pid (definitely alive) + a foreign
    // owner nonce, reconcile must still recover it.
    const store = await open()
    const t = task({ id: 'reused-pid', attempt: 1, maxAttempts: 2 })
    const orphan: RunningTask = {
      ...t, claimedAt: 1, claimedBy: 'previous-process-nonce', claimedByPid: process.pid,
    }
    await writeFile(join(root, 'running', 'reused-pid.json'), JSON.stringify(orphan), 'utf8')
    const res = await store.reconcile()
    expect(res.requeued).toEqual(['reused-pid'])
    expect(await store.listRunning()).toHaveLength(0)
    expect((await store.listPending())[0]!.task.attempt).toBe(2)
  })

  it('leaves tasks owned by THIS live process alone', async () => {
    const store = await open()
    const t = task({ id: 'mine' })
    await store.enqueue(t)
    await store.claim((await store.listPending())[0]!)
    expect((await store.reconcile()).requeued).toEqual([])
    expect((await store.listRunning()).map((r) => r.id)).toEqual(['mine'])
  })

  it('abandons an orphan that has exhausted its attempts', async () => {
    const store = await open()
    const t = task({ id: 'spent', attempt: 3, maxAttempts: 3 })
    const dead: RunningTask = { ...t, claimedAt: 1, claimedBy: 'dead-owner-nonce', claimedByPid: 0x7ffffff0 }
    await writeFile(join(root, 'running', 'spent.json'), JSON.stringify(dead), 'utf8')
    const res = await store.reconcile()
    expect(res.abandoned).toEqual(['spent'])
    expect(await store.listPending()).toHaveLength(0)
    expect(await store.listRunning()).toHaveLength(0)
  })

  it('never re-hands a task whose running entry exists (claim crash window)', async () => {
    // Simulate a crash between claim's exclusive-create and its pending cleanup:
    // both files exist for the same id.
    const store = await open()
    const t = task({ id: 'halfclaimed' })
    await store.enqueue(t)
    const entry = (await store.listPending())[0]!
    await writeFile(
      join(root, 'running', 'halfclaimed.json'),
      JSON.stringify({ ...t, claimedAt: Date.now(), claimedByPid: process.pid }),
      'utf8',
    )
    expect(entry).toBeDefined()
    expect(await store.claimable(Date.now())).toHaveLength(0)
    // And releasing sweeps the stale pending file so it cannot resurrect.
    await store.release('halfclaimed')
    expect(await store.listPending()).toHaveLength(0)
  })

  it('activeTaskFor finds a pending or running task by issue, ignoring other issues', async () => {
    const store = await open()
    await store.enqueue(task({ id: 'p1', wsId: 'w1', issueId: 'daily', createdAt: 1 }))
    expect(await store.activeTaskFor('w1', 'daily')).toBe('p1')
    expect(await store.activeTaskFor('w1', 'other')).toBeNull()
    expect(await store.activeTaskFor('w2', 'daily')).toBeNull() // wrong ws
    await store.claim((await store.listPending())[0]!)
    expect(await store.activeTaskFor('w1', 'daily')).toBe('p1') // now running, still found
    await store.release('p1')
    expect(await store.activeTaskFor('w1', 'daily')).toBeNull() // gone
  })

  it('a corrupt pending file does not wedge the queue', async () => {
    const store = await open()
    await writeFile(join(root, 'pending', '030-1-broken.json'), '{ not json', 'utf8')
    await store.enqueue(task({ id: 'good', createdAt: 2 }))
    const ids = (await store.listPending()).map((e) => e.task.id)
    expect(ids).toEqual(['good'])
  })
})

describe('lane resolution', () => {
  it('defaults to the per-workspace serial lane, or global when disabled', () => {
    const on = { globalConcurrency: 8, perWorkspaceSerial: true, lanes: {} }
    const off = { globalConcurrency: 8, perWorkspaceSerial: false, lanes: {} }
    expect(resolveLane({ lane: '', wsId: 'w1' }, on)).toBe('ws:w1')
    expect(resolveLane({ lane: '', wsId: 'w1' }, off)).toBe('default')
    expect(resolveLane({ lane: 'fanout', wsId: 'w1' }, on)).toBe('fanout')
  })

  it('release removes the running file', async () => {
    const store = await open()
    await store.enqueue(task({ id: 'rel' }))
    await store.claim((await store.listPending())[0]!)
    await store.release('rel')
    expect(await readdir(join(root, 'running'))).toEqual([])
  })
})
