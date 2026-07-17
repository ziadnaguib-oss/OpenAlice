/**
 * Append-only audit chain (M2 / SE-3).
 *
 * One JSONL file at `data/audit/audit.jsonl`. Each record carries the
 * sha256 of its canonical form chained to the previous record's hash, so
 * any in-place edit, deletion, or reordering breaks verification from that
 * point forward. This is tamper-EVIDENT, not tamper-proof: an attacker with
 * disk write access can truncate-and-rebuild — defending that requires an
 * off-host anchor, which is out of scope for a local-first tool.
 *
 * Writers (M2): token mint/revoke, auth lockouts, trading commit/reject/
 * push through the Alice proxy. The Action Gate (M9) joins later.
 */

import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { dataPath } from '@/core/paths.js'
import { logger } from '@/core/logger.js'

const log = logger.child({ scope: 'audit' })

export interface AuditRecord {
  seq: number
  ts: string
  /** Who acted: 'loopback', 'session:<sid8>', 'token:<id>', 'system'. */
  actor: string
  /** Dotted action id, e.g. 'token.mint', 'trading.push', 'auth.lockout'. */
  action: string
  details: Record<string, unknown>
  prevHash: string
  hash: string
}

export interface AuditVerifyResult {
  ok: boolean
  length: number
  /** Sequence number of the first broken record, when !ok. */
  brokenAt?: number
  reason?: string
}

const GENESIS_HASH = 'genesis'

const auditFile = (): string => dataPath('audit', 'audit.jsonl')

function recordHash(rec: Omit<AuditRecord, 'hash'>): string {
  // Canonical form: fixed key order via explicit array — JSON.stringify of
  // the object itself would depend on insertion order staying stable.
  const canonical = JSON.stringify([rec.seq, rec.ts, rec.actor, rec.action, rec.details, rec.prevHash])
  return createHash('sha256').update(canonical).digest('hex')
}

/** Serialized appender — concurrent appends must not interleave hashes. */
let tail: Promise<unknown> = Promise.resolve()
let last: { seq: number; hash: string } | null = null

async function loadTail(): Promise<{ seq: number; hash: string }> {
  if (last) return last
  try {
    const raw = await readFile(auditFile(), 'utf-8')
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    const final = lines.at(-1)
    if (final) {
      const rec = JSON.parse(final) as AuditRecord
      last = { seq: rec.seq, hash: rec.hash }
      return last
    }
  } catch { /* fresh chain */ }
  last = { seq: 0, hash: GENESIS_HASH }
  return last
}

/**
 * Append one audit record. Never throws — an audit failure must not break
 * the audited operation (it is logged loudly instead).
 */
export function appendAudit(entry: {
  actor: string
  action: string
  details?: Record<string, unknown>
}): Promise<void> {
  const p = tail.then(async () => {
    try {
      const prev = await loadTail()
      const body: Omit<AuditRecord, 'hash'> = {
        seq: prev.seq + 1,
        ts: new Date().toISOString(),
        actor: entry.actor,
        action: entry.action,
        details: entry.details ?? {},
        prevHash: prev.hash,
      }
      const rec: AuditRecord = { ...body, hash: recordHash(body) }
      const file = auditFile()
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, JSON.stringify(rec) + '\n', { mode: 0o600 })
      last = { seq: rec.seq, hash: rec.hash }
    } catch (err) {
      log.error('audit append failed', { err, action: entry.action })
    }
  })
  tail = p
  return p
}

/** Walk the whole chain and verify every link. */
export async function verifyAuditChain(): Promise<AuditVerifyResult> {
  let raw: string
  try {
    raw = await readFile(auditFile(), 'utf-8')
  } catch {
    return { ok: true, length: 0 }
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  let prevHash = GENESIS_HASH
  let prevSeq = 0
  for (const line of lines) {
    let rec: AuditRecord
    try {
      rec = JSON.parse(line) as AuditRecord
    } catch {
      return { ok: false, length: lines.length, brokenAt: prevSeq + 1, reason: 'unparseable record' }
    }
    if (rec.seq !== prevSeq + 1) {
      return { ok: false, length: lines.length, brokenAt: rec.seq, reason: 'sequence gap' }
    }
    if (rec.prevHash !== prevHash) {
      return { ok: false, length: lines.length, brokenAt: rec.seq, reason: 'previous-hash mismatch' }
    }
    const { hash, ...body } = rec
    if (recordHash(body) !== hash) {
      return { ok: false, length: lines.length, brokenAt: rec.seq, reason: 'record hash mismatch' }
    }
    prevHash = hash
    prevSeq = rec.seq
  }
  return { ok: true, length: lines.length }
}

/** Read the newest `limit` records (for the Settings/debug surface). */
export async function readAuditTail(limit = 100): Promise<AuditRecord[]> {
  try {
    const raw = await readFile(auditFile(), 'utf-8')
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    return lines.slice(-limit).map((l) => JSON.parse(l) as AuditRecord)
  } catch {
    return []
  }
}

/** Test-only: reset the in-process tail cache (file redirection via
 *  OPENALICE_HOME happens in spec setup). */
export function _resetAuditCacheForTest(): void {
  last = null
  tail = Promise.resolve()
}
