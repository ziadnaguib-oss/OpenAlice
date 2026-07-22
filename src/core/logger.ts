/**
 * Structured logging spine for the Alice process (M1 / DX-3).
 *
 * pino-backed, but deliberately emitting the SAME wire shape as the
 * launcher's zero-dep logger (src/workspaces/logger.ts):
 *
 *   {"ts":"<ISO>","level":"info","msg":"…", ...fields}
 *
 * so `pnpm dev` output stays uniform and existing greps keep working. The
 * exposed interface also matches the launcher logger — `(msg, fields?)` plus
 * `child(bindings)` — so call sites look identical across the codebase.
 *
 * Knobs:
 *   OPENALICE_LOG_LEVEL   debug | info | warn | error   (default: info)
 *   OPENALICE_LOG_PRETTY  1 → human-oriented "LEVEL scope msg {fields}" lines
 *
 * Every emitted line is also kept in an in-memory ring buffer (last
 * {@link RING_CAPACITY} lines) that the crash-bundle endpoint exports —
 * see src/webui/routes/metrics.ts.
 */

import { pino, type Logger as PinoLogger } from 'pino'

const RING_CAPACITY = 500

/** Key substrings whose values are redacted in logs and crash bundles. */
const SECRET_KEY_RE = /key|token|secret|password|credential|authorization/i

const ring: string[] = []

function pushRing(line: string): void {
  ring.push(line)
  if (ring.length > RING_CAPACITY) ring.shift()
}

/** Last-N log lines (oldest first) for the crash bundle. */
export function getRecentLogs(): readonly string[] {
  return [...ring]
}

/**
 * Deep-copy `value` with every property whose key matches
 * {@link SECRET_KEY_RE} replaced by '[redacted]'. Used by the crash bundle to
 * export the config *shape* without credential material.
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) && typeof v === 'string' ? '[redacted]' : redactSecrets(v)
    }
    return out
  }
  return value
}

function prettify(line: string): string {
  try {
    const rec = JSON.parse(line) as Record<string, unknown>
    const { ts, level, msg, scope, ...rest } = rec
    const fields = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : ''
    const time = typeof ts === 'string' ? ts.slice(11, 19) : ''
    return `${time} ${String(level).toUpperCase().padEnd(5)} ${scope ? `[${String(scope)}] ` : ''}${String(msg)}${fields}\n`
  } catch {
    return line
  }
}

const pretty = process.env['OPENALICE_LOG_PRETTY'] === '1'

/** stdout for debug/info, stderr for warn/error — same routing as the
 *  launcher logger, so Guardian's per-child prefixing stays consistent. */
const destination = {
  write(line: string): void {
    pushRing(line)
    const rendered = pretty ? prettify(line) : line
    if (line.includes('"level":"warn"') || line.includes('"level":"error"')) {
      process.stderr.write(rendered)
    } else {
      process.stdout.write(rendered)
    }
  },
}

const VALID_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])

/** An invalid level env must degrade to 'info', never brick boot — pino
 *  throws at construction on unknown levels, and this module is imported by
 *  config.ts, so a typo would take down BOTH Alice and UTA. */
function resolveLevel(): string {
  const raw = (process.env['OPENALICE_LOG_LEVEL'] ?? 'info').toLowerCase()
  if (VALID_LEVELS.has(raw)) return raw
  process.stderr.write(
    `{"level":"warn","ts":"${new Date().toISOString()}","scope":"logger","msg":"invalid OPENALICE_LOG_LEVEL '${raw}' — falling back to 'info'"}\n`,
  )
  return 'info'
}

const root = pino(
  {
    level: resolveLevel(),
    base: undefined,
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    formatters: { level: (label) => ({ level: label }) },
  },
  destination,
)

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  child(bindings: Record<string, unknown>): Logger
}

/**
 * One deep walk over the fields: serialize Errors (their message/stack are
 * non-enumerable and would otherwise vanish), redact secret-shaped string
 * values at ANY depth (pino's `redact` paths only reach declared depths —
 * see the M1 QA review), and guard against cycles. Runs before pino so the
 * ring buffer (exported by the crash bundle) only ever holds clean lines.
 */
function prepareValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    return value.map((v) => prepareValue(v, seen))
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) && typeof v === 'string' ? '[redacted]' : prepareValue(v, seen)
    }
    return out
  }
  return value
}

function serializeFields(fields?: Record<string, unknown>): Record<string, unknown> {
  if (!fields) return {}
  // `any`-typed call sites can smuggle a bare Error in as the whole fields
  // arg (tsc can't catch it) — the fatal-handler bug from the M1 QA review.
  if (fields instanceof Error) return { err: prepareValue(fields, new WeakSet()) as Record<string, unknown> }
  return prepareValue(fields, new WeakSet()) as Record<string, unknown>
}

function wrap(p: PinoLogger): Logger {
  return {
    debug: (msg, fields) => p.debug(serializeFields(fields), msg),
    info: (msg, fields) => p.info(serializeFields(fields), msg),
    warn: (msg, fields) => p.warn(serializeFields(fields), msg),
    error: (msg, fields) => p.error(serializeFields(fields), msg),
    child: (bindings) => wrap(p.child(bindings)),
  }
}

/** Root logger for the Alice process. Prefer `logger.child({ scope: '…' })`
 *  per subsystem so lines stay attributable. */
export const logger: Logger = wrap(root)
