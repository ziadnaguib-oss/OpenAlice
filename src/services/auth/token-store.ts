/**
 * Admin token store.
 *
 * The single source of "is this the legitimate operator." A 32-byte random
 * token generated on first run. The plaintext is shown ONCE (stdout + the
 * post-bootstrap caller). On disk we keep only a scrypt-derived hash so
 * `cat data/config/auth.json` doesn't leak the live credential.
 *
 * Threat model assumptions (see safe/THREAT_MODEL.md):
 *  - Token is the only "identity." There is no user concept.
 *  - We trust the disk inode permissions to be tight (chmod 600).
 *  - We do NOT defend against host root — root can read anything.
 *  - We DO defend against accidental log-spillage and stale backups
 *    revealing the live token.
 */

import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile, chmod, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dataPath } from '@/core/paths.js'
import { isTokenScope, type TokenScope } from './scopes.js'

const TOKEN_BYTES = 32         // 256 bits of entropy
const SALT_BYTES = 16
const KEY_LEN = 64
// scrypt parameters: N=16384, r=8, p=1 is the OWASP-recommended floor for
// interactive-login workloads as of 2024.
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1

const AUTH_FILE = () => dataPath('config', 'auth.json')

interface AdminRecord {
  scheme: 'scrypt'
  salt: string        // base64
  hash: string        // base64
  params: { N: number; r: number; p: number; keyLen: number }
  createdAt: string
  lastRotatedAt: string
}

/** v1 layout — the admin record at top level. Read transparently forever;
 *  migration 0014 rewrites it to v2. */
interface AuthFileV1 extends AdminRecord {
  version: 1
}

/**
 * Scoped API token (M2 / SE-2). The plaintext is `oat_<id>_<secret>` —
 * the embedded id makes verification an O(1) lookup instead of trying
 * every record. The secret is hashed with sha256, NOT scrypt: these are
 * 256-bit machine-generated values (never human-chosen), so brute force
 * is infeasible regardless of hash speed, and bearer verification sits on
 * hot request paths where scrypt's deliberate ~50ms cost would be pure
 * waste. The admin token keeps scrypt (it transits human surfaces: clipboards,
 * password managers, the login form).
 */
export interface ApiTokenRecord {
  id: string
  label: string
  scopes: TokenScope[]
  sha256: string      // base64 of sha256(secret)
  createdAt: string
  lastUsedAt?: string
  revokedAt?: string
}

interface AuthFileV2 {
  version: 2
  admin: AdminRecord
  apiTokens: ApiTokenRecord[]
}

type AuthFile = AuthFileV1 | AuthFileV2

export interface TokenInfo {
  /** True iff `auth.json` exists with a valid record. */
  exists: boolean
  createdAt?: string
  lastRotatedAt?: string
}

/** Read auth.json in either format, normalized to the v2 shape. */
async function readAuthFile(): Promise<AuthFileV2 | null> {
  try {
    const raw = await readFile(AUTH_FILE(), 'utf-8')
    const parsed = JSON.parse(raw) as AuthFile
    if (parsed.version === 2 && parsed.admin?.scheme === 'scrypt') return parsed
    if (parsed.version === 1 && parsed.scheme === 'scrypt') {
      // Legacy single-token layout — normalize in memory; migration 0014
      // rewrites the file on disk.
      const { version: _v, ...admin } = parsed
      return { version: 2, admin, apiTokens: [] }
    }
    return null
  } catch {
    return null
  }
}

async function writeAuthFile(file: AuthFileV2): Promise<void> {
  const path = AUTH_FILE()
  await mkdir(dirname(path), { recursive: true })
  const data = JSON.stringify(file, null, 2) + '\n'
  // Tight permissions: only owner can read. Important because the hash, if
  // leaked alongside the salt, could in principle be brute-forced. 256-bit
  // input makes that infeasible, but defense in depth still wants chmod 600.
  await writeFile(path, data, { mode: 0o600 })
  // Some platforms ignore the `mode` option on writeFile (windows, certain
  // Docker images with restrictive umask). Force a second chmod to be sure
  // — best-effort, ignore failures on platforms that don't support it.
  await chmod(path, 0o600).catch(() => { /* noop */ })
}

