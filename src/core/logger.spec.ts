import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

type LoggerModule = typeof import('./logger.js')

let out: string[]
let err: string[]
let outSpy: ReturnType<typeof vi.spyOn>
let errSpy: ReturnType<typeof vi.spyOn>

async function freshLogger(env: Record<string, string> = {}): Promise<LoggerModule> {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  return import('./logger.js')
}

beforeEach(() => {
  out = []
  err = []
  outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk))
    return true
  })
  errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err.push(String(chunk))
    return true
  })
})

afterEach(() => {
  outSpy.mockRestore()
  errSpy.mockRestore()
  vi.unstubAllEnvs()
})

describe('core logger', () => {
  it('emits the launcher wire shape: ts + string level + msg', async () => {
    const { logger } = await freshLogger()
    logger.info('hello world', { a: 1 })
    const rec = JSON.parse(out.at(-1) ?? '{}')
    expect(rec.msg).toBe('hello world')
    expect(rec.level).toBe('info')
    expect(rec.a).toBe(1)
    expect(typeof rec.ts).toBe('string')
    expect(() => new Date(rec.ts)).not.toThrow()
    // pino defaults we deliberately drop
    expect(rec.pid).toBeUndefined()
    expect(rec.hostname).toBeUndefined()
  })

  it('routes warn/error to stderr, info to stdout (launcher parity)', async () => {
    const { logger } = await freshLogger()
    logger.info('to stdout')
    logger.warn('to stderr')
    logger.error('also stderr')
    expect(out.join('')).toContain('to stdout')
    expect(err.join('')).toContain('to stderr')
    expect(err.join('')).toContain('also stderr')
  })

  it('OPENALICE_LOG_LEVEL filters below-threshold records', async () => {
    const { logger } = await freshLogger({ OPENALICE_LOG_LEVEL: 'warn' })
    logger.info('suppressed')
    logger.warn('visible')
    expect(out.join('')).not.toContain('suppressed')
    expect(err.join('')).toContain('visible')
  })

  it('child bindings ride every record', async () => {
    const { logger } = await freshLogger()
    logger.child({ scope: 'mcp' }).info('scoped')
    const rec = JSON.parse(out.at(-1) ?? '{}')
    expect(rec.scope).toBe('mcp')
  })

  it('serializes Error fields into plain objects', async () => {
    const { logger } = await freshLogger()
    logger.error('boom', { err: new Error('kapow') })
    const rec = JSON.parse(err.at(-1) ?? '{}')
    expect(rec.err.message).toBe('kapow')
    expect(typeof rec.err.stack).toBe('string')
  })

  it('redacts secret-shaped field values in emitted lines', async () => {
    const { logger } = await freshLogger()
    logger.info('creds', { apiKey: 'sk-live-verysecret', ctx: { token: 'tok-123' } })
    const line = out.at(-1) ?? ''
    expect(line).not.toContain('sk-live-verysecret')
    expect(line).not.toContain('tok-123')
    expect(line).toContain('[redacted]')
  })

  it('keeps a bounded ring of recent lines for the crash bundle', async () => {
    const { logger, getRecentLogs } = await freshLogger()
    for (let i = 0; i < 510; i++) logger.info(`line-${i}`)
    const ring = getRecentLogs()
    expect(ring.length).toBe(500)
    expect(ring.at(-1)).toContain('line-509')
    expect(ring[0]).toContain('line-10') // oldest 10 evicted
  })

  it('redactSecrets deep-redacts by key pattern without mutating input', async () => {
    const { redactSecrets } = await freshLogger()
    const input = {
      trading: { apiKey: 'real-key', nested: [{ password: 'hunter2', symbol: 'BTC' }] },
      port: 47331,
    }
    const red = redactSecrets(input) as typeof input
    expect(red.trading.apiKey).toBe('[redacted]')
    expect(red.trading.nested[0]?.password).toBe('[redacted]')
    expect(red.trading.nested[0]?.symbol).toBe('BTC')
    expect(red.port).toBe(47331)
    expect(input.trading.apiKey).toBe('real-key') // input untouched
  })
})
