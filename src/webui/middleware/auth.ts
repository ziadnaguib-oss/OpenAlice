/**
 * Auth middleware — the single gate between the public internet and the
 * rest of Alice's HTTP surface.
 *
 * Order of operations on every request:
 *   1. Public allowlist  — `/api/auth/*`, `/api/version`, static assets,
 *                          MCP routes (own protection).
 *   2. Localhost trust   — true-loopback bypass when no trusted proxy is
 *                          configured. Carefully NOT spoofable through
 *                          X-Forwarded-For unless an explicit trusted
 *                          proxy IP is in `OPENALICE_TRUSTED_PROXIES`.
 *   3. Session cookie    — looked up in sessions.json, expiry checked,
 *                          window slid forward on use.
 *   4. CSRF Origin check — mutating methods (POST/PUT/DELETE/PATCH) must
 *                          carry an Origin header that matches the
 *                          configured allowlist.
 *
 * Reference: `safe/playbooks/01-auth-bypass.md`, `safe/playbooks/02-csrf-cross-origin.md`,
 * `safe/playbooks/03-localhost-spoofing.md`.
 */

import type { Context, MiddlewareHandler } from 'hono'
import { validateAndTouch, verifyApiToken, verifyToken } from '@/services/auth/index.js'
import { scopesSatisfy, type TokenScope } from '@/services/auth/scopes.js'
import type { AuthRateLimiter } from '@/services/auth/rate-limit.js'
import { appendAudit } from '@/core/audit-chain.js'
import { logger } from '@/core/logger.js'

const log = logger.child({ scope: 'auth' })

export const SESSION_COOKIE_NAME = 'alice_session'

/** Auth identity attached to the request context (`c.get('auth')`). */
export interface AuthContext {
  /** 'loopback' | 'session:<sid8>' | 'token:<id>' */
  actor: string
  scopes: readonly TokenScope[]
}

/**
 * Scope requirements per /api route group (M2 / SE-2). `read` guards
 * GET/HEAD, `write` guards mutating methods. Longest prefix wins. Any
 * /api path NOT matched here falls back to admin/admin — new routes are
 * locked down until someone consciously classifies them, and the
 * route-coverage spec fails when a mounted prefix is missing from this
 * table.
 */
export const ROUTE_SCOPES: ReadonlyArray<{
  prefix: string
  read: TokenScope
  write: TokenScope
}> = [
  // Observation surfaces — safe for read-only tokens.
  { prefix: '/api/metrics', read: 'read', write: 'admin' },
  { prefix: '/api/inbox', read: 'read', write: 'admin' },
  { prefix: '/api/entities', read: 'read', write: 'admin' },
  { prefix: '/api/wikilink', read: 'read', write: 'admin' },
  { prefix: '/api/market-data-v1', read: 'read', write: 'admin' },
  { prefix: '/api/market-data', read: 'read', write: 'admin' },
  { prefix: '/api/market', read: 'read', write: 'admin' },
  { prefix: '/api/bars', read: 'read', write: 'admin' },
  { prefix: '/api/reference', read: 'read', write: 'admin' },
  { prefix: '/api/news', read: 'read', write: 'admin' },
  { prefix: '/api/media', read: 'read', write: 'admin' },
  { prefix: '/api/agent-status', read: 'read', write: 'admin' },
  { prefix: '/api/tools', read: 'read', write: 'admin' }, // POST = tool EXECUTION
  // Work creation — the Bridge (M8) holds 'enqueue'.
  { prefix: '/api/issues', read: 'read', write: 'enqueue' },
  { prefix: '/api/schedule', read: 'read', write: 'enqueue' },
  { prefix: '/api/headless', read: 'read', write: 'enqueue' },
  // Trading: config carries broker credentials → admin both ways; the
  // trading plane itself is observable with 'read', mutable only with the
  // approval scope (stage/commit/reject/push all ride POST).
  { prefix: '/api/trading/config', read: 'admin', write: 'admin' },
  { prefix: '/api/trading', read: 'read', write: 'gate:approve' },
  { prefix: '/api/simulator', read: 'admin', write: 'admin' },
  // Full-control surfaces.
  { prefix: '/api/workspaces', read: 'admin', write: 'admin' },
  { prefix: '/api/config', read: 'admin', write: 'admin' },
  { prefix: '/api/preferences', read: 'admin', write: 'admin' },
  { prefix: '/api/persona', read: 'admin', write: 'admin' },
  { prefix: '/api/channels', read: 'admin', write: 'admin' },
  { prefix: '/api/agent-runtimes', read: 'admin', write: 'admin' },
  { prefix: '/api/tokens', read: 'admin', write: 'admin' },
  { prefix: '/api/debug', read: 'admin', write: 'admin' },
]

