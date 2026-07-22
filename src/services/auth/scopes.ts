/**
 * Token scopes (M2 / SE-2).
 *
 * Four scopes, deliberately few:
 *   read          — GET-shaped observation: market data, inbox, issues,
 *                   metrics, board state. Nothing money-capable, nothing
 *                   secret-bearing.
 *   enqueue       — create/update work: issues, schedules, headless
 *                   dispatch. The scope the Bridge service (M8) will hold.
 *   gate:approve  — approve/reject/push staged trading operations (and,
 *                   later, Action Gate proposals — M9).
 *   admin         — everything, including config writes and token minting.
 *
 * Implication is a strict lattice, not a bitmask: admin ⊃ everything;
 * enqueue and gate:approve each imply read (you cannot meaningfully approve
 * or file work you cannot see). read implies only itself.
 */

export const TOKEN_SCOPES = ['read', 'enqueue', 'gate:approve', 'admin'] as const
export type TokenScope = (typeof TOKEN_SCOPES)[number]

const IMPLIES: Record<TokenScope, readonly TokenScope[]> = {
  read: ['read'],
  enqueue: ['enqueue', 'read'],
  'gate:approve': ['gate:approve', 'read'],
  admin: ['admin', 'gate:approve', 'enqueue', 'read'],
}

export function isTokenScope(value: unknown): value is TokenScope {
  return typeof value === 'string' && (TOKEN_SCOPES as readonly string[]).includes(value)
}

/** Does the held scope set satisfy the required scope (via implication)? */
export function scopesSatisfy(held: readonly TokenScope[], required: TokenScope): boolean {
  return held.some((h) => IMPLIES[h]?.includes(required))
}
