import { http, HttpResponse } from 'msw'

// In-memory demo state — mirrors /api/tokens (M2 scoped API tokens).
const tokens: Array<{
  id: string
  label: string
  scopes: string[]
  createdAt: string
  lastUsedAt?: string
  revokedAt?: string
}> = [
  {
    id: 'demo1234',
    label: 'prometheus-scraper',
    scopes: ['read'],
    createdAt: '2026-07-01T09:00:00.000Z',
    lastUsedAt: '2026-07-17T08:55:00.000Z',
  },
]

export const tokensHandlers = [
  http.get('/api/tokens', () =>
    HttpResponse.json({ tokens, scopes: ['read', 'enqueue', 'gate:approve', 'admin'] }),
  ),

  http.post('/api/tokens', async ({ request }) => {
    const body = (await request.json()) as { label?: string; scopes?: string[] }
    if (!body.label || !body.scopes?.length) {
      return HttpResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    const id = Math.random().toString(16).slice(2, 10).padEnd(8, '0')
    const record = {
      id,
      label: body.label,
      scopes: body.scopes,
      createdAt: new Date().toISOString(),
    }
    tokens.push(record)
    return HttpResponse.json(
      { token: `oat_${id}_demo-secret-not-real`, record },
      { status: 201 },
    )
  }),

  http.delete('/api/tokens/:id', ({ params }) => {
    const row = tokens.find((t) => t.id === params['id'])
    if (!row) return HttpResponse.json({ error: 'Unknown token id' }, { status: 404 })
    row.revokedAt = new Date().toISOString()
    return HttpResponse.json({ ok: true })
  }),
]
