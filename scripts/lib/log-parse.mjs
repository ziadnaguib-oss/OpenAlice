/**
 * Parsers for values the smoke harnesses lift out of Alice's stdout.
 *
 * Alice logs are STRUCTURED JSON since M1 (`src/core/logger.ts`), so a naive
 * to-end-of-line capture swallows the envelope's closing `"}` and yields a
 * broken path — that regression took the packaged-desktop smoke red on all
 * three platforms. These helpers understand both shapes:
 *
 *   {"level":"info","scope":"webui","msg":"local tool gateway listening on /tmp/x.sock"}
 *   local tool gateway listening on /tmp/x.sock        (legacy / plain)
 *
 * Kept as a separate module so it is unit-testable — the smoke scripts
 * themselves execute on import.
 */

const SOCKET_MARKER = 'local tool gateway listening on '

/**
 * Extract the tool-gateway socket path from a chunk of Alice output, or null.
 * Prefers a real JSON parse (exact), falling back to a bounded regex that stops
 * at the JSON string terminator rather than running to end-of-line.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function parseToolSocketPath(text) {
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.includes(SOCKET_MARKER)) continue

    // Structured line: parse it properly so no envelope can leak into the path.
    if (trimmed.startsWith('{')) {
      try {
        const msg = JSON.parse(trimmed).msg
        if (typeof msg === 'string' && msg.includes(SOCKET_MARKER)) {
          const path = msg.slice(msg.indexOf(SOCKET_MARKER) + SOCKET_MARKER.length).trim()
          if (path) return path
        }
        continue
      } catch {
        // Fall through to the bounded regex (partial/interleaved chunk).
      }
    }

    // Plain or unparseable line: stop at a quote so a JSON tail cannot leak.
    const m = trimmed.match(/local tool gateway listening on ([^"\r\n]+)/)
    const path = m?.[1]?.trim()
    if (path) return path
  }
  return null
}
