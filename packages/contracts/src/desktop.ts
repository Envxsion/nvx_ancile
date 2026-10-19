/**
 * ------------------------------------------------------------------
 *  Title    |  Desktop: what the supervisor and Core tell each other
 *  Ref      |  ROADMAP rows DK1, NT1, DL1, UP1 · docs/desktop.md
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  The Cockpit has no native access, so everything the
 *           |  desktop shell does for it (closing to the tray,
 *           |  native notifications, updates, quit checks) goes
 *           |  through Core: the Cockpit asks Core, the shell polls
 *           |  Core with the service token.
 *  How      |  GET /api/v1/system/desktop and PUT it: the close
 *           |  choice. POST /api/v1/system/desktop/command: a
 *           |  command for the shell (update actions, quit).
 *           |  GET /internal/v1/desktop/poll?after=<seq>: the shell,
 *           |  every few seconds: notifications to show, commands to
 *           |  run, what is running and waiting, the close choice.
 *  Note     |  Nothing here sends, approves or spends. A command
 *           |  only asks the shell to do something to the app itself.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

/** What closing the window does: ask the first time, then keep running in the tray, or quit. */
export const CloseBehaviour = z.enum(['ask', 'tray', 'quit']);
export type CloseBehaviour = z.infer<typeof CloseBehaviour>;

/** What the last update changed, kept so the "What changed" sheet can open once. */
export const LastUpdate = z
  .object({
    from: z.string().max(64),
    to: z.string().max(64),
    notes: z.string().max(8000).nullable(),
    at: z.string(),
  })
  .strict();
export type LastUpdate = z.infer<typeof LastUpdate>;

/** GET /api/v1/system/desktop. */
export const DesktopState = z.object({
  close: CloseBehaviour,
  /** The window is hidden to the tray right now. */
  hidden: z.boolean(),
  /** Services still starting after Core opened the window ("sources and search"); the status bar shows them. */
  warming: z.array(z.string()),
  last_update: LastUpdate.nullable(),
  /** Pro's desktop extras are on (background jobs, notification buttons, flow links, Beta and Go back). */
  pro: z.boolean(),
});
export type DesktopState = z.infer<typeof DesktopState>;

/** PUT /api/v1/system/desktop. */
export const DesktopPatch = z.object({ close: CloseBehaviour }).strict();
export type DesktopPatch = z.infer<typeof DesktopPatch>;

/** The actions on a native notification. Only an ordinary request carries them, and only in Pro. */
export const NotificationAction = z.object({ id: z.enum(['approve', 'deny']), label: z.string() }).strict();
export type NotificationAction = z.infer<typeof NotificationAction>;

/** One native notification for the shell to show. */
export const DesktopNotification = z
  .object({
    seq: z.number().int(),
    /** Stable: the shell never shows one id twice. */
    id: z.string(),
    kind: z.enum(['approval', 'run', 'notice']),
    title: z.string(),
    /** Hidden (null) for a private notebook or a place that keeps data on this computer. */
    body: z.string().nullable(),
    /** Where clicking it goes in the Cockpit. Opens a view; never answers anything. */
    href: z.string(),
    /** Present for an approval: the action buttons (Pro, ordinary requests only). */
    approval_id: z.string().optional(),
    actions: z.array(NotificationAction).default([]),
  })
  .strict();
export type DesktopNotification = z.infer<typeof DesktopNotification>;

/** What the Cockpit may ask the shell to do. */
export const DesktopCommandKind = z.enum([
  'quit',
  'update.check',
  'update.restart_now',
  'update.on_quit',
  'update.tonight',
  'update.cancel',
  'update.go_back',
]);
export type DesktopCommandKind = z.infer<typeof DesktopCommandKind>;

/** POST /api/v1/system/desktop/command. */
export const DesktopCommandRequest = z.object({ command: DesktopCommandKind }).strict();
export type DesktopCommandRequest = z.infer<typeof DesktopCommandRequest>;

export const DesktopCommand = z.object({ seq: z.number().int(), command: DesktopCommandKind }).strict();
export type DesktopCommand = z.infer<typeof DesktopCommand>;

/** GET /internal/v1/desktop/poll: the shell's one regular look at Core. */
export const DesktopPoll = z
  .object({
    seq: z.number().int(),
    notifications: z.array(DesktopNotification),
    commands: z.array(DesktopCommand),
    close: CloseBehaviour,
    /** Approvals waiting for an answer. */
    approvals: z.number().int().nonnegative(),
    /** Runs still working (a Claude Code session in a terminal is not ours to stop). */
    runs: z.number().int().nonnegative(),
    /** Pro: keep scheduled jobs going with the window hidden, and say so in the tray. */
    background: z.boolean(),
  })
  .strict();
export type DesktopPoll = z.infer<typeof DesktopPoll>;

/** POST /internal/v1/desktop/window: the shell says what the window is doing. */
export const DesktopWindowReport = z
  .object({
    visible: z.boolean(),
    focused: z.boolean(),
    warming: z.array(z.string().max(60)).max(8).default([]),
  })
  .strict();
export type DesktopWindowReport = z.infer<typeof DesktopWindowReport>;

/** PUT /internal/v1/desktop/close: the shell remembers the answer to its first-close question. */
export const DesktopCloseReport = z.object({ close: CloseBehaviour }).strict();

/** POST /internal/v1/desktop/updated: the shell, after the app started on a new version. */
export const DesktopUpdatedReport = LastUpdate.omit({ at: true }).strict();
export type DesktopUpdatedReport = z.infer<typeof DesktopUpdatedReport>;

/** POST /internal/v1/desktop/approval-action: a button on a notification (Pro). */
export const DesktopApprovalAction = z
  .object({ approval_id: z.string().min(1).max(64), action: z.enum(['approve', 'deny']) })
  .strict();
export type DesktopApprovalAction = z.infer<typeof DesktopApprovalAction>;
