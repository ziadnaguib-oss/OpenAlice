/**
 * Contract test for the smoke harnesses' log parsing.
 *
 * This exists because M1's console→structured-logger migration silently broke
 * the desktop PTY smoke: the old to-end-of-line capture started swallowing the
 * JSON envelope's `"}`, producing an ENOENT socket path on all three platforms.
 * The fixture below is the REAL emitted shape, so a future logging change that
 * breaks the harness fails here instead of in a packaging job.
 */

import { describe, it, expect } from 'vitest'

// @ts-expect-error — plain .mjs helper shared with the smoke scripts.
import { parseToolSocketPath } from './log-parse.mjs'

const UNIX_SOCK = '/var/folders/g3/pffjr_y96bq06blnkf72x_hw0000gn/T/openalice-15174-tools.sock'
const WIN_PIPE = '\\\\.\\pipe\\openalice-15174-tools'

describe('parseToolSocketPath', () => {
  it('extracts the path from the CURRENT structured log line', () => {
    const line = JSON.stringify({
      level: 'info',
      ts: '2026-07-18T09:49:33.458Z',
      scope: 'webui',
      msg: `local tool gateway listening on ${UNIX_SOCK}`,
    })
    expect(parseToolSocketPath(line)).toBe(UNIX_SOCK)
  })

  it('never leaks the JSON envelope into the path (the M1 regression)', () => {
    const line = JSON.stringify({
      level: 'info',
      scope: 'webui',
      msg: `local tool gateway listening on ${UNIX_SOCK}`,
    })
    const parsed = parseToolSocketPath(line)
    expect(parsed).not.toContain('"')
    expect(parsed).not.toContain('}')
    expect(parsed?.endsWith('.sock')).toBe(true)
  })

  it('still handles the legacy plain-text line', () => {
    expect(parseToolSocketPath(`local tool gateway listening on ${UNIX_SOCK}`)).toBe(UNIX_SOCK)
  })

  it('handles a Windows named pipe', () => {
    const line = JSON.stringify({ msg: `local tool gateway listening on ${WIN_PIPE}` })
    expect(parseToolSocketPath(line)).toBe(WIN_PIPE)
  })

  it('finds the line inside a multi-line chunk with other log records', () => {
    const chunk = [
      JSON.stringify({ level: 'info', scope: 'boot', msg: 'engine: started' }),
      JSON.stringify({ level: 'info', scope: 'webui', msg: `local tool gateway listening on ${UNIX_SOCK}` }),
      JSON.stringify({ level: 'info', scope: 'webui', msg: 'web plugin listening over Electron IPC' }),
    ].join('\n')
    expect(parseToolSocketPath(chunk)).toBe(UNIX_SOCK)
  })

  it('returns null when the marker is absent', () => {
    expect(parseToolSocketPath('{"msg":"something else"}')).toBeNull()
    expect(parseToolSocketPath('')).toBeNull()
  })

  it('tolerates a truncated/interleaved chunk without leaking a quote', () => {
    const partial = `{"level":"info","scope":"webui","msg":"local tool gateway listening on ${UNIX_SOCK}`
    expect(parseToolSocketPath(partial)).toBe(UNIX_SOCK)
  })
})
