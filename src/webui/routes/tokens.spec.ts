import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hono } from 'hono'
import { describe, it, expect, beforeAll, vi } from 'vitest'

let home: string
let app: Hono
let auditMod: typeof import('@/core/audit-chain.js')

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'tokroutes-'))
  vi.stubEnv('OPENALICE_HOME', home)
  vi.resetModules()
  const auth = await import('@/services/auth/index.js')
  auditMod = await import('@/core/audit-chain.js')
  auditMod._resetAuditCacheForTest()
  const { createTokenRoutes } = await import('./tokens.js')
  await auth.generateToken() // bootstrap admin record
  app = createTokenRoutes()
})

describe('/api/tokens', () => {
  it('mints, lists (redacted), revokes — and audits both actions', async () => {
    const mint = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'mobile reader', scopes: ['read'] }),
    })
    expect(mint.status).toBe(201)
    const minted = await mint.json()
    expect(minted.token).toMatch(/^oat_/)
    expect(minted.record.scopes).toEqual(['read'])

    const list = await (await app.request('/')).json()
    expect(list.tokens).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain(minted.token)
    expect(list.tokens[0]).not.toHaveProperty('sha256')

    const del = await app.request(`/${minted.record.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)

    const audit = await auditMod.readAuditTail()
    expect(audit.map((r) => r.action)).toEqual(['token.mint', 'token.revoke'])
    expect((await auditMod.verifyAuditChain()).ok).toBe(true)
  })

  it('rejects bad mint payloads and unknown revoke ids', async () => {
    const bad = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: '', scopes: ['bogus'] }),
    })
    expect(bad.status).toBe(400)
    expect((await app.request('/nope', { method: 'DELETE' })).status).toBe(404)
  })
})
