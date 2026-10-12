/**
 * ------------------------------------------------------------------
 *  Title    |  Activity: what is running
 *  Ref      |  docs/activity.md · ROADMAP G (Scale, performance and visibility)
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  One read-only list of what is going on: NVX Ancile's own
 *           |  durable runs, Claude Code sessions open elsewhere,
 *           |  subagents still working and background shells Claude
 *           |  Code started, each pointing at its thread.
 *  How      |  GET /activity answers ActivityResponse. The global event
 *           |  `activity.changed` says the running count moved, so the
 *           |  status bar and an open panel refetch. POST
 *           |  /activity/typing tells Core the person is typing, so a
 *           |  background import waits for them.
 *  Note     |  Closed shapes only. Never a system process list: every
 *           |  row is something NVX Ancile started or read from a
 *           |  Claude Code transcript. Shell commands are one line,
 *           |  cut short, with key shapes redacted.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';
import { ImportProgress } from './claudecode';
import { RunStatus } from './events';

/** What a row is. */
export const ActivityKind = z.enum(['run', 'claude_session', 'subagent', 'shell']);
export type ActivityKind = z.infer<typeof ActivityKind>;

/** Where it stands, as far as NVX Ancile (or the transcript) can tell. */
export const ActivityState = z.enum(['running', 'waiting', 'finished', 'failed', 'stopped']);
export type ActivityState = z.infer<typeof ActivityState>;

/** Why a Claude Code session counts as open elsewhere. */
export const ActivityHeld = z.enum(['terminal', 'recent']);
export type ActivityHeld = z.infer<typeof ActivityHeld>;

export const ActivityRunKind = z.enum([
  'chat_turn',
  'agent',
  'research',
  'factcheck',
  'automation',
  'diagnostic',
  'flow_try',
  'claude_code',
]);
export type ActivityRunKind = z.infer<typeof ActivityRunKind>;

export const ActivityItem = z
  .object({
    /** Stable across refreshes: `run:<id>`, `cc:<session>`, `agent:<session>:<call>`, `shell:<session>:<call>`. */
    id: z.string(),
    kind: ActivityKind,
    /** What it is, in a few words ("Fact-check", "Explore the parser", "pnpm test"). */
    title: z.string(),
    /** One line of progress or context, when there is one. */
    detail: z.string().nullable(),
    state: ActivityState,
    started_at: z.string().nullable(),
    /** When it last moved (a run's last write, a transcript's last line about it). */
    updated_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    /** Where it lives in NVX Ancile, when it is there. */
    thread_id: z.string().nullable(),
    thread_title: z.string().nullable(),
    message_id: z.string().nullable(),
    /** Runs: their kind and status. */
    run_kind: ActivityRunKind.nullable(),
    run_status: RunStatus.nullable(),
    /** Steps or claims done of total, when the run says. */
    progress: z
      .object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
      .strict()
      .nullable(),
    /** Claude Code rows: the session and its folder's last part. */
    session_id: z.string().nullable(),
    project: z.string().nullable(),
    /** Claude Code sessions: held by a terminal, or only written a moment ago. */
    held: ActivityHeld.nullable(),
  })
  .strict();
export type ActivityItem = z.infer<typeof ActivityItem>;

/** GET /activity */
export const ActivityResponse = z
  .object({
    items: z.array(ActivityItem),
    /** Rows still running or waiting (finished shells shown for a while do not count). */
    running: z.number().int().nonnegative(),
    import: ImportProgress.nullable(),
    at: z.string(),
  })
  .strict();
export type ActivityResponse = z.infer<typeof ActivityResponse>;

/** POST /activity/typing: the person is typing; background imports wait about `ms` more (at most 10 s). */
export const ActivityTypingRequest = z
  .object({ ms: z.number().int().min(0).max(10_000).optional() })
  .strict();
export type ActivityTypingRequest = z.infer<typeof ActivityTypingRequest>;
