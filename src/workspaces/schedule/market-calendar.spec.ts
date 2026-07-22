import { describe, it, expect } from 'vitest'

import { calendarSkipReason, isUsMarketHoliday, etDateOf } from './market-calendar.js'

// Noon ET on a given Y-M-D, expressed as a UTC instant (ET is UTC-4/-5, so
// noon ET is safely mid-day regardless of DST — same calendar date either way).
function noonEt(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d, 16, 0, 0) // 16:00 UTC ≈ 11:00-12:00 ET
}

describe('market calendar (AU-4)', () => {
  it('always → never skips', () => {
    expect(calendarSkipReason('always', noonEt(2026, 7, 4))).toBeNull() // a Saturday
  })

  it('weekdays → skips Saturday and Sunday only', () => {
    expect(calendarSkipReason('weekdays', noonEt(2026, 7, 4))).toBe('weekend') // Sat
    expect(calendarSkipReason('weekdays', noonEt(2026, 7, 5))).toBe('weekend') // Sun
    expect(calendarSkipReason('weekdays', noonEt(2026, 7, 6))).toBeNull() // Mon
    // A market holiday on a weekday is NOT skipped under 'weekdays'.
    expect(calendarSkipReason('weekdays', noonEt(2026, 12, 25))).toBeNull() // Christmas Fri
  })

  it('us-market → skips weekends AND holidays', () => {
    expect(calendarSkipReason('us-market', noonEt(2026, 12, 25))).toBe('us-market-holiday') // Christmas (Fri)
    expect(calendarSkipReason('us-market', noonEt(2026, 7, 6))).toBeNull() // ordinary Mon
  })

  it('computes fixed, nth-weekday, and Good Friday holidays algorithmically', () => {
    const holiday = (y: number, m: number, d: number) => isUsMarketHoliday(etDateOf(noonEt(y, m, d)))
    expect(holiday(2026, 1, 1)).toBe(true)   // New Year's Day
    expect(holiday(2026, 1, 19)).toBe(true)  // MLK — 3rd Mon Jan
    expect(holiday(2026, 2, 16)).toBe(true)  // Presidents — 3rd Mon Feb
    expect(holiday(2026, 4, 3)).toBe(true)   // Good Friday 2026 (Easter Apr 5)
    expect(holiday(2026, 5, 25)).toBe(true)  // Memorial — last Mon May
    expect(holiday(2026, 6, 19)).toBe(true)  // Juneteenth
    expect(holiday(2026, 9, 7)).toBe(true)   // Labor — 1st Mon Sep
    expect(holiday(2026, 11, 26)).toBe(true) // Thanksgiving — 4th Thu Nov
    expect(holiday(2026, 12, 25)).toBe(true) // Christmas
    // A plain trading day is not a holiday.
    expect(holiday(2026, 7, 6)).toBe(false)
  })

  it('applies the observed-shift for a fixed holiday landing on a weekend', () => {
    // Jul 4 2026 is a Saturday → market observes Friday Jul 3.
    expect(isUsMarketHoliday(etDateOf(noonEt(2026, 7, 3)))).toBe(true)
  })
})
