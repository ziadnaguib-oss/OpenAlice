/**
 * Headless task runner — the automation-dispatch primitive.
 *
 * Spawns an agent CLI's ONE-SHOT headless command (from
 * `adapter.composeHeadlessCommand`, prompt already placed) on a plain pipe and
 * waits for it to EXIT — the turn boundary that means the task is done.
 *
 * Differences from `probe.ts` (and why this is a separate primitive):
 *  - **Plain `child_process.spawn`, not node-pty.** Probe replays the user's
 *    real interactive TUI path (needs a PTY); a headless task wants clean,
 *    separated stdout/stderr — a PTY mangles the JSON stream with terminal
 *    control bytes (verified across all four adapters).
 *  - **Exit is the done signal.** One-shot modes (`-p` / `exec` / `run`) exit
 *    at the turn boundary, so we wait on exit rather than timeout-killing the
 *    way probe must (interactive TUIs never exit). The watchdog is a backstop
 *    (codex can hang under heavy logging).
 *  - **NOT routed through SessionPool/PersistentSession**, whose respawn-on-exit
 *    circuit is anti-semantic for a one-shot task (exit == completion).
 *
 * The launcher does NOT parse the output: the agent reports via `inbox_push`.
 * We only need the exit signal + a bounded output tail for diagnostics.
 */
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import type { Logger } from './logger.js';
import { resolveLaunchCommand } from './win-command.js';

const KILL_GRACE_MS = 5_000;
/** How often the watchdog re-checks the idle/cap conditions. */
const WATCHDOG_TICK_MS = 1_000;
const OUTPUT_TAIL_BYTES = 16 * 1024;
const ASSISTANT_TEXT_MAX_CHARS = 64 * 1024;
/** Scanner line buffer cap — a "line" past this without \n is not the id announcement. */
const SCAN_LINE_MAX_BYTES = 256 * 1024;

export interface HeadlessTaskArgs {
  /** Full argv WITH the prompt already placed (from composeHeadlessCommand). */
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Absolute cap: SIGTERM at `timeoutMs`, SIGKILL after a grace window. */
  readonly timeoutMs: number;
  /**
   * Heartbeat watchdog (AG-2): kill the run when NO stdout/stderr activity has
   * arrived for this long — catches a CLI that wedged (stopped streaming) well
   * before it would hit the absolute cap. Omitted ⇒ cap-only (pre-M3 behavior).
   * A healthy agent emits stream-json continuously, so idle == stuck.
   */
  readonly idleTimeoutMs?: number;
  readonly logger: Logger;
  /**
   * Stream the FULL stdout/stderr to these files (the task log an operator can
   * open later — the in-memory tails only keep the last 16KB). Parent dir is
   * created; write failure degrades to tail-only with a warn, never kills the
   * run.
   */
  readonly stdoutFile?: string;
  readonly stderrFile?: string;
  /**
   * Adapter hook (`extractHeadlessSessionId`): called once per complete stdout
   * line until it returns a non-null agent session id; `onSessionId` then fires
   * (used to record the id on the task WHILE it runs, so a finished run can be
   * reopened as an interactive session).
   */
  readonly extractSessionId?: (line: string) => string | null;
  readonly onSessionId?: (id: string) => void;
  /** Adapter-owned JSONL decoder for completed assistant messages. */
  readonly extractAssistantText?: (line: string) => string | null;
  /**
   * Default false. The normal automation path refuses Windows npm .cmd shims
   * because the task prompt is user-controlled. Runtime readiness probes pass a
   * launcher-owned fixed prompt and may opt in so opencode/Pi can be checked.
   */
  readonly allowShellShim?: boolean;
}

export interface HeadlessTaskResult {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** True if the watchdog had to kill the process (timeout, not natural exit). */
  readonly killed: boolean;
  /** Why the watchdog fired: 'idle' (heartbeat stall) or 'cap' (absolute cap). */
  readonly killReason: 'idle' | 'cap' | null;
  readonly durationMs: number;
  /** Last bytes of stdout/stderr — diagnostics only; not parsed for control flow. */
  readonly stdoutTail: string;
  readonly stderrTail: string;
  /** The agent's own session id, if `extractSessionId` found one in stdout. */
  readonly agentSessionId: string | null;
  /** Latest completed assistant reply decoded from structured stdout. */
  readonly assistantText: string | null;
}

/**
 * The four terminal outcome classes (AG-6), derived — not vendor-coupled —
 * from the run result the launcher already collects:
 *   timeout   — the watchdog killed it (idle stall or absolute cap)
 *   error     — exited non-zero on its own
 *   success   — exited zero AND produced a real assistant turn (stream-json)
 *   no-report — exited zero but emitted no assistant reply (nothing happened)
 * `success` proves a model turn without parsing vendor event schemas; the
 * launcher still never interprets the *content* (the agent reports via Inbox).
 */
