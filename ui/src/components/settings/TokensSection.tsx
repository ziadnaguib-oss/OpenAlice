/**
 * Scoped API token management (M2 / SE-2) — list, mint (plaintext shown
 * exactly once), revoke. Strings are deliberately unlocalized v1; the
 * settings i18n pass will pick them up with the rest.
 */

import { useCallback, useEffect, useState } from 'react'

import { fetchJson } from '../../api/client'
import { ConfigSection, inputClass } from '../form'

type TokenScope = 'read' | 'enqueue' | 'gate:approve' | 'admin'

interface TokenRow {
  id: string
  label: string
  scopes: TokenScope[]
  createdAt: string
  lastUsedAt?: string
  revokedAt?: string
}

const SCOPE_HINTS: Record<TokenScope, string> = {
  read: 'observe: market data, inbox, issues, metrics',
  enqueue: 'create work: issues, schedules, headless runs',
  'gate:approve': 'approve/reject/push staged trading operations',
  admin: 'everything, including config and token management',
}

export function TokensSection() {
  const [rows, setRows] = useState<TokenRow[] | null>(null)
  const [label, setLabel] = useState('')
  const [scopes, setScopes] = useState<TokenScope[]>(['read'])
  const [minted, setMinted] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    fetchJson<{ tokens: TokenRow[] }>('/api/tokens')
      .then((r) => setRows(r.tokens))
      .catch(() => setRows([]))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const toggleScope = (s: TokenScope) => {
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))
  }

  const mint = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetchJson<{ token: string }>('/api/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label, scopes }),
      })
      setMinted(res.token)
      setLabel('')
      refresh()
    } catch {
      setError('Could not create the token — check the label and scopes.')
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: string) => {
    try {
      await fetchJson(`/api/tokens/${id}`, { method: 'DELETE' })
      refresh()
    } catch {
      setError('Could not revoke the token.')
    }
  }

  return (
    <ConfigSection
      title="API tokens"
      description="Scoped bearer tokens for remote and programmatic access (metrics scrapers, mobile read-only, automation). The full token is shown only once, at creation."
    >
      {minted && (
        <div className="mb-3 rounded-lg border border-border bg-bg-tertiary/40 p-3">
          <div className="text-[12px] text-text-muted mb-1">
            New token — copy it now, it will not be shown again:
          </div>
          <code className="block break-all text-[12px] select-all">{minted}</code>
          <button type="button" className="btn-secondary mt-2" onClick={() => setMinted(null)}>
            I saved it
          </button>
        </div>
      )}

      <div className="space-y-2">
        {rows === null && <div className="text-[12px] text-text-muted">Loading…</div>}
        {rows !== null && rows.length === 0 && (
          <div className="text-[12px] text-text-muted">No API tokens yet.</div>
        )}
        {rows?.map((row) => (
          <div
            key={row.id}
            className={`flex items-center gap-3 rounded-lg border border-border px-3 py-2 ${row.revokedAt ? 'opacity-50' : ''}`}
          >
            <div className="flex-1 min-w-0">
              <div className="text-[13px] truncate">
                {row.label} <span className="text-text-muted">· {row.id}</span>
              </div>
              <div className="text-[11px] text-text-muted">
                {row.scopes.join(', ')}
                {row.revokedAt ? ' · revoked' : row.lastUsedAt ? ` · last used ${new Date(row.lastUsedAt).toLocaleString()}` : ' · never used'}
              </div>
            </div>
            {!row.revokedAt && (
              <button type="button" className="btn-secondary shrink-0" onClick={() => revoke(row.id)}>
                Revoke
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="mt-4 space-y-2">
        <input
          className={inputClass}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Token label (e.g. prometheus-scraper)"
        />
        <div className="flex flex-wrap gap-3">
          {(Object.keys(SCOPE_HINTS) as TokenScope[]).map((s) => (
            <label key={s} className="flex items-center gap-1.5 text-[12px]" title={SCOPE_HINTS[s]}>
              <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggleScope(s)} />
              {s}
            </label>
          ))}
        </div>
        {error && <div className="text-[12px] text-red">{error}</div>}
        <button
          type="button"
          className="btn-primary"
          disabled={busy || label.trim().length === 0 || scopes.length === 0}
          onClick={mint}
        >
          Create token
        </button>
      </div>
    </ConfigSection>
  )
}
