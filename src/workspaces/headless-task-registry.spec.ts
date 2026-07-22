import { rmrf } from '@/spec-helpers/fs.js'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HeadlessTaskRegistry, headlessLogPaths } from './headless-task-registry.js'
import type { Logger } from './logger.js'

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return noopLogger
  },
} as unknown as Logger

let dir: string
let path: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'htr-'))
  path = join(dir, 'tasks.json')
})
afterEach(async () => {
  // The registry deletes pruned tasks' log files fire-and-forget (`void rm(…)`),
  // which can race this recursive cleanup on Windows and throw ENOTEMPTY on the
  // parent dir. `maxRetries` makes fs.rm retry exactly this class of error.
  await rmrf(dir)
})

describe('HeadlessTaskRegistry', () => {
  it('create → running record, listed newest-first', async () => {
    const reg = await HeadlessTaskRegistry.load(path, noopLogger)
    const a = await reg.create({ wsId: 'w1', agent: 'codex', prompt: 'do A', startedAt: 1 })
    const b = await reg.create({ wsId: 'w2', agent: 'pi', prompt: 'do B', startedAt: 2 })
    expect(a.status).toBe('running')
    expect(reg.list().map((t) => t.taskId)).toEqual([b.taskId, a.taskId]) // newest-first
    expect(reg.runningCount()).toBe(2)
  })

  it('complete updates status; get returns it; runningCount drops', async () => {
    const reg = await HeadlessTaskRegistry.load(path, noopLogger)
    const a = await reg.create({ wsId: 'w1', agent: 'codex', prompt: 'x', startedAt: 1 })
    await reg.complete(a.taskId, { status: 'done', exitCode: 0, durationMs: 5, finishedAt: 2 })
    expect(reg.get(a.taskId)?.status).toBe('done')
    expect(reg.get(a.taskId)?.exitCode).toBe(0)
    expect(reg.runningCount()).toBe(0)
  })

  it('persists the classified outcome, killReason, and retry attempt (M3)', async () => {
    const reg = await HeadlessTaskRegistry.load(path, noopLogger)
    const a = await reg.create({
      wsId: 'w1', agent: 'claude', prompt: 'scan', startedAt: 1, issueId: 'daily', attempt: 2, maxAttempts: 3,
    })
    expect(a.attempt).toBe(2)
    expect(a.maxAttempts).toBe(3)
    await reg.complete(a.taskId, {
      status: 'failed', outcome: 'timeout', killed: true, killReason: 'idle', finishedAt: 2,
    })
    const reloaded = await HeadlessTaskRegistry.load(path, noopLogger)
    const rec = reloaded.get(a.taskId)
    expect(rec?.outcome).toBe('timeout')
    expect(rec?.killReason).toBe('idle')
    expect(rec?.attempt).toBe(2)
  })

  it('omits retry fields on a plain (non-retrying) run so the JSON stays clean', async () => {
    const reg = await HeadlessTaskRegistry.load(path, noopLogger)
    const a = await reg.create({ wsId: 'w1', agent: 'claude', prompt: 'x', startedAt: 1 })
    expect('attempt' in a).toBe(false)
    expect('maxAttempts' in a).toBe(false)
  })

  it('list filters by wsId / status / limit', async () => {
    const reg = await HeadlessTaskRegistry.load(path, noopLogger)
    const a = await reg.create({ wsId: 'w1', agent: 'codex', prompt: 'x', startedAt: 1 })
    await reg.create({ wsId: 'w2', agent: 'pi', prompt: 'y', startedAt: 2 })
    await reg.complete(a.taskId, { status: 'done' })
    expect(reg.list({ wsId: 'w2' }).length).toBe(1)
    expect(reg.list({ status: 'done' }).map((t) => t.taskId)).toEqual([a.taskId])
    expect(reg.list({ limit: 1 }).length).toBe(1)
  })

  it('records issueId when an issue fired the run; omits it for manual runs', async () => {
    const reg = await HeadlessTaskRegistry.load(path, noopLogger)
    const fired = await reg.create({ wsId: 'w1', agent: 'codex', prompt: 'x', startedAt: 1, issueId: 'daily-scan' })
    const manual = await reg.create({ wsId: 'w1', agent: 'codex', prompt: 'y', startedAt: 2 })
    expect(fired.issueId).toBe('daily-scan')
    // Manual runs leave the field absent (not undefined-valued) so the JSON stays clean.
    expect('issueId' in manual).toBe(false)
    // Persists across reload.
    const reg2 = await HeadlessTaskRegistry.load(path, noopLogger)
    expect(reg2.get(fired.taskId)?.issueId).toBe('daily-scan')
  })

  it('list filters by issueId (the issue detail Activity feed join)', async () => {
    const reg = await HeadlessTaskRegistry.load(path, noopLogger)
    const a = await reg.create({ wsId: 'w1', agent: 'codex', prompt: 'x', startedAt: 1, issueId: 'iss-a' })
    const b = await reg.create({ wsId: 'w1', agent: 'codex', prompt: 'y', startedAt: 2, issueId: 'iss-a' })
    await reg.create({ wsId: 'w1', agent: 'codex', prompt: 'z', startedAt: 3, issueId: 'iss-b' })
    await reg.create({ wsId: 'w1', agent: 'codex', prompt: 'm', startedAt: 4 }) // manual, no issueId
    // newest-first, only iss-a's runs.
    expect(reg.list({ wsId: 'w1', issueId: 'iss-a' }).map((t) => t.taskId)).toEqual([b.taskId, a.taskId])
  })

  it('stores the full task prompt (not truncated — collapsible in the UI)', async () => {
    const reg = await HeadlessTaskRegistry.load(path, noopLogger)
    const a = await reg.create({ wsId: 'w1', agent: 'codex', prompt: 'x'.repeat(1000), startedAt: 1 })
    expect(a.prompt.length).toBe(1000)
  })

  it('persists completed records across reload', async () => {
    const reg = await HeadlessTaskRegistry.load(path, noopLogger)
    const a = await reg.create({ wsId: 'w1', agent: 'codex', prompt: 'x', startedAt: 1 })
    await reg.complete(a.taskId, { status: 'done', finishedAt: 2 })
    const reg2 = await HeadlessTaskRegistry.load(path, noopLogger)
    expect(reg2.get(a.taskId)?.status).toBe('done')
  })

  it('reconcile-on-boot flips a leftover running task → interrupted', async () => {
    const reg = await HeadlessTaskRegistry.load(path, noopLogger)
    await reg.create({ wsId: 'w1', agent: 'codex', prompt: 'x', startedAt: 1 }) // stays running
    const reloaded = await HeadlessTaskRegistry.load(path, noopLogger)
    expect(reloaded.runningCount()).toBe(0)
    expect(reloaded.list()[0]?.status).toBe('interrupted')
  })

  it('M4: create with status queued + explicit taskId keeps one id across queue and registry', async () => {
    const reg = await HeadlessTaskRegistry.load(path, noopLogger)
    const a = await reg.create({ wsId: 'w1', agent: 'claude', prompt: 'x', startedAt: 1, taskId: 'task-42', status: 'queued' })
    expect(a.taskId).toBe('task-42')
    expect(a.status).toBe('queued')
    expect(reg.runningCount()).toBe(0) // queued is not running
    expect(reg.list({ status: 'queued' }).map((t) => t.taskId)).toEqual(['task-42'])
  })

  it('M4: markRunning flips queued → running, but no-ops on any other status', async () => {
    const reg = await HeadlessTaskRegistry.load(path, noopLogger)
    const q = await reg.create({ wsId: 'w1', agent: 'claude', prompt: 'x', startedAt: 1, taskId: 'q', status: 'queued' })
    await reg.markRunning('q', 99)
    expect(reg.get('q')?.status).toBe('running')
    expect(reg.get('q')?.startedAt).toBe(99)
    // A second markRunning (already running) must NOT reset startedAt.
    await reg.markRunning('q', 500)
    expect(reg.get('q')?.startedAt).toBe(99)
    // markRunning on a terminal record is a no-op.
    await reg.complete('q', { status: 'done', finishedAt: 2 })
    await reg.markRunning('q', 777)
    expect(reg.get('q')?.status).toBe('done')
    void q
  })

  it('M4: requeueRecord resets a failed record to queued, advances attempt, and clears terminal fields (QA H-1)', async () => {
    const reg = await HeadlessTaskRegistry.load(path, noopLogger)
    await reg.create({ wsId: 'w1', agent: 'claude', prompt: 'x', startedAt: 1, taskId: 'r', status: 'queued', attempt: 1, maxAttempts: 3 })
    await reg.markRunning('r', 10)
    await reg.complete('r', { status: 'failed', outcome: 'error', exitCode: 1, durationMs: 5, finishedAt: 20, killed: false, killReason: 'idle' })
    expect(reg.get('r')?.status).toBe('failed')

    await reg.requeueRecord('r', 2)
    const rec = reg.get('r')!
    expect(rec.status).toBe('queued')
    expect(rec.attempt).toBe(2)
    // Every terminal field from the prior attempt must be gone, not stale.
    expect(rec.finishedAt).toBeUndefined()
    expect(rec.durationMs).toBeUndefined()
    expect(rec.exitCode).toBeUndefined()
    expect(rec.outcome).toBeUndefined()
    expect(rec.killReason).toBeUndefined()
    expect(rec.error).toBeUndefined()
    // The clean state survives a reload (durable, not just in-memory).
    const reloaded = await HeadlessTaskRegistry.load(path, noopLogger)
    expect(reloaded.get('r')?.status).toBe('queued')
    expect(reloaded.get('r')?.attempt).toBe(2)
  })

  it('M4: boot reconcile leaves a queued record untouched (the durable queue owns it)', async () => {
    const reg = await HeadlessTaskRegistry.load(path, noopLogger)
    await reg.create({ wsId: 'w1', agent: 'claude', prompt: 'x', startedAt: 1, taskId: 'still-queued', status: 'queued' })
    const reloaded = await HeadlessTaskRegistry.load(path, noopLogger)
    // running → interrupted, but queued stays queued (not flipped to interrupted).
    expect(reloaded.get('still-queued')?.status).toBe('queued')
  })

  it('setAgentSessionId records the id mid-run and persists across reload', async () => {
    const reg = await HeadlessTaskRegistry.load(path, noopLogger)
    const a = await reg.create({ wsId: 'w1', agent: 'claude', prompt: 'x', startedAt: 1 })
    await reg.setAgentSessionId(a.taskId, '414d6b8c-95b4-4e01-8ffc-4b6332da17d4')
    expect(reg.get(a.taskId)?.agentSessionId).toBe('414d6b8c-95b4-4e01-8ffc-4b6332da17d4')
    const reloaded = await HeadlessTaskRegistry.load(path, noopLogger)
    expect(reloaded.get(a.taskId)?.agentSessionId).toBe('414d6b8c-95b4-4e01-8ffc-4b6332da17d4')
  })

  it('pruning past MAX_RECORDS deletes the dropped tasks\' log files', async () => {
    const logsDir = join(dir, 'logs')
    await mkdir(logsDir, { recursive: true })
    const reg = await HeadlessTaskRegistry.load(path, noopLogger, { logsDir })
    const first = await reg.create({ wsId: 'w1', agent: 'codex', prompt: 'old', startedAt: 1 })
    await reg.complete(first.taskId, { status: 'done' })
    const firstLogs = headlessLogPaths(logsDir, first.taskId)
    await writeFile(firstLogs.stdout, 'old stdout')
    await writeFile(firstLogs.stderr, 'old stderr')
    // Fill past MAX_RECORDS (200) so `first` (oldest finished) gets pruned.
    for (let i = 0; i < 200; i++) {
      const t = await reg.create({ wsId: 'w1', agent: 'codex', prompt: `t${i}`, startedAt: 2 + i })
      await reg.complete(t.taskId, { status: 'done' })
    }
    expect(reg.get(first.taskId)).toBeNull()
    // rm is fire-and-forget; give the event loop a tick.
    await new Promise((r) => setTimeout(r, 50))
    expect(existsSync(firstLogs.stdout)).toBe(false)
    expect(existsSync(firstLogs.stderr)).toBe(false)
  })
})
