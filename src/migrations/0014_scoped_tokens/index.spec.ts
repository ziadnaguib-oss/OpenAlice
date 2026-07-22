import { describe, it, expect } from 'vitest'

import type { MigrationContext } from '../types.js'
import { migration } from './index.js'

function fakeCtx(initial: Record<string, unknown>): {
  ctx: MigrationContext
  files: Map<string, unknown>
} {
  const files = new Map(Object.entries(initial))
  const ctx: MigrationContext = {
    readJson: async <T>(name: string) => files.get(name) as T | undefined,
    writeJson: async (name, data) => { files.set(name, data) },
    removeJson: async (name) => { files.delete(name) },
    configDir: () => '/fake',
  }
  return { ctx, files }
}

const V1 = {
  version: 1,
  scheme: 'scrypt',
  salt: 'c2FsdA==',
  hash: 'aGFzaA==',
  params: { N: 16384, r: 8, p: 1, keyLen: 64 },
  createdAt: '2026-01-01T00:00:00.000Z',
  lastRotatedAt: '2026-02-01T00:00:00.000Z',
}

describe('0014_scoped_tokens', () => {
  it('wraps a v1 file as the admin record of a v2 file (token material untouched)', async () => {
    const { ctx, files } = fakeCtx({ 'auth.json': V1 })
    await migration.up(ctx)
    const out = files.get('auth.json') as Record<string, unknown>
    expect(out.version).toBe(2)
    expect(out.apiTokens).toEqual([])
    const admin = out.admin as Record<string, unknown>
    expect(admin.salt).toBe(V1.salt)
    expect(admin.hash).toBe(V1.hash)
    expect(admin.createdAt).toBe(V1.createdAt)
    expect(admin).not.toHaveProperty('version')
  })

  it('is idempotent — a v2 file is left byte-identical', async () => {
    const { ctx, files } = fakeCtx({ 'auth.json': V1 })
    await migration.up(ctx)
    const first = JSON.stringify(files.get('auth.json'))
    await migration.up(ctx)
    expect(JSON.stringify(files.get('auth.json'))).toBe(first)
  })

  it('no-ops when auth.json is absent or malformed', async () => {
    const absent = fakeCtx({})
    await migration.up(absent.ctx)
    expect(absent.files.has('auth.json')).toBe(false)

    const malformed = fakeCtx({ 'auth.json': { version: 99 } })
    await migration.up(malformed.ctx)
    expect(malformed.files.get('auth.json')).toEqual({ version: 99 })
  })
})
