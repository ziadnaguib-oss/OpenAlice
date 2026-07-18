/**
 * Durable task queue — record shapes (M4 / ai-os-design § 5).
 *
 * A queued task is the EXECUTION ENVELOPE for one headless run: who runs it,
 * with what prompt, under which lane/priority, and what happens after. The
 * work itself still lives in the workspace's issue file — the queue never
 * interprets it (invariant: the launcher schedules, the agent decides).
 */

/** Lower number = claimed first. Interactive beats events beats cron. */
export const PRIORITY = {
  interactive: 10,
  event: 20,
  cron: 30,
} as const

export type TaskSource = 'manual' | 'schedule' | 'chain' | 'webhook'

export interface QueueTask {
  /** Stable id — also the HeadlessTaskRegistry record id, so one run has one id. */
  id: string
  source: TaskSource
  wsId: string
  /** Adapter id resolved at enqueue time. */
  agent: string
  prompt: string
  /** The firing issue, when this task came from one. */
  issueId?: string
  /** Concurrency lane. Defaults to the per-workspace serial lane. */
  lane: string
  /** See PRIORITY. */
  priority: number
  /** 1-based attempt within a retry chain. */
  attempt: number
  maxAttempts: number
  /** Base retry delay; doubles per attempt via `notBefore`. */
  backoffMs: number
  timeoutMs: number
  idleTimeoutMs?: number
  /** Not claimable before this instant (retry backoff / future scheduling). */
  notBefore: number
  /** Issue ids in the same workspace that must be terminal before this runs. */
  dependsOn?: string[]
  /** Issue ids to enqueue when this task reaches a terminal outcome. */
  chain?: { onSuccess?: string; onFailure?: string }
  createdAt: number
}

/** A claimed task, annotated with who owns it (for crash reconcile). */
export interface RunningTask extends QueueTask {
  claimedAt: number
  /** PID of the Alice process that claimed it. Its death orphans the run. */
  claimedByPid: number
}

export interface LaneConfig {
  /** Max concurrent claims across the whole queue. */
  globalConcurrency: number
  /**
   * When true (default) a task with no explicit lane runs in `ws:<wsId>`,
   * which has concurrency 1 — so one workspace never competes with itself.
   * Set false + globalConcurrency 8 to restore exact pre-M4 behavior.
   */
  perWorkspaceSerial: boolean
  /** Explicit named lanes and their concurrency (e.g. fan-out lanes). */
  lanes: Record<string, { concurrency: number }>
}

export const DEFAULT_LANES: LaneConfig = {
  globalConcurrency: 8,
  perWorkspaceSerial: true,
  lanes: {},
}

/** The lane a task belongs to, given the config. */
export function resolveLane(task: Pick<QueueTask, 'lane' | 'wsId'>, cfg: LaneConfig): string {
  return task.lane || (cfg.perWorkspaceSerial ? `ws:${task.wsId}` : 'default')
}

/** Concurrency allowed in a lane. Unknown lanes: serial if it is a
 *  per-workspace lane, else unbounded-within-global. */
export function laneConcurrency(lane: string, cfg: LaneConfig): number {
  const explicit = cfg.lanes[lane]
  if (explicit) return explicit.concurrency
  if (lane.startsWith('ws:')) return 1
  return cfg.globalConcurrency
}

/**
 * Pending filename encodes claim ORDER: zero-padded priority, then enqueue
 * time, then id. A plain lexical sort of the directory is therefore the
 * claim order — no directory-wide read-and-parse needed to pick the next task.
 */
export function pendingFileName(task: QueueTask): string {
  return `${String(task.priority).padStart(3, '0')}-${String(task.createdAt).padStart(14, '0')}-${task.id}.json`
}