const SCOPES_BY_LENGTH = [...ROUTE_SCOPES].sort((a, b) => b.prefix.length - a.prefix.length)

/** Resolve the scope a request needs. Fail-closed for unmapped /api paths. */
export function requiredScopeFor(path: string, method: string): TokenScope {
  const mutating = MUTATING_METHODS.has(method)
  const entry = SCOPES_BY_LENGTH.find((e) => path === e.prefix || path.startsWith(`${e.prefix}/`))
  if (entry) return mutating ? entry.write : entry.read
  return 'admin'
}

/** Routes that NEVER require auth (the public surface). */
const PUBLIC_PATH_EXACT = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/status',
  '/api/version',
])

/** Path prefixes that NEVER require auth. */
const PUBLIC_PATH_PREFIX = [
  '/login',           // UI login page (served by Vite or static)
  '/favicon',         // favicon.ico, favicon-*.png, etc.
  '/assets/',         // bundled UI static assets
  '/mcp',             // MCP transport — has its own protection model
] as const

const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH'])

export interface AuthMiddlewareOptions {
  /** Trusted proxy IPs (e.g., ["10.0.0.5"]). Empty = no trusted proxy. */
  trustedProxies: string[]
  /** Additional allowed Origins for cross-origin mutating requests. */
  csrfTrustedOrigins: string[]
  /** Set true to disable auth (dev / test). Default false. */
  disabled?: boolean
  /** Shared failure rate limiter (SE-1). Absent in legacy callers/tests →
   *  no limiting, behavior identical to pre-M2. */
  limiter?: AuthRateLimiter
}

export function createAuthMiddleware(opts: AuthMiddlewareOptions): MiddlewareHandler {
  const trustedProxies = new Set(opts.trustedProxies)
  const csrfTrustedOrigins = new Set(opts.csrfTrustedOrigins)
  const warnedUnmapped = new Set<string>()

  /** Scope gate shared by every authenticated path below. */
  const enforceScope = (c: Context, auth: AuthContext): Response | null => {
    const path = c.req.path
    if (!path.startsWith('/api/')) return null
    const required = requiredScopeFor(path, c.req.method)
    if (required === 'admin' && !SCOPES_BY_LENGTH.some((e) => path === e.prefix || path.startsWith(`${e.prefix}/`))) {
      const group = path.split('/').slice(0, 3).join('/')
      if (!warnedUnmapped.has(group)) {
        warnedUnmapped.add(group)
        log.warn('unmapped /api route group — locked to admin scope', { group })
      }
    }
    if (scopesSatisfy(auth.scopes, required)) {
      c.set('auth', auth)
      return null
    }
    return c.json(
      { error: 'Forbidden: insufficient scope', code: 'INSUFFICIENT_SCOPE', required },
      403,
    )
  }

  return async (c: Context, next) => {
    if (opts.disabled) return next()

    const path = c.req.path

    if (PUBLIC_PATH_EXACT.has(path)) return next()
    if (PUBLIC_PATH_PREFIX.some((p) => path.startsWith(p))) return next()

    // SPA shell — any GET to a non-API path is public. The React bundle
    // is the entity that decides "render the login page vs the app" by
    // polling /api/auth/status; if we 401 the HTML itself, the user
    // can't even reach the login UI. Mutations and any /api/* still
    // require a session.
    if (c.req.method === 'GET' && !path.startsWith('/api/')) {
      return next()
    }

    // Localhost passthrough — only honored when no trusted proxy is
    // configured. With a trusted proxy in front, the proxy IS at 127.0.0.1
    // from Alice's view, so trusting "localhost requests" would let every
    // public request through. See safe/playbooks/03-localhost-spoofing.md.
    // Loopback keeps FULL trust (admin) — the local single-user workflow
    // is the product's default and must stay zero-friction.
    if (trustedProxies.size === 0) {
      const clientIp = getSocketRemoteAddress(c)
      if (clientIp && isLoopbackIp(clientIp)) {
        const denied = enforceScope(c, { actor: 'loopback', scopes: ['admin'] })
        return denied ?? next()
      }
    }

    const ip = normalizeIp(getSocketRemoteAddress(c) ?? 'unknown')

    // Lockout gate (SE-1) — checked before any credential is examined so a
    // locked-out source cannot keep burning scrypt cycles either.
    if (opts.limiter?.isLocked(ip)) {
      return c.json({ error: 'Too many failed attempts', code: 'RATE_LIMITED' }, 429)
    }

    // Bearer token (SE-2) — scoped API tokens (`oat_…`) or the admin token.
    const authz = c.req.header('authorization')
    if (authz?.toLowerCase().startsWith('bearer ')) {
      const candidate = authz.slice(7).trim()
      if (candidate.startsWith('oat_')) {
        const tok = await verifyApiToken(candidate)
        if (tok) {
          opts.limiter?.recordSuccess(ip)
          const denied = enforceScope(c, { actor: `token:${tok.id}`, scopes: tok.scopes })
          return denied ?? next()
        }
      } else if (await verifyToken(candidate)) {
        opts.limiter?.recordSuccess(ip)
        const denied = enforceScope(c, { actor: 'admin-token', scopes: ['admin'] })
        return denied ?? next()
      }
      if (opts.limiter?.recordFailure(ip)) {
        void appendAudit({ actor: 'system', action: 'auth.lockout', details: { ip, via: 'bearer' } })
      }
      return c.json({ error: 'Unauthorized', code: 'INVALID_TOKEN' }, 401)
    }

    // Session cookie check
    const sid = readSessionCookie(c.req.header('cookie') ?? '')
    if (!sid) {
      return c.json({ error: 'Unauthorized', code: 'NO_SESSION' }, 401)
    }
    const session = await validateAndTouch(sid)
    if (!session) {
      return c.json({ error: 'Unauthorized', code: 'INVALID_SESSION' }, 401)
    }

    // CSRF — Origin check on state-changing methods. SameSite=Lax cookie
    // catches most of these already, but a malicious page hosted same-site
    // (e.g., XSS on a sibling subdomain) could still issue authenticated
    // mutations. Explicit Origin enforcement is the second layer.
    if (MUTATING_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin')
      if (origin) {
        if (!isAllowedOrigin(origin, c, csrfTrustedOrigins)) {
          return c.json({ error: 'Forbidden: origin not allowed', code: 'CSRF_ORIGIN' }, 403)
        }
      }
      // Origin header absent on POST is common from non-browser callers
      // (curl, Telegram bot, server-to-server). We allow it — only reject
      // when an Origin IS provided and is wrong. A future tightening could
      // require Origin for browser-typical mutating requests, but it would
      // break legitimate CLI use.
    }

    // Attach session to context for downstream handlers. Sessions minted
    // before M2 carry no scopes field → legacy admin.
    c.set('session', session)
    const denied = enforceScope(c, {
      actor: `session:${session.sid.slice(0, 8)}`,
      scopes: session.scopes ?? ['admin'],
    })
    return denied ?? next()
  }
}

