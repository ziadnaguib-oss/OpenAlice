/**
 * M2 scope-enforcement matrix + bearer auth + rate limiting, exercised
 * through the REAL middleware with the REAL token store (temp
 * OPENALICE_HOME). Also the route-coverage gate: every /api prefix mounted
 * in plugin.ts must have an explicit ROUTE_SCOPES classification.
 */

import { readFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { Hono } from 'hono'
import { describe, it, expect, beforeAll, vi } from 'vitest'

let home: string
let adminToken: string
let tokens: Record<'read' | 'enqueue' | 'gate' | 'admin2', string>

type AuthModule = typeof import('@/services/auth/index.js')
type MiddlewareModule = typeof import('./auth.js')
let auth: AuthModule
let mw: MiddlewareModule

function appWith(limiter?: import('@/services/auth/rate-limit.js').AuthRateLimiter): Hono {
  const app = new Hono()
  app.use('*', mw.createAuthMiddleware({ trustedProxies: [], csrfTrustedOrigins: [], limiter }))
  app.all('*', (c) => c.json({ ok: true }))
  return app
}

const REMOTE = { incoming: { socket: { remoteAddress: '203.0.113.9' } } }
const LOOPBACK = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }

function bearer(token: string): RequestInit {
  return { headers: { authorization: `Bearer ${token}` } }
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'scopes-'))
  vi.stubEnv('OPENALICE_HOME', home)
  vi.resetModules()
  auth = await import('@/services/auth/index.js')
  mw = await import('./auth.js')
  adminToken = await auth.generateToken()
  const mint = async (label: string, scopes: import('@/services/auth/scopes.js').TokenScope[]) =>
    (await auth.mintApiToken({ label, scopes }))!.token
  tokens = {
    read: await mint('reader', ['read']),
    enqueue: await mint('enqueuer', ['enqueue']),
    gate: await mint('approver', ['gate:approve']),
    admin2: await mint('admin-api', ['admin']),
  }
})

describe('scope enforcement matrix (SE-2)', () => {
  // [scopeToken, method, path, expectedStatus]
  const MATRIX: Array<[keyof typeof tokens, string, string, number]> = [
    // read: observation yes, mutation/no admin surfaces no
    ['read', 'GET', '/api/metrics', 200],
    ['read', 'GET', '/api/inbox', 200],
    ['read', 'GET', '/api/trading/status', 200],
    ['read', 'POST', '/api/issues', 403],
    ['read', 'GET', '/api/config', 403],
    ['read', 'GET', '/api/trading/config', 403],
    ['read', 'POST', '/api/trading/uta/x/wallet/commit', 403],
    // enqueue: work creation yes, approval/admin no
    ['enqueue', 'POST', '/api/issues', 200],
    ['enqueue', 'POST', '/api/headless', 200],
    ['enqueue', 'GET', '/api/news', 200],
    ['enqueue', 'POST', '/api/trading/uta/x/wallet/push', 403],
    ['enqueue', 'POST', '/api/tokens', 403],
    // gate:approve: trading decisions yes, work creation/admin no
    ['gate', 'POST', '/api/trading/uta/x/wallet/commit', 200],
    ['gate', 'POST', '/api/trading/uta/x/wallet/reject', 200],
    ['gate', 'GET', '/api/trading/positions', 200],
    ['gate', 'POST', '/api/issues', 403],
    ['gate', 'GET', '/api/workspaces', 403],
    // admin: everything
    ['admin2', 'POST', '/api/trading/uta/x/wallet/push', 200],
    ['admin2', 'GET', '/api/config', 200],
    ['admin2', 'POST', '/api/tokens', 200],
    // unmapped /api route → fail-closed to admin
    ['read', 'GET', '/api/definitely-not-mapped', 403],
    ['admin2', 'GET', '/api/definitely-not-mapped', 200],
  ]

  for (const [tok, method, path, expected] of MATRIX) {
    it(`${tok} token: ${method} ${path} → ${expected}`, async () => {
      const res = await appWith().request(path, { method, ...bearer(tokens[tok]) }, REMOTE)
      expect(res.status).toBe(expected)
    })
  }

  it('loopback keeps full (admin) trust — local UX unchanged', async () => {
    const res = await appWith().request('/api/config', { method: 'GET' }, LOOPBACK)
    expect(res.status).toBe(200)
  })

  it('the legacy admin token works as a bearer with admin scope', async () => {
    const res = await appWith().request('/api/tokens', { method: 'GET', ...bearer(adminToken) }, REMOTE)
    expect(res.status).toBe(200)
  })

  it('a revoked token stops working', async () => {
    const minted = (await auth.mintApiToken({ label: 'shortlived', scopes: ['read'] }))!
    const app = appWith()
    expect((await app.request('/api/metrics', { method: 'GET', ...bearer(minted.token) }, REMOTE)).status).toBe(200)
    await auth.revokeApiToken(minted.record.id)
    expect((await app.request('/api/metrics', { method: 'GET', ...bearer(minted.token) }, REMOTE)).status).toBe(401)
  })
})

