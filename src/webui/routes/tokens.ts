/**
 * /api/tokens — scoped API token management (M2 / SE-2). Admin-scope-only
 * (enforced by the middleware's ROUTE_SCOPES table). Every mint/revoke is
 * written to the audit chain.
 */

import { Hono } from 'hono'
import { z } from 'zod'

import { appendAudit } from '@/core/audit-chain.js'
import { listApiTokens, mintApiToken, revokeApiToken } from '@/services/auth/index.js'
import { TOKEN_SCOPES } from '@/services/auth/scopes.js'
import type { AuthContext } from '../middleware/auth.js'

const mintSchema = z.object({
  label: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(TOKEN_SCOPES)).min(1),
})

function actorOf(c: { get(key: 'auth'): AuthContext | undefined }): string {
  return c.get('auth')?.actor ?? 'loopback'
}

export function createTokenRoutes(): Hono {
  const app = new Hono()

  // List (redacted — no hash material ever leaves the store).
  app.get('/', async (c) => {
    return c.json({ tokens: await listApiTokens(), scopes: TOKEN_SCOPES })
  })

  // Mint. The response is the ONLY place the plaintext ever appears.
  app.post('/', async (c) => {
    const parsed = mintSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: 'Invalid request: label and at least one valid scope required' }, 400)
    }
    const minted = await mintApiToken(parsed.data)
    if (!minted) {
      return c.json({ error: 'Auth is not bootstrapped yet' }, 409)
    }
    await appendAudit({
      actor: actorOf(c),
      action: 'token.mint',
      details: { id: minted.record.id, label: minted.record.label, scopes: minted.record.scopes },
    })
    return c.json({ token: minted.token, record: minted.record }, 201)
  })

  // Revoke (soft — the record stays for the audit trail).
  app.delete('/:id', async (c) => {
    const id = c.req.param('id')
    const found = await revokeApiToken(id)
    if (!found) return c.json({ error: 'Unknown token id' }, 404)
    await appendAudit({ actor: actorOf(c), action: 'token.revoke', details: { id } })
    return c.json({ ok: true })
  })

  return app
}
