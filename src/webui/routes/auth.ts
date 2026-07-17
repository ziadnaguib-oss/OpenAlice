/**
 * Auth routes: /api/auth/login, /api/auth/logout, /api/auth/status.
 *
 * Mounted in `src/webui/plugin.ts` BEFORE the auth middleware applies,
 * since these are the entry points to acquire a session.
 *
 * Status check (`/api/auth/status`) is bypass-friendly so the UI can
 * decide whether to render the login screen without a real authed call
 * round-trip. It reveals nothing beyond `{ authed: boolean }`.
 */

import { Hono, type Context } from 'hono'
import { setCookie, deleteCookie } from 'hono/cookie'
import { z } from 'zod'
import {
  verifyToken,
  verifyApiToken,
  createSession,
  revokeSession,
  validateAndTouch,
  getTokenInfo,
  type AuthRateLimiter,
} from '@/services/auth/index.js'
import { appendAudit } from '@/core/audit-chain.js'
import {
  SESSION_COOKIE_NAME,
  isLoopbackIp,
  normalizeIp,
  getSocketRemoteAddress,
  limiterClientIp,
} from '../middleware/auth.js'

const loginSchema = z.object({
  token: z.string().min(1, 'token is required'),
})

export interface AuthRouteOptions {
  /** Should `Set-Cookie` mark the session cookie `Secure`? Set true in
   *  prod (HTTPS behind reverse proxy). Auto-detected from
   *  X-Forwarded-Proto when not provided — but only for requests
   *  arriving from a trusted proxy. */
  forceSecureCookie?: boolean
  /** Trusted reverse-proxy IPs. X-Forwarded-* headers are honored only
   *  when the request's socket peer is one of these — otherwise any
   *  client could send `X-Forwarded-Proto: https` over plain HTTP and
   *  coerce a `Secure` cookie the browser would then silently drop
   *  (login appears broken). Same list as the middleware's
   *  `trustedProxies`. */
  trustedProxies?: string[]
  /** Shared auth-failure limiter (SE-1) — same instance the middleware
   *  holds, so bearer failures and login failures share one budget. */
  limiter?: AuthRateLimiter
}