describe('bearer rate limiting (SE-1)', () => {
  it('20 bad bearer attempts lock the source IP with 429', async () => {
    const limiter = auth.createAuthRateLimiter({ enabled: true, maxFailures: 20, windowMinutes: 15, lockoutMinutes: 15 })
    const app = appWith(limiter)
    const attacker = { incoming: { socket: { remoteAddress: '198.51.100.7' } } }
    for (let i = 0; i < 20; i++) {
      const res = await app.request('/api/metrics', { method: 'GET', ...bearer('oat_bad_credential') }, attacker)
      expect(res.status).toBe(401)
    }
    // Locked out now — even a VALID token gets 429 from this source.
    const locked = await app.request('/api/metrics', { method: 'GET', ...bearer(tokens.read) }, attacker)
    expect(locked.status).toBe(429)
    // Other sources are unaffected.
    const ok = await app.request('/api/metrics', { method: 'GET', ...bearer(tokens.read) }, REMOTE)
    expect(ok.status).toBe(200)
  })
})

describe('limiter keying behind a trusted proxy (M2 QA M-1)', () => {
  function appWithProxy(limiter: import('@/services/auth/rate-limit.js').AuthRateLimiter): Hono {
    const app = new Hono()
    app.use('*', mw.createAuthMiddleware({ trustedProxies: ['10.0.0.5'], csrfTrustedOrigins: [], limiter }))
    app.all('*', (c) => c.json({ ok: true }))
    return app
  }
  const viaProxy = { incoming: { socket: { remoteAddress: '10.0.0.5' } } }
  const xff = (ip: string) => ({ 'authorization': 'Bearer oat_bad_cred', 'x-forwarded-for': ip })

  it('keys on the X-Forwarded-For client, not the shared proxy socket', async () => {
    const limiter = auth.createAuthRateLimiter({ enabled: true, maxFailures: 20, windowMinutes: 15, lockoutMinutes: 15 })
    const app = appWithProxy(limiter)
    // Client A burns its whole budget through the proxy.
    for (let i = 0; i < 20; i++) {
      await app.request('/api/metrics', { method: 'GET', headers: xff('198.51.100.1') }, viaProxy)
    }
    // Client A is locked; client B (same proxy socket) is NOT — no global lockout.
    expect((await app.request('/api/metrics', { method: 'GET', headers: xff('198.51.100.1') }, viaProxy)).status).toBe(429)
    expect((await app.request('/api/metrics', { method: 'GET', headers: xff('198.51.100.2') }, viaProxy)).status).toBe(401)
  })
})

describe('route-scope coverage (fails when a new mount lacks classification)', () => {
  it('every /api prefix mounted in plugin.ts has a ROUTE_SCOPES entry', async () => {
    const source = await readFile(resolve(__dirname, '../plugin.ts'), 'utf-8')
    const mounted = new Set<string>()
    for (const m of source.matchAll(/app\.route\('(\/api\/[^']+)'/g)) mounted.add(m[1]!)
    for (const m of source.matchAll(/basePath:\s*'(\/api\/[^']+)'/g)) mounted.add(m[1]!)
    expect(mounted.size).toBeGreaterThan(10) // the regex actually found the mounts

    const publiclyHandled = new Set(['/api/auth', '/api/version'])
    const uncovered = [...mounted].filter((prefix) => {
      if (publiclyHandled.has(prefix)) return false
      return !mw.ROUTE_SCOPES.some(
        (e) => e.prefix === prefix || prefix.startsWith(`${e.prefix}/`) || e.prefix.startsWith(`${prefix}/`),
      )
    })
    expect(uncovered, `Unclassified /api mounts (add to ROUTE_SCOPES): ${uncovered.join(', ')}`).toEqual([])
  })
})
