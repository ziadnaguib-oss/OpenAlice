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

const root = pino(
  {
    level: process.env['OPENALICE_LOG_LEVEL'] ?? 'info',
    base: undefined,
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    formatters: { level: (label) => ({ level: label }) },
    redact: {
      paths: [
        'apiKey', '*.apiKey', 'token', '*.token', 'secret', '*.secret',
        'password', '*.password', 'authorization', '*.authorization',
      ],
      censor: '[redacted]',
    },
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

function serializeFields(fields?: Record<string, unknown>): Record<string, unknown> {
  if (!fields) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v
  }
  return out
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