export type HeadlessOutcome = 'success' | 'no-report' | 'error' | 'timeout';

export function classifyHeadlessOutcome(
  r: Pick<HeadlessTaskResult, 'killed' | 'exitCode' | 'assistantText'>,
): HeadlessOutcome {
  if (r.killed) return 'timeout';
  if (r.exitCode !== 0) return 'error';
  return r.assistantText ? 'success' : 'no-report';
}

/** error/timeout are transient enough to retry; success/no-report are terminal
 *  (no-report is a clean exit — retrying a no-op just loops). */
export function isRetryableOutcome(o: HeadlessOutcome): boolean {
  return o === 'error' || o === 'timeout';
}

/**
 * Byte-accumulating tail sink. Buffers raw chunks and decodes UTF-8 ONCE at the
 * end — so a multi-byte sequence split across two `data` chunks isn't mangled
 * into U+FFFD at the seam (which per-chunk `.toString()` would do, corrupting
 * the very JSON tail an operator reads). Memory is bounded: once well over the
 * budget the chunks collapse to the last `maxBytes`.
 */
function makeTailSink(maxBytes: number): { push(c: Buffer): void; text(): string } {
  let chunks: Buffer[] = [];
  let total = 0;
  return {
    push(c) {
      chunks.push(c);
      total += c.length;
      if (total > maxBytes * 2) {
        const merged = Buffer.concat(chunks).subarray(-maxBytes);
        chunks = [merged];
        total = merged.length;
      }
    },
    text() {
      return Buffer.concat(chunks).subarray(-maxBytes).toString('utf8');
    },
  };
}

/**
 * Newline-buffered scanner over a byte stream: feeds COMPLETE lines to
 * `extract` until it returns an id, then goes inert. A pathological "line"
 * exceeding the cap without a newline is discarded (the id announcement is a
 * small JSONL event in the first lines of every adapter's headless output).
 */
function makeStructuredOutputScanner(opts: {
  readonly extractSessionId?: (line: string) => string | null;
  readonly onSessionId: (id: string) => void;
  readonly extractAssistantText?: (line: string) => string | null;
  readonly onAssistantText: (text: string) => void;
}): { push(c: Buffer): void; finish(): void } {
  let buf = '';
  let sessionDone = false;
  const decoder = new StringDecoder('utf8');

  const inspect = (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    if (!sessionDone && opts.extractSessionId) {
      const id = opts.extractSessionId(line);
      if (id) {
        sessionDone = true;
        opts.onSessionId(id);
      }
    }
    if (opts.extractAssistantText) {
      const text = opts.extractAssistantText(line)?.trim();
      if (text) opts.onAssistantText(text);
    }
  };

  const drain = () => {
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      inspect(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
    if (buf.length > SCAN_LINE_MAX_BYTES) buf = '';
  };

  return {
    push(c) {
      buf += decoder.write(c);
      drain();
    },
    finish() {
      buf += decoder.end();
      drain();
      if (buf.trim()) inspect(buf);
      buf = '';
    },
  };
}

/** Open a log write-stream, creating the parent dir; null (+ warn) on failure. */
async function openLogStream(path: string, logger: Logger, name: string): Promise<WriteStream | null> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const ws = createWriteStream(path);
    ws.on('error', (err) => logger.warn('headless.log_write_failed', { name, path, err }));
    return ws;
  } catch (err) {
    logger.warn('headless.log_open_failed', { name, path, err });
    return null;
  }
}

