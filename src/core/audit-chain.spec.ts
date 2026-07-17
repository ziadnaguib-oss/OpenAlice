import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect, beforeEach, vi } from 'vitest'

type AuditModule = typeof import('./audit-chain.js')

let home: string

async function freshAudit(): Promise<AuditModule> {
  vi.resetModules()
  vi.stubEnv('OPENALICE_HOME', home)
  const mod = await import('./audit-chain.js')
  mod._resetAuditCacheForTest()
  return mod
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'audit-'))
})

const auditPath = () => join(home, 'data', 'audit', 'audit.jsonl')

describe('audit chain (SE-3)', () => {
  it('appends hash-linked records and verifies end-to-end', async () => {
    const a = await freshAudit()
    await a.appendAudit({ actor: 'token:ab12', action: 'token.mint', details: { id: 'x' } })
    await a.appendAudit({ actor: 'loopback', action: 'trading.push', details: { utaId: 'mock' } })
    await a.appendAudit({ actor: 'system', action: 'auth.lockout', details: { ip: '203.0.113.9' } })
    const result = await a.verifyAuditChain()
    expect(result).toEqual({ ok: true, length: 3 })
    const tail = await a.readAuditTail(2)
    expect(tail.map((r) => r.action)).toEqual(['trading.push', 'auth.lockout'])
    expect(tail[1]?.seq).toBe(3)
  })

  it('detects in-place tampering with a record body', async () => {
    const a = await freshAudit()
    await a.appendAudit({ actor: 'x', action: 'one' })
    await a.appendAudit({ actor: 'x', action: 'two' })
    await a.appendAudit({ actor: 'x', action: 'three' })
    const lines = (await readFile(auditPath(), 'utf-8')).trim().split('\n')
    const doctored = JSON.parse(lines[1] ?? '{}')
    doctored.details = { injected: true }
    lines[1] = JSON.stringify(doctored)
    await writeFile(auditPath(), lines.join('\n') + '\n')

    const result = await a.verifyAuditChain()
    expect(result.ok).toBe(false)
    expect(result.brokenAt).toBe(2)
    expect(result.reason).toBe('record hash mismatch')
  })

  it('detects deletion (sequence gap breaks the chain)', async () => {
    const a = await freshAudit()
    await a.appendAudit({ actor: 'x', action: 'one' })
    await a.appendAudit({ actor: 'x', action: 'two' })
    await a.appendAudit({ actor: 'x', action: 'three' })
    const lines = (await readFile(auditPath(), 'utf-8')).trim().split('\n')
    lines.splice(1, 1) // delete record #2
    await writeFile(auditPath(), lines.join('\n') + '\n')

    const result = await a.verifyAuditChain()
    expect(result.ok).toBe(false)
    expect(result.brokenAt).toBe(3)
  })

  it('an empty or absent chain verifies trivially', async () => {
    const a = await freshAudit()
    expect(await a.verifyAuditChain()).toEqual({ ok: true, length: 0 })
  })

  it('resumes the chain correctly across process restarts (tail reload)', async () => {
    const a1 = await freshAudit()
    await a1.appendAudit({ actor: 'x', action: 'before-restart' })
    const a2 = await freshAudit() // fresh module = fresh process
    await a2.appendAudit({ actor: 'x', action: 'after-restart' })
    const result = await a2.verifyAuditChain()
    expect(result).toEqual({ ok: true, length: 2 })
  })
})
