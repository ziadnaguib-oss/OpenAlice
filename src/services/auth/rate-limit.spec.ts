import { describe, it, expect, vi, afterEach } from 'vitest'

import { createAuthRateLimiter } from './rate-limit.js'

const CFG = { enabled: true, maxFailures: 20, windowMinutes: 15, lockoutMinutes: 15 }

afterEach(() => vi.useRealTimers())

describe('auth rate limiter (SE-1)', () => {
  it('locks the IP at the failure threshold and reports the trip exactly once', () => {
    const rl = createAuthRateLimiter(CFG)
    let tripped = 0
    for (let i = 0; i < 20; i++) if (rl.recordFailure('203.0.113.9')) tripped++
    expect(tripped).toBe(1)
    expect(rl.isLocked('203.0.113.9')).toBe(true)
    // Other sources are unaffected.
    expect(rl.isLocked('203.0.113.10')).toBe(false)
  })

  it('below threshold stays unlocked; success resets the budget', () => {
    const rl = createAuthRateLimiter(CFG)
    for (let i = 0; i < 19; i++) rl.recordFailure('a')
    expect(rl.isLocked('a')).toBe(false)
    rl.recordSuccess('a')
    expect(rl._stateFor('a')).toBeUndefined()
  })

  it('lockout expires after lockoutMinutes', () => {
    vi.useFakeTimers()
    const rl = createAuthRateLimiter(CFG)
    for (let i = 0; i < 20; i++) rl.recordFailure('b')
    expect(rl.isLocked('b')).toBe(true)
    vi.advanceTimersByTime(15 * 60_000 + 1_000)
    expect(rl.isLocked('b')).toBe(false)
  })

  it('failure window slides: stale failures do not accumulate', () => {
    vi.useFakeTimers()
    const rl = createAuthRateLimiter(CFG)
    for (let i = 0; i < 19; i++) rl.recordFailure('c')
    vi.advanceTimersByTime(16 * 60_000)
    rl.recordFailure('c') // fresh window — failure #1, not #20
    expect(rl.isLocked('c')).toBe(false)
    expect(rl._stateFor('c')?.failures).toBe(1)
  })

  it('disabled config is a no-op', () => {
    const rl = createAuthRateLimiter({ ...CFG, enabled: false })
    for (let i = 0; i < 50; i++) rl.recordFailure('d')
    expect(rl.isLocked('d')).toBe(false)
  })
})