export function createAuthRoutes(opts: AuthRouteOptions = {}) {
  const app = new Hono()
  const trustedProxies = new Set((opts.trustedProxies ?? []).map(normalizeIp))

  /**
   * Returns whether the current request is authenticated, plus minimal
   * metadata. No-side-effect endpoint — does NOT extend session expiry.
   */
  app.get('/status', async (c) => {
    const tokenInfo = await getTokenInfo()

    // Mirror the middleware's localhost-trust passthrough: when no
    // trusted proxy is configured and the request came from a real
    // loopback socket, report authed:true even without a cookie. This
    // keeps `pnpm dev` zero-friction — the UI never bounces to the
    // login page in single-user local mode.
    if (trustedProxies.size === 0) {
      const remote = getSocketRemoteAddress(c) ?? ''
      if (isLoopbackIp(remote)) {
        return c.json({ authed: true, tokenConfigured: tokenInfo.exists, passthrough: 'localhost' })
      }
    }

    const sid = readSidFromCookie(c.req.header('cookie') ?? '')
    if (!sid) {
      return c.json({ authed: false, tokenConfigured: tokenInfo.exists })
    }
    const session = await validateAndTouch(sid)
    if (!session) {
      return c.json({ authed: false, tokenConfigured: true })
    }
    return c.json({
      authed: true,
      tokenConfigured: true,
      session: {
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
      },
    })
  })

  /**
   * Accept an admin token, verify, issue a session cookie.
   *
   * Failures all return 401 with the same body to avoid leaking
   * "token configured vs not" via timing or content.
   */
  app.post('/login', async (c) => {
    const fromTrustedProxy = isTrustedProxyPeer(c, trustedProxies)
    const limiterIp = limiterClientIp(c, trustedProxies)

    // Lockout gate (SE-1) BEFORE reading the body — a locked-out source
    // gets 429 without burning a scrypt verification.
    if (opts.limiter?.isLocked(limiterIp)) {
      return c.json({ error: 'Too many failed attempts', code: 'RATE_LIMITED' }, 429)
    }

    const body = await c.req.json().catch(() => null)
    const parsed = loginSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    // Admin token → admin session. Scoped API token (`oat_…`) → session
    // inheriting that token's scopes (the mobile read-only path).
    let scopes: import('@/services/auth/scopes.js').TokenScope[] | null = null
    if (parsed.data.token.startsWith('oat_')) {
      const tok = await verifyApiToken(parsed.data.token)
      if (tok) scopes = tok.scopes
    } else if (await verifyToken(parsed.data.token)) {
      scopes = ['admin']
    }
    if (!scopes) {
      // Don't reveal whether the token was malformed vs wrong vs no auth
      // configured. Constant-ish behavior.
      if (opts.limiter?.recordFailure(limiterIp)) {
        void appendAudit({ actor: 'system', action: 'auth.lockout', details: { ip: limiterIp, via: 'login' } })
      }
      return c.json({ error: 'Invalid token' }, 401)
    }
    opts.limiter?.recordSuccess(limiterIp)

    const userAgent = c.req.header('user-agent') ?? undefined
    const ip = readClientIp(c, fromTrustedProxy) ?? undefined
    const session = await createSession({ userAgent, ip, scopes })

    const secure = opts.forceSecureCookie ?? (fromTrustedProxy && isForwardedHttps(c))
    setCookie(c, SESSION_COOKIE_NAME, session.sid, {
      httpOnly: true,
      sameSite: 'Lax',
      secure,
      path: '/',
      maxAge: Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000),
    })

    return c.json({ ok: true })
  })

  /**
   * Invalidate the caller's session server-side and clear the cookie.
   * Idempotent — calling without a cookie returns 200.
   */
  app.post('/logout', async (c) => {
    const sid = readSidFromCookie(c.req.header('cookie') ?? '')
    if (sid) await revokeSession(sid)
    deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' })
    return c.json({ ok: true })
  })

  return app
}

function readSidFromCookie(cookieHeader: string): string | null {
  if (!cookieHeader) return null
  for (const raw of cookieHeader.split(';')) {
    const entry = raw.trim()
    const eq = entry.indexOf('=')
    if (eq < 0) continue
    if (entry.slice(0, eq) === SESSION_COOKIE_NAME) {
      const value = entry.slice(eq + 1).trim()
      return value.length > 0 ? decodeURIComponent(value) : null
    }
  }
  return null
}

/** True when the request's socket peer is one of the trusted proxy IPs. */
function isTrustedProxyPeer(c: Context, trustedProxies: ReadonlySet<string>): boolean {
  if (trustedProxies.size === 0) return false
  const remote = getSocketRemoteAddress(c)
  return remote ? trustedProxies.has(normalizeIp(remote)) : false
}

/**
 * Whether the trusted proxy says the original client request was HTTPS.
 * Only call after `isTrustedProxyPeer` — from any other peer the header
 * is attacker-controlled (see AuthRouteOptions.trustedProxies). Without
 * a proxy in front there is no TLS terminator, the connection is plain
 * HTTP, and `Secure` must not be set.
 */
function isForwardedHttps(c: Context): boolean {
  const proto = c.req.header('x-forwarded-proto')
  return proto?.split(',')[0]?.trim().toLowerCase() === 'https'
}

function readClientIp(c: Context, fromTrustedProxy: boolean): string | null {
  if (fromTrustedProxy) {
    const xff = c.req.header('x-forwarded-for')
    const first = xff?.split(',')[0]?.trim()
    if (first) return first
  }
  return getSocketRemoteAddress(c) ?? null
}
