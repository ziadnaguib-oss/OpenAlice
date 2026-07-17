/**
 * Origin gate for the PTY WebSocket upgrade — unit tests for
 * `isWsOriginAllowed`. The upgrade path itself is event-driven on
 * `http.Server` and is exercised via integration (see
 * safe/playbooks/07-websocket-auth.md); the origin decision is pure
 * and testable here.
 */

import type { IncomingMessage } from 'node:http';

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import { isUpgradeAuthorized, isWsOriginAllowed } from './workspaces-ws.js';

function cfg(origins: string[] = [], allowAnyOrigin = false) {
  return { allowAnyOrigin, allowedOrigins: new Set(origins) };
}

describe('isWsOriginAllowed', () => {
  it('allows same-origin via a LAN / Tailscale IP (the #upgrade.origin_rejected case)', () => {
    expect(isWsOriginAllowed('http://100.64.1.2:47331', '100.64.1.2:47331', cfg())).toBe(true);
    expect(isWsOriginAllowed('http://192.168.1.50:47331', '192.168.1.50:47331', cfg())).toBe(true);
  });

  it('allows same-origin via a domain (reverse proxy forwarding Host)', () => {
    expect(isWsOriginAllowed('https://alice.example.com', 'alice.example.com', cfg())).toBe(true);
  });

  it('rejects cross-origin even when auth would pass', () => {
    expect(isWsOriginAllowed('http://evil.example.com', '100.64.1.2:47331', cfg())).toBe(false);
  });

  it('rejects same host but different port (true cross-origin)', () => {
    expect(isWsOriginAllowed('http://100.64.1.2:9999', '100.64.1.2:47331', cfg())).toBe(false);
  });

  it('still honors the static allowlist for cross-origin topologies (Vite dev)', () => {
    const c = cfg(['http://localhost:5173']);
    expect(isWsOriginAllowed('http://localhost:5173', 'localhost:47331', c)).toBe(true);
  });

  it('allows missing Origin (non-browser callers; auth still gates)', () => {
    expect(isWsOriginAllowed(undefined, 'localhost:47331', cfg())).toBe(true);
    expect(isWsOriginAllowed('', 'localhost:47331', cfg())).toBe(true);
  });

  it('rejects unparseable Origin (including the literal "null" from sandboxed iframes)', () => {
    expect(isWsOriginAllowed('null', 'localhost:47331', cfg())).toBe(false);
    expect(isWsOriginAllowed('not a url', 'localhost:47331', cfg())).toBe(false);
  });

  it('rejects cross-origin when Host header is absent', () => {
    expect(isWsOriginAllowed('http://100.64.1.2:47331', undefined, cfg())).toBe(false);
  });

  it('wildcard allowAnyOrigin admits everything', () => {
    expect(isWsOriginAllowed('http://evil.example.com', 'localhost:47331', cfg([], true))).toBe(true);
  });
});

/**
 * Upgrade authorization + scope enforcement (M2 QA H-1). The PTY WS grants
 * an interactive shell, so it must require the admin scope — a read-scoped
 * session must be rejected even though it is a valid session.
 */
describe('isUpgradeAuthorized (scope gate)', () => {
  let auth: typeof import('@/services/auth/index.js');

  beforeAll(async () => {
    vi.stubEnv('OPENALICE_HOME', await mkdtemp(join(tmpdir(), 'ws-auth-')));
    vi.stubEnv('OPENALICE_TRUSTED_PROXIES', ''); // no proxy → remote sockets need a cookie
    vi.stubEnv('OPENALICE_DISABLE_AUTH', '');
    // NO resetModules: the session store keeps its truth in an in-process
    // cache, so `auth` here and the `validateAndTouch` inside
    // isUpgradeAuthorized must be the SAME module instance to share it.
    auth = await import('@/services/auth/index.js');
    await auth.generateToken();
  });

  afterEach(() => { /* env stays stubbed for the file */ });

  function reqFrom(remote: string, sid?: string): IncomingMessage {
    return {
      socket: { remoteAddress: remote },
      headers: sid ? { cookie: `alice_session=${sid}` } : {},
    } as unknown as IncomingMessage;
  }

  it('rejects a remote read-scoped session (no shell for read tokens)', async () => {
    const sess = await auth.createSession({ scopes: ['read'], ip: '203.0.113.5' });
    expect(await isUpgradeAuthorized(reqFrom('203.0.113.5', sess.sid))).toBe(false);
  });

  it('rejects remote enqueue/gate:approve sessions too', async () => {
    const enq = await auth.createSession({ scopes: ['enqueue'] });
    const gate = await auth.createSession({ scopes: ['gate:approve'] });
    expect(await isUpgradeAuthorized(reqFrom('203.0.113.6', enq.sid))).toBe(false);
    expect(await isUpgradeAuthorized(reqFrom('203.0.113.7', gate.sid))).toBe(false);
  });

  it('admits a remote admin-scoped session', async () => {
    const sess = await auth.createSession({ scopes: ['admin'] });
    expect(await isUpgradeAuthorized(reqFrom('203.0.113.8', sess.sid))).toBe(true);
  });

  it('admits loopback with no cookie (local dev unchanged)', async () => {
    expect(await isUpgradeAuthorized(reqFrom('127.0.0.1'))).toBe(true);
  });

  it('rejects a remote request with no session', async () => {
    expect(await isUpgradeAuthorized(reqFrom('203.0.113.9'))).toBe(false);
  });
});
