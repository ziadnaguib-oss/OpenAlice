import { http, HttpResponse } from 'msw'
import { demoScheduleSnapshot } from '../fixtures/schedule'

// GET /api/schedule returns the SNAPSHOT shape (workspaces[].tasks[], each task
// now carrying `issue`) — NOT the workspace file shape. The `.alice/issue.json`
// file's `issues` wrapper key is server-side only and is not mocked here, so no
// wrapper-key rename applies; the demo just passes the snapshot fixture through.
export const scheduleHandlers = [
  http.get('/api/schedule', () => HttpResponse.json(demoScheduleSnapshot)),

  // GET /api/schedule/dry-run?days=N → planned fires over the horizon (AU-7).
  http.get('/api/schedule/dry-run', ({ request }) => {
    const days = Number(new URL(request.url).searchParams.get('days') ?? 7)
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    return HttpResponse.json({
      generatedAt: now,
      days,
      workspaces: [
        {
          wsId: 'ws-demo',
          tag: 'chat',
          issues: [
            {
              id: 'daily-market-scan',
              title: 'Daily market scan',
              calendar: 'us-market',
              retries: 1,
              fires: Array.from({ length: Math.min(days, 7) }, (_, i) => {
                const at = now + (i + 1) * day
                const wd = new Date(at).getUTCDay()
                const weekend = wd === 0 || wd === 6
                return { at, skipped: weekend, ...(weekend ? { skipReason: 'weekend' } : {}) }
              }),
            },
          ],
        },
      ],
    })
  }),
]
