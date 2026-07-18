/**
 * ScheduleScanner - the dumb external scheduler for workspace self-declared
 * issues. Each tick it enumerates every workspace, reads that workspace's own
 * `.alice/issues/<id>.md` files live, and for every SCHEDULED + due issue (one
 * that carries a `when`) fires a headless run via the workspace's automation
 * interface. Issues without a `when` are pure board work items and are ignored
 * here. It interprets NOTHING about the work - the fire prompt (`what`, else
 * title+body) is handed straight to `dispatchHeadlessTask`.
 *
 * The ~1-min tick is the scheduler's OWN control loop (a plain timer), NOT a
 * scheduled task - infrastructure periodicity never enters the self-description
 * system. There is deliberately NO per-workspace lock: if a fire collides with a
 * still-running run or a live interactive session in the same checkout, the
 * coding agent absorbs it (it lives in multi-AI-on-one-repo all day). The only
 * bound is the global headless concurrency cap inside `dispatch`.
 *
 * Due-ness carries no external schedule state (see `fireBase`): from the last
 * fire, or a never-fired baseline — `every`/`at` from epoch (fire on first
 * sight), `cron` from `now - interval` (catches an occurrence that just passed,
 * without firing immediately on creation OR never firing at all — seeding cron
 * from `now` makes `computeNextRun` always strictly future, i.e. never due).
 * Then `computeNextRun(when, base) <= now`. The marker is written only AFTER a
 * successful dispatch, so a capacity-rejected `every`/`at` fire retries next
 * tick; a `cron` fire rejected at its exact occurrence may skip to the next
 * occurrence (rare — needs the pool full at that minute).
 */

import { computeNextRun, type Schedule } from '../../core/schedule-expr.js'
import { parseDuration } from '../../core/duration.js'
import type { CliAdapter } from '../cli-adapter.js'
import type { Logger } from '../logger.js'
import type { WorkspaceMeta, WorkspaceRegistry } from '../workspace-registry.js'

import { isFireable, issueFirePrompt, readWorkspaceIssues, type IssueRecord } from '../issues/declaration.js'
import { calendarSkipReason, etDateOf } from './market-calendar.js'

import {
  fireBase,
  snapshotScheduledIssue,
  type ScheduleSnapshot,
  type ScheduleSnapshotTask,
  type ScheduleSnapshotWorkspace,
} from './declaration.js'

export interface DryRunFire {
  /** Planned fire time (epoch ms). */
  at: number
  /** True when the calendar gate would skip this fire. */
  skipped: boolean
  skipReason?: string
}
export interface DryRunIssue {
  id: string
  title: string
  calendar: string
  retries: number
  fires: DryRunFire[]
  /** True when the horizon holds more fires than the per-issue cap returned —
   *  the plan is a prefix, not the whole picture. */
  truncated: boolean
}
export interface DryRunWorkspace {
  wsId: string
  tag: string
  issues: DryRunIssue[]
}
export interface ScheduleDryRun {
  generatedAt: number
  days: number
  workspaces: DryRunWorkspace[]
}

export const DEFAULT_INTERVAL_MS = 60_000
/** Absolute cap for a scheduled headless run (matches the legacy cron-router). */
const RUN_TIMEOUT_MS = 30 * 60_000
/** Heartbeat idle cap (AG-2): a scheduled run streaming nothing for this long
 *  is wedged. Well under RUN_TIMEOUT_MS so a stall is caught early. */
const RUN_IDLE_TIMEOUT_MS = 5 * 60_000
/** Dry-run horizon guard: never enumerate more than this per issue. */
const DRYRUN_MAX_FIRES = 50

/** The slice of ScheduleMarkerStore the scanner needs (structural, for testing). */
export interface MarkerStore {
  key(wsId: string, taskId: string): string
  get(wsId: string, taskId: string): number | undefined
  set(wsId: string, taskId: string, ts: number): Promise<void>
  prune(seenKeys: Set<string>): Promise<void>
}

export interface ScheduleScannerDeps {
  registry: WorkspaceRegistry
  resolveAdapter: (meta: WorkspaceMeta, agentId?: string) => CliAdapter | Promise<CliAdapter>
  dispatch: (
    meta: WorkspaceMeta,
    adapter: CliAdapter,
    prompt: string,
    timeoutMs: number,
    /** The firing issue's id — recorded on the run so the issue detail can show
     *  its real run history. The scanner ALWAYS passes it (it only fires from an
     *  issue); manual/external dispatch callers omit it. */
    issueId?: string,
    /** Retry policy + heartbeat cap threaded from the issue's frontmatter. */
    dispatchOpts?: {
      retry?: { attempt: number; maxAttempts: number; backoffMs: number }
      idleTimeoutMs?: number
    },
  ) => Promise<{ taskId: string }>
  markers: MarkerStore
  logger: Logger
  /** Injectable clock for tests. */
  now?: () => number
  /** Injectable tick interval for tests. */
  intervalMs?: number
}