export async function runHeadlessTask(args: HeadlessTaskArgs): Promise<HeadlessTaskResult> {
  const { command, cwd, env, timeoutMs, logger } = args;
  const [argv0] = command;
  if (!argv0) throw new Error('headless: empty command');

  const start = Date.now();
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let killed = false;
  let killReason: 'idle' | 'cap' | null = null;
  let lastActivity = start;
  let agentSessionId: string | null = null;
  let assistantText: string | null = null;
  const outSink = makeTailSink(OUTPUT_TAIL_BYTES);
  const errSink = makeTailSink(OUTPUT_TAIL_BYTES);
  const scanner = args.extractSessionId || args.extractAssistantText
    ? makeStructuredOutputScanner({
        ...(args.extractSessionId ? { extractSessionId: args.extractSessionId } : {}),
        ...(args.extractAssistantText ? { extractAssistantText: args.extractAssistantText } : {}),
        onSessionId: (id) => {
          agentSessionId = id;
          logger.info('headless.session_id_captured', { agentSessionId: id });
          args.onSessionId?.(id);
        },
        onAssistantText: (text) => {
          assistantText = text.slice(-ASSISTANT_TEXT_MAX_CHARS);
        },
      })
    : null;
  // win32: resolve the bare CLI name against PATH × PATHEXT. Native-exe agents
  // (claude.exe, codex.exe) resolve to a direct path and run headless fine. But
  // npm-shim agents (opencode, pi → a `.cmd`) would have to run through cmd.exe,
  // and the headless PROMPT is the trailing arg — routing it through cmd.exe
  // re-parses shell metacharacters (CVE-2024-27980 territory), a real injection
  // surface. So shim agents stay headless-unsupported on Windows; we fail with a
  // clear, recorded reason instead of a silent ENOENT. (Interactive launch of
  // the same agents works — see win-command.ts / persistent-session.ts.)
  const resolved = resolveLaunchCommand(command, { env });
  if (resolved.viaShell && !args.allowShellShim) {
    logger.error('headless.win32_shim_unsupported', { command: argv0 });
    return {
      command,
      cwd,
      exitCode: -1,
      signal: null,
      killed: false,
      killReason: null,
      durationMs: Date.now() - start,
      stdoutTail: '',
      stderrTail:
        `win32: "${argv0}" is an npm .cmd shim; headless dispatch is unsupported ` +
        `on Windows (routing the task prompt through cmd.exe is a shell-injection ` +
        `surface). Native-exe agents (claude, codex) run headless; run shim agents ` +
        `(opencode, pi) interactively instead.`,
      agentSessionId: null,
      assistantText: null,
    };
  }
  const [spawnFile, ...spawnArgs] = resolved.argv;
  if (!spawnFile) throw new Error('headless: empty command after resolution');
  const outFile = args.stdoutFile ? await openLogStream(args.stdoutFile, logger, 'stdout') : null;
  const errFile = args.stderrFile ? await openLogStream(args.stderrFile, logger, 'stderr') : null;
  const child = spawn(spawnFile, spawnArgs, {
    cwd,
    env: env as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d: Buffer) => {
    lastActivity = Date.now();
    outSink.push(d);
    scanner?.push(d);
    outFile?.write(d);
  });
  child.stderr?.on('data', (d: Buffer) => {
    lastActivity = Date.now();
    errSink.push(d);
    errFile?.write(d);
  });

  const closePromise = new Promise<void>((resolve) => {
    child.once('error', (err) => {
      // e.g. ENOENT (binary not on PATH). `close` still follows `error`, so
      // wait for it to keep stdout parsing ordered with stream shutdown.
      logger.error('headless.spawn_error', { command: argv0, err });
      errSink.push(Buffer.from(String(err)));
      if (exitCode === null) exitCode = -1;
    });
    child.once('close', (code, sig) => {
      if (exitCode !== -1) exitCode = code;
      signal = sig;
      resolve();
    });
  });

  // Watchdog armed BEFORE the await so it covers the wait. Two trip
  // conditions: an idle stall (no stream activity for idleTimeoutMs) or the
  // absolute cap (total runtime hits timeoutMs). Either fires SIGTERM, then a
  // SIGKILL after the grace window if the child ignores the term.
  const idleMs = args.idleTimeoutMs && args.idleTimeoutMs > 0 ? args.idleTimeoutMs : null;
  let hardKillTimer: ReturnType<typeof setTimeout> | null = null;
  const watchdog = setInterval(() => {
    if (killReason) return; // already tripped; waiting on grace/close
    const now = Date.now();
    if (now - start >= timeoutMs) killReason = 'cap';
    else if (idleMs && now - lastActivity >= idleMs) killReason = 'idle';
    else return;
    killed = true;
    logger.warn('headless.watchdog_kill', {
      command: argv0,
      killReason,
      idleForMs: now - lastActivity,
      runtimeMs: now - start,
    });
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    hardKillTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, KILL_GRACE_MS);
    hardKillTimer.unref();
  }, WATCHDOG_TICK_MS);
  watchdog.unref();

  await closePromise;
  clearInterval(watchdog);
  if (hardKillTimer) clearTimeout(hardKillTimer);
  scanner?.finish();
  outFile?.end();
  errFile?.end();
  const durationMs = Date.now() - start;
  const stdoutTail = outSink.text();
  const stderrTail = errSink.text();

  logger.info('headless.complete', {
    command: argv0,
    durationMs,
    exitCode,
    signal,
    killed,
    killReason,
    agentSessionId,
    assistantReply: assistantText !== null,
    stdoutBytes: stdoutTail.length,
    stderrBytes: stderrTail.length,
  });

  return {
    command,
    cwd,
    exitCode,
    signal,
    killed,
    killReason,
    durationMs,
    stdoutTail,
    stderrTail,
    agentSessionId,
    assistantText,
  };
}
