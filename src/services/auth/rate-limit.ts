/**
 * Auth failure rate limiter (M2 / SE-1).
 *
 * In-memory, per-source-IP. Counts FAILED auth attempts (bad login token,
 * bad bearer credential) within a sliding window; at the threshold the IP
 * is locked out and every auth attempt answers 429 until the lockout
 * expires. Successful auth resets the counter for that IP.
 *
 * In-memory is deliberate: a restart clearing the limiter is acceptable
 * (the lockout exists to blunt online brute force, and 20 tries per
 * process-lifetime per IP against a 256-bit credential is nothing), and it
 * keeps the hot path allocation-free. Config lives in security.json;
 * `enabled: false` is the one-line rollback.
 */

import { logger } from '@/core/logger.js'

const log = logger.child({ scope: 'auth-rate-limit' })

export interface RateLimitConfig {
  enabled: boolean
  maxFailures: number
  windowMinutes: number
  lockoutMinutes: number
}

interface IpState {
  failures: number
  windowStart: number
  lockedUntil: number | null
}

export interface AuthRateLimiter {
  /** True when this IP is currently locked out (429 the request). */
  isLocked(ip: string): boolean
  /** Record a failed auth attempt. Returns true when this failure tripped
   *  the lockout (caller should audit-log it). */
  recordFailure(ip: string): boolean
  /** Successful auth clears the IP's failure state. */
  recordSuccess(ip: string): void
  /** Test/introspection helper. */
  _stateFor(ip: string): IpState | undefined
}

export function createAuthRateLimiter(cfg: RateLimitConfig): AuthRateLimiter {
  const byIp = new Map<string, IpState>()

  function prune(now: number): void {
    // Opportunistic cleanup so the map cannot grow unbounded under a
    // spray of spoofed source addresses.
    if (byIp.size < 10_000) return
    for (const [ip, st] of byIp) {
      const windowExpired = now - st.windowStart > cfg.windowMinutes * 60_000
      const lockExpired = st.lockedUntil !== null && st.lockedUntil < now
      if ((st.lockedUntil === null && windowExpired) || lockExpired) byIp.delete(ip)
    }
  }

  return {
    isLocked(ip: string): boolean {
      if (!cfg.enabled) return false
      const st = byIp.get(ip)
      if (!st?.lockedUntil) return false
      if (st.lockedUntil < Date.now()) {
        byIp.delete(ip)
        return false
      }
      return true
    },

    recordFailure(ip: string): boolean {
      if (!cfg.enabled) return false
      const now = Date.now()
      prune(now)
      let st = byIp.get(ip)
      if (!st || now - st.windowStart > cfg.windowMinutes * 60_000) {
        st = { failures: 0, windowStart: now, lockedUntil: null }
        byIp.set(ip, st)
      }
      st.failures += 1
      if (st.failures >= cfg.maxFailures && st.lockedUntil === null) {
        st.lockedUntil = now + cfg.lockoutMinutes * 60_000
        log.warn('auth lockout tripped', {
          ip,
          failures: st.failures,
          lockoutMinutes: cfg.lockoutMinutes,
        })
        return true
      }
      return false
    },

    recordSuccess(ip: string): void {
      byIp.delete(ip)
    },

    _stateFor(ip: string): IpState | undefined {
      return byIp.get(ip)
    },
  }
}
