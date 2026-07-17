import { describe, it, expect } from 'vitest'

import type { EngineContext } from '../../core/types.js'
import type { WorkspaceService } from '../../workspaces/service.js'
import { createMetricsRoutes, createDebugBundleRoutes } from './metrics.js'

function fakeCtx(overrides?: { metricsEnabled?: boolean }): EngineContext {
  return {
    config: {
      metrics: { enabled: overrides?.metricsEnabled ?? true },
      trading: { apiKey: 'super-secret-broker-key' },
      engine: { port: 3000 },
    },
    toolCallLog: {
      query: async () => ({ entries: [], total: 42, page: 1, pageSize: 1, totalPages: 42 }),
    },
    // lite mode → the route skips the UTA network probe entirely.
    tradingModePolicy: () => ({ mode: 'lite', source: 'env', envLocked: true }),
  } as unknown as EngineContext
}

function fakeService(): WorkspaceService {
  return {
    headlessTasks: {
      list: () => [
        { status: 'running' }, { status: 'running' }, { status: 'done' }, { status: 'error' },
      ],
      runningCount: () => 2,
    },
  } as unknown as WorkspaceService
}

describe('/api/metrics', () => {
  it('exposes runs, queue depth, capacity, tool calls, and uta gauges', async () => {
    const app = createMetricsRoutes(fakeCtx(), () => fakeService())
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    const body = await res.text()
    expect(body).toContain('openalice_headless_runs_total{status="running"} 2')
    expect(body).toContain('openalice_headless_runs_total{status="done"} 1')
    expect(body).toContain('openalice_headless_running 2')
    expect(body).toContain('openalice_headless_capacity 8')
    expect(body).toContain('openalice_tool_calls_total 42')
    expect(body).toContain('openalice_uta_up 0')
    expect(body).toContain('# TYPE openalice_headless_running gauge')
  })

  it('answers even when the workspace service is not up yet', async () => {
    const app = createMetricsRoutes(fakeCtx(), () => null)
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('openalice_headless_running 0')
  })

  it('is a 404 when config.metrics.enabled is false', async () => {
    const app = createMetricsRoutes(fakeCtx({ metricsEnabled: false }), () => fakeService())
    expect((await app.request('/')).status).toBe(404)
  })
})

describe('/api/debug/bundle', () => {
  it('exports versions + redacted config + recent logs', async () => {
    const app = createDebugBundleRoutes(fakeCtx())
    const res = await app.request('/bundle')
    expect(res.status).toBe(200)
    const bundle = await res.json()
    expect(bundle.app.node).toBe(process.version)
    expect(typeof bundle.app.version).toBe('string')
    expect(Array.isArray(bundle.recentLogs)).toBe(true)
    // Secret-shaped config values must never leave the process.
    expect(JSON.stringify(bundle)).not.toContain('super-secret-broker-key')
    expect(bundle.config.trading.apiKey).toBe('[redacted]')
  })

  it('is a 404 when metrics are disabled', async () => {
    const app = createDebugBundleRoutes(fakeCtx({ metricsEnabled: false }))
    expect((await app.request('/bundle')).status).toBe(404)
  })
})