export class ScheduleScanner {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private scanning = false
  /** Snapshot built as a side-effect of each scan; null until the first scan. */
  private lastSnapshot: ScheduleSnapshot | null = null
  /**
   * Dedupe key -> "<ET date>:<reason>" for the last calendar skip we LOGGED.
   * A calendar-skipped fire deliberately leaves the marker unset, so the issue
   * stays due and would otherwise re-log every tick (1,440 lines/day/issue,
   * which also flushes the crash-bundle log ring). Logging only on change
   * yields one line per issue per closed day. Pruned with the markers.
   */
  private readonly skipLogged = new Map<string, string>()
  private readonly now: () => number
  private readonly intervalMs: number

  constructor(private readonly deps: ScheduleScannerDeps) {
    this.now = deps.now ?? Date.now
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  }

  /** Begin ticking. First scan happens after one interval (never on construct). */
  start(): void {
    if (this.timer || this.stopped) return
    this.arm()
    this.deps.logger.info('schedule.scanner_started', { intervalMs: this.intervalMs })
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** The snapshot built by the last scan (warm cache for GET /api/schedule), or
   *  null before the first tick. The scanner already reads every declaration each
   *  tick, so this is free — the route serves it instead of re-walking disk. */
  snapshot(): ScheduleSnapshot | null {
    return this.lastSnapshot
  }

  private arm(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => void this.tickAndRearm(), this.intervalMs)
    // Don't hold the event loop / a test runner open on the scheduler's timer.
    this.timer.unref?.()
  }

  private async tickAndRearm(): Promise<void> {
    this.timer = null
    if (this.stopped) return
    try {
      await this.scan()
    } catch (err) {
      this.deps.logger.warn('schedule.scan_failed', { err })
    }
    if (!this.stopped) this.arm()
  }

  /** One full pass over all workspaces. Public for tests / a future "scan now". */
  async scan(): Promise<void> {
    if (this.scanning) {
      this.deps.logger.info('schedule.scan_overlap_skipped', {})
      return
    }
    this.scanning = true
    const nowMs = this.now()
    const seen = new Set<string>()
    try {
      // registry.list() order is preserved by Promise.all → stable display order.
      const workspaces = await Promise.all(
        this.deps.registry.list().map((ws) => this.scanWorkspace(ws, nowMs, seen)),
      )
      await this.deps.markers.prune(seen)
      // Same lifetime as the markers: an issue that no longer exists must not
      // pin a dedupe entry forever.
      for (const key of this.skipLogged.keys()) {
        if (!seen.has(key)) this.skipLogged.delete(key)
      }
      this.lastSnapshot = { workspaces }
    } finally {
      this.scanning = false
    }
  }

  /** Read one workspace's issues, fire its due SCHEDULED issues, and return its
   *  snapshot row (only scheduled issues — unscheduled board items never reach
   *  this layer). Reads issues ONCE — firing and the dashboard view come from the
   *  same read. Per-file-invalid issues isolate (they're surfaced to the board
   *  elsewhere); a workspace stays 'ok' as long as its issues dir read at all. */
  private async scanWorkspace(
    ws: WorkspaceMeta,
    nowMs: number,
    seen: Set<string>,
  ): Promise<ScheduleSnapshotWorkspace> {
    let res
    try {
      res = await readWorkspaceIssues(ws.dir)
    } catch (err) {
      this.deps.logger.warn('schedule.read_failed', { wsId: ws.id, err })
      return { wsId: ws.id, tag: ws.tag, status: 'invalid', error: 'failed to read issues', tasks: [] }
    }
    if (!res.ok) {
      if (res.reason === 'invalid') {
        this.deps.logger.warn('schedule.declaration_invalid', { wsId: ws.id, error: res.error })
        return { wsId: ws.id, tag: ws.tag, status: 'invalid', error: res.error, tasks: [] }
      }
      return { wsId: ws.id, tag: ws.tag, status: 'absent', tasks: [] }
    }
    if (res.invalid.length > 0) {
      this.deps.logger.warn('schedule.issue_files_invalid', {
        wsId: ws.id,
        invalid: res.invalid.map((i) => i.id),
      })
    }

    const tasks: ScheduleSnapshotTask[] = []
    for (const issue of res.issues) {
      // No `when` ⇒ pure board work item; the scanner does not touch it.
      const when = issue.when
      if (!when) continue
      seen.add(this.deps.markers.key(ws.id, issue.id))
      if (isFireable(issue) && this.isDue(ws.id, issue.id, when, nowMs)) {
        // Calendar gate (AU-4): a due fire on a closed market day is SKIPPED
        // (not marked) so it fires on the next open day. Logged only when due,
        // so a daily schedule logs at most one skip per closed day.
        const skip = calendarSkipReason(issue.calendar, nowMs)
        if (skip) {
          // Log once per issue per closed day, not once per tick (see skipLogged).
          const key = this.deps.markers.key(ws.id, issue.id)
          const et = etDateOf(nowMs)
          const stamp = `${et.year}-${et.month}-${et.day}:${skip}`
          if (this.skipLogged.get(key) !== stamp) {
            this.skipLogged.set(key, stamp)
            this.deps.logger.info('schedule.calendar_skip', {
              wsId: ws.id, taskId: issue.id, calendar: issue.calendar, reason: skip,
            })
          }
        } else {
          await this.fire(ws, issue, issueFirePrompt(issue), nowMs)
        }
      }
      // Read the marker AFTER any fire so last/next reflect a just-fired run.
      const last = this.deps.markers.get(ws.id, issue.id) ?? null
      tasks.push(snapshotScheduledIssue(issue, when, last, nowMs, this.intervalMs))
    }
    return { wsId: ws.id, tag: ws.tag, status: 'ok', tasks }
  }