function deriveHash(token: string, salt: Buffer): Buffer {
  return scryptSync(token, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
}

/**
 * Generate a fresh admin token, persist its hash, return the plaintext.
 * The plaintext is the only place the token exists in the clear — caller
 * is responsible for displaying/forwarding it once and then discarding.
 */
export async function generateToken(): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const salt = randomBytes(SALT_BYTES)
  const hash = deriveHash(token, salt)
  const now = new Date().toISOString()
  const existing = await readAuthFile()
  const file: AuthFileV2 = {
    version: 2,
    admin: {
      scheme: 'scrypt',
      salt: salt.toString('base64'),
      hash: hash.toString('base64'),
      params: { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, keyLen: KEY_LEN },
      createdAt: existing?.admin.createdAt ?? now,
      lastRotatedAt: now,
    },
    // Admin rotation deliberately does NOT revoke API tokens — they are
    // independent credentials with their own revocation path.
    apiTokens: existing?.apiTokens ?? [],
  }
  await writeAuthFile(file)
  return token
}

/**
 * Constant-time check of a candidate token against the stored hash.
 * Returns false if no auth file exists or the file is malformed.
 */
export async function verifyToken(candidate: string): Promise<boolean> {
  const file = await readAuthFile()
  if (!file) return false
  const admin = file.admin
  const salt = Buffer.from(admin.salt, 'base64')
  const stored = Buffer.from(admin.hash, 'base64')
  // Re-derive using the params actually recorded in the file (forward
  // compatibility — if we ever bump N/r/p, old records still verify).
  const computed = scryptSync(candidate, salt, admin.params.keyLen, {
    N: admin.params.N,
    r: admin.params.r,
    p: admin.params.p,
  })
  if (computed.length !== stored.length) return false
  return timingSafeEqual(computed, stored)
}

/** Returns metadata about the current token without exposing the secret. */
export async function getTokenInfo(): Promise<TokenInfo> {
  const file = await readAuthFile()
  if (!file) return { exists: false }
  return {
    exists: true,
    createdAt: file.admin.createdAt,
    lastRotatedAt: file.admin.lastRotatedAt,
  }
}

// ==================== Scoped API tokens (M2 / SE-2) ====================

const API_TOKEN_PREFIX = 'oat'

function sha256b64(secret: string): string {
  return createHash('sha256').update(secret).digest('base64')
}

/** Redacted listing for the Settings UI — never includes hashes. */
export async function listApiTokens(): Promise<Array<Omit<ApiTokenRecord, 'sha256'>>> {
  const file = await readAuthFile()
  if (!file) return []
  return file.apiTokens.map(({ sha256: _h, ...rest }) => rest)
}

/**
 * Mint a scoped API token. Returns the plaintext EXACTLY ONCE —
 * `oat_<id>_<secret>` — plus the redacted record. Requires the admin
 * record to exist (no tokens before first bootstrap).
 */
export async function mintApiToken(opts: {
  label: string
  scopes: TokenScope[]
}): Promise<{ token: string; record: Omit<ApiTokenRecord, 'sha256'> } | null> {
  const file = await readAuthFile()
  if (!file) return null
  const scopes = opts.scopes.filter(isTokenScope)
  if (scopes.length === 0) return null
  const id = randomUUID().slice(0, 8)
  const secret = randomBytes(TOKEN_BYTES).toString('base64url')
  const record: ApiTokenRecord = {
    id,
    label: opts.label.slice(0, 80),
    scopes,
    sha256: sha256b64(secret),
    createdAt: new Date().toISOString(),
  }
  file.apiTokens.push(record)
  await writeAuthFile(file)
  const { sha256: _h, ...redacted } = record
  return { token: `${API_TOKEN_PREFIX}_${id}_${secret}`, record: redacted }
}

