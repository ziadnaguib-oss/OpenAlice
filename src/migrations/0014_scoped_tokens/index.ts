/**
 * 0014_scoped_tokens — rewrite auth.json from the v1 single-admin-token
 * layout to the v2 layout that carries scoped API tokens (M2 / SE-2).
 *
 * v1: { version: 1, scheme, salt, hash, params, createdAt, lastRotatedAt }
 * v2: { version: 2, admin: { …same fields… }, apiTokens: [] }
 *
 * The token itself is untouched — only the envelope changes, so the
 * operator's existing admin token keeps working (the rollback guarantee).
 * The token store also reads v1 transparently; this migration exists so
 * the on-disk shape converges and future writers don't need dual-format
 * writes forever.
 *
 * Idempotent: a v2 (or absent, or malformed) file is left untouched.
 */

import type { Migration } from '../types.js'

interface AuthV1 {
  version?: unknown
  scheme?: unknown
  [key: string]: unknown
}

export const migration: Migration = {
  id: '0014_scoped_tokens',
  appVersion: '0.75.0-beta',
  introducedAt: '2026-07-17',
  affects: ['auth.json'],
  summary: 'Wrap the v1 single admin token as the admin record of the v2 scoped-token auth file.',
  up: async (ctx) => {
    const raw = await ctx.readJson<AuthV1>('auth.json')
    if (!raw || raw.version !== 1 || raw.scheme !== 'scrypt') return
    const { version: _v, ...admin } = raw
    await ctx.writeJson('auth.json', { version: 2, admin, apiTokens: [] })
  },
}