  private isDue(wsId: string, taskId: string, when: Schedule, nowMs: number): boolean {
    const last = this.deps.markers.get(wsId, taskId) ?? null
    const next = computeNextRun(when, fireBase(when, last, nowMs, this.intervalMs))
    return next !== null && next <= nowMs
  }

  /**
   * Compute the planned fires over the next `days` days WITHOUT executing
   * anything (AU-7). Each fire is annotated with whether the calendar would
   * skip it, so the operator can preview "what will run, and when". Read-only:
   * touches no markers, dispatches nothing.
   */
  async dryRun(days: number, nowMs: number = this.now()): Promise<ScheduleDryRun> {
    const horizonMs = nowMs + Math.max(0, days) * 24 * 60 * 60 * 1000
    const workspaces: DryRunWorkspace[] = []
    for (const ws of this.deps.registry.list()) {
      let res
      try {
        res = await readWorkspaceIssues(ws.dir)
      } catch {
        continue
      }
      if (!res.ok) continue
      const issues: DryRunIssue[] = []
      for (const issue of res.issues) {
        if (!issue.when || !isFireable(issue)) continue
        const fires: DryRunFire[] = []
        // Forward preview: walk future occurrences strictly after `now` (NOT
        // the due-detection baseline, which sits in the past to make a fresh
        // schedule fire on first sight).
        let cursor = nowMs
        let truncated = false
        for (let i = 0; i < DRYRUN_MAX_FIRES; i++) {
          const next = computeNextRun(issue.when, cursor)
          if (next === null || next > horizonMs) break
          const skip = calendarSkipReason(issue.calendar, next)
          fires.push({ at: next, skipped: skip !== null, ...(skip ? { skipReason: skip } : {}) })
          cursor = next
          if (fires.length === DRYRUN_MAX_FIRES) {
            // One more occurrence inside the horizon ⇒ the plan is a prefix.
            const more = computeNextRun(issue.when, cursor)
            truncated = more !== null && more <= horizonMs
          }
        }
        if (fires.length > 0) {
          issues.push({
            id: issue.id,
            title: issue.title,
            calendar: issue.calendar,
            retries: issue.retries,
            fires,
            truncated,
          })
        }
      }
      if (issues.length > 0) workspaces.push({ wsId: ws.id, tag: ws.tag, issues })
    }
    return { generatedAt: nowMs, days, workspaces }
  }

  private async fire(
    ws: WorkspaceMeta,
    issue: IssueRecord,
    what: string,
    nowMs: number,
  ): Promise<void> {
    const taskId = issue.id
    const adapter = await this.deps.resolveAdapter(ws, issue.agent)
    if (!adapter.capabilities.headless || !adapter.composeHeadlessCommand) {
      this.deps.logger.warn('schedule.adapter_not_headless', { wsId: ws.id, taskId, agent: adapter.id })
      return
    }
    // Retry policy (AG-3) from the issue frontmatter. A bad `backoff` duration
    // falls back to 30s rather than failing the fire.
    const backoffMs = parseDuration(issue.backoff) ?? 30_000
    const dispatchOpts = {
      idleTimeoutMs: RUN_IDLE_TIMEOUT_MS,
      ...(issue.retries > 0
        ? { retry: { attempt: 1, maxAttempts: issue.retries + 1, backoffMs } }
        : {}),
    }
    try {
      // `taskId` here is the firing ISSUE's id (keyed by filename stem) — thread
      // it so the run records which issue triggered it.
      const { taskId: runId } = await this.deps.dispatch(ws, adapter, what, RUN_TIMEOUT_MS, taskId, dispatchOpts)
      await this.deps.markers.set(ws.id, taskId, nowMs)
      this.deps.logger.info('schedule.fired', { wsId: ws.id, taskId, agent: adapter.id, runId })
    } catch (err) {
      // Capacity full (or transient) - do NOT mark; the task stays due and
      // retries on the next tick once a headless slot frees.
      this.deps.logger.info('schedule.fire_skipped', {
        wsId: ws.id,
        taskId,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