/** Revoke by id (soft — record kept for the audit trail). Idempotent;
 *  returns false when the id is unknown. */
export async function revokeApiToken(id: string): Promise<boolean> {
  const file = await readAuthFile()
  if (!file) return false
  const rec = file.apiTokens.find((t) => t.id === id)
  if (!rec) return false
  if (!rec.revokedAt) {
    rec.revokedAt = new Date().toISOString()
    await writeAuthFile(file)
  }
  return true
}

/** Throttle lastUsedAt writes — bearer calls can be hot (metrics scrapes). */
const LAST_USED_THROTTLE_MS = 60_000

/**
 * Verify an `oat_…` bearer credential. Returns the token's identity and
 * scopes, or null (unknown id, bad secret, revoked, malformed).
 */
export async function verifyApiToken(
  candidate: string,
): Promise<{ id: string; label: string; scopes: TokenScope[] } | null> {
  // The SECRET is base64url and may itself contain underscores, so a naive
  // split('_') corrupts ~half of all tokens. Anchor on the fixed-shape id
  // (8 hex chars from randomUUID) instead.
  const m = /^oat_([0-9a-f]{8})_(.+)$/.exec(candidate)
  if (!m) return null
  const [, id, secret] = m
  const file = await readAuthFile()
  if (!file || !id || !secret) return null
  const rec = file.apiTokens.find((t) => t.id === id)
  if (!rec || rec.revokedAt) return null
  const stored = Buffer.from(rec.sha256, 'base64')
  const computed = createHash('sha256').update(secret).digest()
  if (stored.length !== computed.length || !timingSafeEqual(stored, computed)) return null
  const now = Date.now()
  if (!rec.lastUsedAt || now - new Date(rec.lastUsedAt).getTime() > LAST_USED_THROTTLE_MS) {
    rec.lastUsedAt = new Date(now).toISOString()
    await writeAuthFile(file)
  }
  return { id: rec.id, label: rec.label, scopes: rec.scopes }
}

/**
 * One-shot normalization used by migration 0014: rewrite a legacy v1 file
 * as v2 on disk. No-op when the file is absent or already v2 (readAuthFile
 * normalizes in memory, so this only changes the persisted shape).
 */
export async function normalizeAuthFileToV2(): Promise<boolean> {
  try {
    const raw = await readFile(AUTH_FILE(), 'utf-8')
    const parsed = JSON.parse(raw) as AuthFile
    if (parsed.version !== 1) return false
    const normalized = await readAuthFile()
    if (!normalized) return false
    await writeAuthFile(normalized)
    return true
  } catch {
    return false
  }
}

/**
 * Remove the auth file, forcing the next start to regenerate. Operator
 * recovery path: "I lost the token, give me a fresh one." All sessions
 * naturally invalidate (they get rejected on next request — see
 * `session-store.ts`).
 */
export async function clearToken(): Promise<void> {
  await unlink(AUTH_FILE()).catch(() => { /* already gone, fine */ })
}

/**
 * Idempotent bootstrap: if no auth file exists, generate one and surface
 * the plaintext token. Otherwise no-op (returns the existing metadata).
 *
 * `onFirstGeneration` is called exactly once with the plaintext — typical
 * caller writes to stdout. Plaintext is never persisted; once this callback
 * returns, the only proof of authority is the operator's clipboard.
 */
export async function bootstrapToken(opts: {
  onFirstGeneration?: (token: string) => void | Promise<void>
}): Promise<TokenInfo> {
  const existing = await readAuthFile()
  if (existing) {
    return {
      exists: true,
      createdAt: existing.admin.createdAt,
      lastRotatedAt: existing.admin.lastRotatedAt,
    }
  }
  const token = await generateToken()
  if (opts.onFirstGeneration) {
    await opts.onFirstGeneration(token)
  }
  return getTokenInfo()
}