/** Extracts the Node socket-level remote address from the Hono context. */
export function getSocketRemoteAddress(c: Context): string | undefined {
  // @hono/node-server exposes the raw Node IncomingMessage as c.env.incoming
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  return env?.incoming?.socket?.remoteAddress
}

/**
 * Normalize an IP literal for comparison: strip the IPv6 zone suffix
 * (fe80::1%eth0 → fe80::1) and unwrap IPv4-mapped IPv6
 * (::ffff:10.0.0.5 → 10.0.0.5).
 */
export function normalizeIp(ip: string): string {
  const cleaned = ip.split('%')[0]
  return cleaned.startsWith('::ffff:') ? cleaned.slice(7) : cleaned
}

/**
 * Returns true if the given IP literal is a loopback address. Handles
 * IPv4 (127.0.0.0/8), IPv6 (::1), and IPv4-mapped IPv6 (::ffff:127.x.x.x).
 */
export function isLoopbackIp(ip: string): boolean {
  if (!ip) return false
  const norm = normalizeIp(ip)
  if (norm === '::1') return true
  // IPv4 — accept the entire 127.0.0.0/8 range, not just 127.0.0.1
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(norm)) return true
  return false
}

function readSessionCookie(cookieHeader: string): string | null {
  if (!cookieHeader) return null
  const pairs = cookieHeader.split(';')
  for (const raw of pairs) {
    const entry = raw.trim()
    const eq = entry.indexOf('=')
    if (eq < 0) continue
    const name = entry.slice(0, eq)
    if (name === SESSION_COOKIE_NAME) {
      const value = entry.slice(eq + 1).trim()
      // Empty value is "no session" — explicitly do NOT treat empty
      // string as a valid SID. See safe/playbooks/01-auth-bypass.md.
      return value.length > 0 ? decodeURIComponent(value) : null
    }
  }
  return null
}

function isAllowedOrigin(origin: string, c: Context, trustedOrigins: Set<string>): boolean {
  // Same-origin: Origin's host matches our Host header.
  const host = c.req.header('host')
  if (host) {
    try {
      const o = new URL(origin)
      if (o.host === host) return true
    } catch {
      return false
    }
  }
  // Explicitly trusted via env (cloud-demo cross-origin scenarios).
  return trustedOrigins.has(origin)
}
