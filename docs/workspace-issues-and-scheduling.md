# Workspace Issues and Self-Scheduling

This guide owns the current work-item and automation model: self-describing
markdown issues inside each Workspace, the global Issue board, schedule
scanning, headless execution, and Inbox delivery.

Related guides: [[docs/project-structure.md]] and
[[docs/development-workflow.md]]. The agent-facing usage manual ships as
`default/skills/self-scheduling/SKILL.md`.

## One Object, Two Roles

Each issue is one file:

```text
<workspace>/.alice/issues/<id>.md
```

- Without `when`, it is a tracked work item on the global Issue board.
- With `when`, the same issue self-schedules a headless run of its owning
  Workspace.

There is no central issue database and no separate schedule definition. Alice
scans every registered Workspace's live files and validates each issue in
isolation. One malformed issue is reported without breaking other files or
workspaces.

## File Contract

```markdown
---
title: Pre-market brief
status: todo
priority: high
assignee: ws:research
when: { kind: cron, cron: "30 8 * * 1-5" }
what: >
  Pull pre-market movers and overnight news, write research/premarket.md,
  then push the report to Inbox.
agent: pi
---

Prepare a concise brief before the trading day.
```

The filename stem is the stable issue id. Frontmatter:

- `title` — required human title.
- `status` — `backlog | todo | in_progress | done | canceled`; default `todo`.
- `priority` — `urgent | high | medium | low | none`; default `none`.
- `assignee` — human/workspace display ownership.
- `when` — optional schedule:
  - `{ kind: at, at: <ISO timestamp> }`
  - `{ kind: every, every: <duration> }`
  - `{ kind: cron, cron: <5-field expression> }`
- `what` — optional standalone headless prompt; falls back to title + body.
- `agent` — optional CLI adapter id; otherwise Workspace/default resolution is
  used.
- `retries` — optional extra attempts (0-5, default 0) when a fire ends
  `error` or `timeout`. Each attempt is its own run record (`attempt` /
  `maxAttempts`); a one-shot issue stays open until the chain ends. A clean
  run that produced no assistant turn (`no-report`) is NOT retried.
- `backoff` — optional base delay between retries (default `30s`); doubles
  per attempt.
- `calendar` — optional fire gate: `always` (default), `weekdays` (skip
  Sat/Sun), or `us-market` (skip weekends + US market holidays). Evaluated on
  the America/New_York calendar date; a skipped fire is not marked, so it
  fires on the next open day.

`done` and `canceled` are terminal and stop scheduled firing. There is no
separate `enabled` flag. A successful one-shot `at` issue is automatically
marked `done`; repeating schedules retain their status.

## Agent and Human Surfaces

Agents normally use:

```bash
alice-workspace issue list
alice-workspace issue show --id <id-or-title>
alice-workspace issue create --title "..."
alice-workspace issue update --id <id> --status done
alice-workspace issue comment --id <id> --text "..."
```

The CLI and MCP tools use the same implementation and write the same markdown
files. Direct file editing is also valid and is the clearest way to author the
body plus `when` / `what` / `agent` fields.

Reads such as list/show aggregate all workspaces. Writes from an autonomous or
headless run stay inside its own Workspace. Editing a peer Workspace requires
an attended, human-approved path and a commit in the peer repository.

## Execution Flow

```text
.alice/issues/<id>.md
  -> ScheduleScanner (~60s)
  -> due calculation from `when` + last-fired marker
  -> headless run of the owning Workspace
  -> native agent CLI
  -> inbox_push when there is a user-visible result
  -> Inbox item linked to the run and issue
```

The scanner interprets timing only. It hands `what` (or title + body) to the
agent unchanged. Conditions belong in that prompt: for “notify only if X,” the
run checks X and exits silently when false.

The scanner persists only last-fired markers under the launcher state root.
Schedule semantics remain in the issue file. Markers are written after a
successful dispatch; capacity/transient rejection stays due for retry. A
calendar-skipped fire is likewise not marked, so it fires on the next open day.

Every finished run carries a classified `outcome`:

| Outcome | Meaning |
|---|---|
| `success` | exited cleanly and produced an assistant turn |
| `no-report` | exited cleanly but produced no assistant turn |
| `error` | exited non-zero |
| `timeout` | the watchdog killed it (`killReason`: `idle` heartbeat stall, or the absolute `cap`) |

`GET /api/schedule/dry-run?days=N` previews planned fires (with calendar-skip
annotations) without dispatching anything.

Headless runs may overlap with interactive sessions or other runs in the same
checkout. Agents must tolerate concurrent edits. Global headless capacity is
bounded, but there is no per-Workspace exclusive lock.

## Delivery and Trading Safety

Headless stdout is diagnostic, not the user delivery channel. A run with a
meaningful result calls:

```bash
alice-workspace inbox push --doc <path> --comments "<summary>"
```

The launcher binds the run/issue origin; the agent does not pass its own
identity. A no-change check should exit silently rather than generating Inbox
noise.

When a user opens an Inbox result, Alice uses the run's captured native CLI
session id to resume the original conversation in an interactive PTY. The
created Session stores `sourceRunId`; later opens from Inbox, the Automation
panel, or the Workspace sidebar reuse that same Session instead of duplicating
it. A scheduled result therefore keeps both links: its owning issue for work
history and its originating Session for conversational follow-up.

Scheduling never bypasses trading approval. A headless agent may research or
stage a trade, but execution remains behind UTA/Trading-as-Git permission and
human approval boundaries.

## Load-Bearing Paths

| Path | Responsibility |
|---|---|
| `src/workspaces/issues/declaration.ts` | File schema, parsing, validation, prompt fallback |
| `src/workspaces/issues/mutate.ts` | Safe read-modify-write operations |
| `src/workspaces/issues/board.ts` | Global board/detail projections |
| `src/workspaces/issues/auto-complete.ts` | Successful one-shot → `done` transition |
| `src/workspaces/schedule/scanner.ts` | Workspace scan, due calculation, dispatch |
| `src/workspaces/schedule/marker-store.ts` | Atomic last-fired persistence |
| `src/workspaces/service.ts` | Scanner composition, agent resolution, headless registry |
| `src/tool/issue-tools.ts` | Workspace-scoped issue CLI/MCP tools |
| `src/tool/inbox-push.ts` | Headless/interactive delivery to Inbox |
| `src/workspaces/session-registry.ts` | Durable Session identity and run → Session source index |
| `src/webui/routes/workspaces.ts` | Idempotent headless-run → interactive-Session materialization |
| `src/webui/routes/issues.ts` | Issue board/detail HTTP API |
| `src/webui/routes/schedule.ts` | Scheduled projection API |
| `default/skills/self-scheduling/SKILL.md` | Agent-facing authoring instructions |

The retired `.alice/issue.json` and `.alice/schedule.json` formats are migrated
by `src/migrations/0010_workspace_issues_to_markdown/`. Do not add a second
central schedule store or revive the legacy cron/AgentWork path.

## Verification

```bash
npx tsc --noEmit
pnpm vitest run \
  src/workspaces/issues/declaration.spec.ts \
  src/workspaces/issues/mutate.spec.ts \
  src/workspaces/issues/board.spec.ts \
  src/workspaces/issues/auto-complete.spec.ts \
  src/workspaces/schedule/scanner.spec.ts
pnpm test
```

For UI changes, run strict UI types and verify Issue board, issue detail,
schedule projection, run history, and linked Inbox reports in the real browser
surface.
