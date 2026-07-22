/**
 * /api/metrics — Prometheus text exposition (IN-1), and
 * /api/debug/bundle — user-initiated crash bundle export (IN-2).
 *
 * Both ride the authenticated web listener (a Prometheus scraper supplies the
 * admin token as a bearer header). The exposition format is hand-rolled — a
 * dozen gauges don't justify a client library dependency.
 *
 * Gated by `config.metrics.enabled` (data/config/metrics.json, default true):
 * when disabled both endpoints answer 404 so the surface is indistinguishable
 * from absent.
 */

import { Hono } from 'hono'

import type { EngineContext } from '../../core/types.js'
import { readAuditTail, verifyAuditChain } from '../../core/audit-chain.js'
import { getRecentLogs, redactSecrets } from '../../core/logger.js'
import { getCurrentVersion } from '../../core/version.js'
import { waitForUTAReady } from '../../services/uta-supervisor/health.js'
import { resolveUTAUrl } from '../../services/uta-supervisor/url.js'
import { MAX_CONCURRENT_HEADLESS, type WorkspaceService } from '../../workspaces/service.js'

const UTA_PROBE_TIMEOUT_MS = 400

interface MetricLine {
  name: string
  help: string
  type: 'gauge' | 'counter'
  /** [labelString, value] pairs; labelString '' means no labels. */
  samples: Array<[string, number]>
}

function render(metrics: MetricLine[]): string {
  const out: string[] = []
  for (const m of metrics) {
    out.push(`# HELP ${m.name} ${m.help}`)
    out.push(`# TYPE ${m.name} ${m.type}`)
    for (const [labels, value] of m.samples) {
      out.push(`${m.name}${labels ? `{${labels}}` : ''} ${value}`)
    }
  }
  return out.join('\n') + '\n'
}

export function createMetricsRoutes(
  ctx: EngineContext,
  getWorkspaceService: () => WorkspaceService | null,
): Hono {
  const app = new Hono()

  app.get('/', async (c) => {
    if (ctx.config.metrics.enabled === false) return c.notFound()

    const svc = getWorkspaceService()
    const tasks = svc?.headlessTasks.list() ?? []
    const byStatus = new Map<string, number>()
    for (const t of tasks) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1)

    const toolCalls = await ctx.toolCallLog.query({ page: 1, pageSize: 1 })

    // Single short probe — metrics must answer fast even with UTA down.
    const mode = ctx.tradingModePolicy()
    const utaHealth = mode.mode === 'lite'
      ? null
      : await waitForUTAReady({ baseUrl: resolveUTAUrl(), timeoutMs: UTA_PROBE_TIMEOUT_MS })

    const metrics: MetricLine[] = [
      {
        name: 'openalice_info',
        help: 'Static build/runtime info.',
        type: 'gauge',
        samples: [[`version="${getCurrentVersion()}",node="${process.version}"`, 1]],
      },
      {
        name: 'openalice_process_uptime_seconds',
        help: 'Alice process uptime.',
        type: 'gauge',
        samples: [['', Math.round(process.uptime())]],
      },
      {
        name: 'openalice_process_rss_bytes',
        help: 'Alice resident set size.',
        type: 'gauge',
        samples: [['', process.memoryUsage.rss()]],
      },
      {
        name: 'openalice_headless_runs_total',
        help: 'Headless task records currently in the registry, by status.',
        type: 'gauge',
        samples: [...byStatus.entries()].map(([status, n]) => [`status="${status}"`, n]),
      },
      {
        name: 'openalice_headless_running',
        help: 'Headless tasks currently executing (queue depth).',
        type: 'gauge',
        samples: [['', svc?.headlessTasks.runningCount() ?? 0]],
      },
      {
        name: 'openalice_headless_capacity',
        help: 'Maximum concurrent headless tasks.',
        type: 'gauge',
        samples: [['', MAX_CONCURRENT_HEADLESS]],
      },
      {
        name: 'openalice_tool_calls_total',
        help: 'Tool calls recorded in the tool-call log.',
        type: 'counter',
        samples: [['', toolCalls.total]],
      },
      {
        name: 'openalice_uta_up',
        help: 'UTA carrier reachable (0/1; absent trading mode lite reports 0).',
        type: 'gauge',
        samples: [['', utaHealth ? 1 : 0]],
      },
      {
        name: 'openalice_uta_accounts',
        help: 'Accounts reported by the UTA carrier.',
        type: 'gauge',
        samples: [['', utaHealth?.utas ?? 0]],
      },
    ]

    // Empty-labeled families with no samples render as headers only — fine.
    return c.text(render(metrics), 200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    })
  })

  return app
}

export function createDebugBundleRoutes(ctx: EngineContext): Hono {
  const app = new Hono()

  // GET /api/debug/bundle → downloadable JSON: versions, redacted config
  // shape, recent structured-log ring. Everything a bug report needs and
  // nothing a bug report must not contain.
  app.get('/bundle', (c) => {
    if (ctx.config.metrics.enabled === false) return c.notFound()
    const bundle = {
      generatedAt: new Date().toISOString(),
      app: {
        version: getCurrentVersion(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        uptimeSeconds: Math.round(process.uptime()),
      },
      config: redactSecrets(ctx.config),
      recentLogs: getRecentLogs(),
    }
    c.header('content-disposition', `attachment; filename="openalice-bundle-${Date.now()}.json"`)
    return c.json(bundle)
  })

  // GET /api/debug/audit → chain verification + newest records (SE-3).
  app.get('/audit', async (c) => {
    if (ctx.config.metrics.enabled === false) return c.notFound()
    const limit = Number(c.req.query('limit') ?? 100)
    return c.json({
      verify: await verifyAuditChain(),
      tail: await readAuditTail(Number.isFinite(limit) ? limit : 100),
    })
  })

  return app
}
