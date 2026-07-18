/**
 * Calendar gating for scheduled fires (AU-4).
 *
 * A scheduled issue may declare `calendar`:
 *   always    — fire whenever due (default; unchanged behavior)
 *   weekdays  — skip Saturday/Sunday
 *   us-market — skip weekends AND US equity-market holidays
 *
 * All evaluation is in America/New_York (the market's clock), derived via
 * `Intl` so there is no timezone dependency. This is DATE-level gating (is the
 * market open *today*), not intraday session hours — a run that fires on an
 * open day is fine; intraday-hours gating is a deferred refinement. Holidays
 * are computed algorithmically (fixed dates with the NYSE observed-shift rule,
 * nth-weekday rules, and Good Friday via the Computus Easter algorithm), so no
 * per-year table needs maintaining.
 */

export type ScheduleCalendar = 'always' | 'weekdays' | 'us-market'

interface EtDate {
  year: number
  month: number // 1-12
  day: number // 1-31
  /** 0=Sun … 6=Sat */
  weekday: number
}

const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  weekday: 'short',
})

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}

/** Project an instant onto the New York calendar date. */
export function etDateOf(atMs: number): EtDate {
  const parts = ET_PARTS.formatToParts(new Date(atMs))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  }
}

function isWeekend(d: EtDate): boolean {
  return d.weekday === 0 || d.weekday === 6
}

/** Day-of-week (0=Sun) for a Y-M-D using Sakamoto's algorithm (Gregorian). */
function dowOf(y: number, m: number, day: number): number {
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]
  const yy = m < 3 ? y - 1 : y
  return (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + t[m - 1]! + day) % 7
}

/** Date of the nth given weekday in a month (n=1..4), as day-of-month. */
function nthWeekday(y: number, m: number, weekday: number, n: number): number {
  const firstDow = dowOf(y, m, 1)
  const offset = (weekday - firstDow + 7) % 7
  return 1 + offset + (n - 1) * 7
}

/** Date of the LAST given weekday in a month, as day-of-month. */
function lastWeekday(y: number, m: number, weekday: number): number {
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const lastDow = dowOf(y, m, daysInMonth)
  const offset = (lastDow - weekday + 7) % 7
  return daysInMonth - offset
}

/** Easter Sunday (Gregorian, Anonymous/Meeus Computus) → {month, day}. */
function easter(y: number): { month: number; day: number } {
  const a = y % 19
  const b = Math.floor(y / 100)
  const c = y % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const mm = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * mm + 114) / 31)
  const day = ((h + l - 7 * mm + 114) % 31) + 1
  return { month, day }
}

/** NYSE observed-shift for a fixed-date holiday: Sat→Fri, Sun→Mon. Returns the
 *  {month, day} the market actually closes (may cross a month boundary only for
 *  Jan 1 on a Sunday, handled by the caller comparing the observed date). */
function observed(y: number, m: number, day: number): { month: number; day: number } {
  const dow = dowOf(y, m, day)
  if (dow === 6) return shiftDay(y, m, day, -1) // Saturday → Friday
  if (dow === 0) return shiftDay(y, m, day, +1) // Sunday → Monday
  return { month: m, day }
}

function shiftDay(y: number, m: number, day: number, delta: number): { month: number; day: number } {
  const dt = new Date(Date.UTC(y, m - 1, day + delta))
  return { month: dt.getUTCMonth() + 1, day: dt.getUTCDate() }
}

/** Is `d` a US equity-market holiday (date-level)? */
export function isUsMarketHoliday(d: EtDate): boolean {
  const { year: y, month: m, day } = d
  const fixed: Array<{ month: number; day: number }> = [
    observed(y, 1, 1), // New Year's Day
    observed(y, 6, 19), // Juneteenth
    observed(y, 7, 4), // Independence Day
    observed(y, 12, 25), // Christmas
  ]
  const nthOrLast: Array<{ month: number; day: number }> = [
    { month: 1, day: nthWeekday(y, 1, 1, 3) }, // MLK — 3rd Mon Jan
    { month: 2, day: nthWeekday(y, 2, 1, 3) }, // Presidents — 3rd Mon Feb
    { month: 5, day: lastWeekday(y, 5, 1) }, // Memorial — last Mon May
    { month: 9, day: nthWeekday(y, 9, 1, 1) }, // Labor — 1st Mon Sep
    { month: 11, day: nthWeekday(y, 11, 4, 4) }, // Thanksgiving — 4th Thu Nov
  ]
  const eas = easter(y)
  const goodFriday = shiftDay(y, eas.month, eas.day, -2) // Fri before Easter
  const all = [...fixed, ...nthOrLast, goodFriday]
  return all.some((h) => h.month === m && h.day === day)
}

/**
 * Should a scheduled fire proceed at `atMs` under `calendar`? Returns a skip
 * reason string when it must NOT fire, or null when it may.
 */
export function calendarSkipReason(calendar: ScheduleCalendar, atMs: number): string | null {
  if (calendar === 'always') return null
  const d = etDateOf(atMs)
  if (isWeekend(d)) return 'weekend'
  if (calendar === 'us-market' && isUsMarketHoliday(d)) return 'us-market-holiday'
  return null
}
