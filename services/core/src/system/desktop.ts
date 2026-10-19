/**
 * ------------------------------------------------------------------
 *  Title    |  Desktop host
 *  Ref      |  ROADMAP rows DK1, NT1, UP1, DL1 · docs/desktop.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The Cockpit has no native access. This is the one place
 *           |  the desktop shell and the Cockpit meet: what closing the
 *           |  window does, what is running and waiting (for the quit
 *           |  check), which events deserve a native notification, and
 *           |  the commands the Cockpit gives the shell (update
 *           |  actions, quit).
 *  How      |  The shell polls GET /internal/v1/desktop/poll?after=N
 *           |  every few seconds with the service token and gets what
 *           |  is new since N: notifications and commands, plus the
 *           |  counts. Core listens to the event bus and queues a
 *           |  notification for an approval that waits, a run that took
 *           |  30 seconds or more, and a notice in a category the
 *           |  person set to "Desktop" (Settings → Notifications). A
 *           |  private notebook gives a title and no body. A notification is
 *           |  queued once per id. The shell shows it only while the
 *           |  window is not in front.
 *           |  Pro (feature `desktop`, asked at the moment of use): an
 *           |  ordinary approval carries Approve and Deny, and
 *           |  scheduled jobs keep going with the window hidden. A
 *           |  critical request never carries buttons.
 *  Note     |  Nothing here answers an approval by itself: a button
 *           |  press is a click on the notification, and goes through
 *           |  Pro and Core's own approval route.
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  CloseBehaviour,
  DesktopApprovalAction,
  DesktopCloseReport,
  type DesktopCommand,
  type DesktopCommandKind,
  DesktopCommandRequest,
  type DesktopNotification,
  DesktopPatch,
  type DesktopPoll,
  type DesktopState,
  DesktopUpdatedReport,
  DesktopWindowReport,
  type GlobalEvent,
  type LastUpdate,
  NotificationPrefs,
} from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import type { EventBus } from '../events/bus';
import { body } from '../http/body';
import { notFound } from '../obs/errors';
import { logFor } from '../obs/logger';
import type { ProDesktop } from '../pro/types';
import type { ScopeResolver } from '../scopes';
import type { SettingsStore } from '../settings';

const log = logFor('desktop');

/** A run shorter than this is not worth a notification: you were watching it. */
export const LONG_RUN_MS = 30_000;
const KEEP = 100;
const CLOSE = 'desktop.close';
const LAST_UPDATE = 'desktop.last_update';

type Category = 'approvals' | 'runs' | 'sources' | 'health' | 'memory';
type Where = 'desktop' | 'toast' | 'centre' | 'off';

interface Approval {
  id: string;
  status: string;
  tier: 'gated' | 'critical';
  tool: string;
  resource: string;
  thread_id: string | null;
}

export interface DesktopDeps {
  settings: SettingsStore;
  bus: EventBus;
  /** The approval store, read only. */
  approvals: {
    getApproval(id: string): Promise<Approval | undefined>;
    pendingApprovals(): Promise<unknown[]>;
  };
  /** What is running now: runs only (Claude Code in a terminal is not ours to stop). */
  runningRuns(): Promise<number>;
  threads: { getThread(id: string): Promise<{ title: string } | undefined> };
  scopes: ScopeResolver;
  /** The Cockpit's preferences as kept by ui-state "prefs". */
  prefs(): Promise<unknown>;
  /** Pro's desktop extras, only while the licence unlocks them; null otherwise. */
  pro(): ProDesktop | null;
  now?: () => number;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What the person set for a category: the "Desktop" option or not. */
export function whereFor(prefs: unknown, category: Category): Where {
  const raw = (prefs as { prefs?: { notifications?: unknown } } | null)?.prefs?.notifications;
  const parsed = NotificationPrefs.safeParse(raw ?? {});
  return (parsed.success ? parsed.data.categories[category] : 'toast') as Where;
}

export class DesktopHost {
  private seq = 0;
  private notes: DesktopNotification[] = [];
  private cmds: DesktopCommand[] = [];
  private seen = new Set<string>();
  private started = new Map<string, number>();
  private hidden = false;
  private warming: string[] = [];
  private unsub: (() => void) | null = null;
  private since = 0;
  private readonly now: () => number;

  constructor(private readonly deps: DesktopDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.since = this.now();
    this.unsub = this.deps.bus.subscribe(0, (e) => {
      // The ring replays old events on subscribe: only what happens from now on counts.
      if (Date.parse(e.at) < this.since - 1000) return;
      void this.on(e, this.now()).catch((err: unknown) =>
        log.warn({ err: (err as Error).message }, 'a desktop event failed'),
      );
    });
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
  }

  /* ---- what the window does when closed ----------------------------------- */

  async close(): Promise<CloseBehaviour> {
    const v = CloseBehaviour.safeParse(await this.deps.settings.get(CLOSE));
    return v.success ? v.data : 'ask';
  }

  async setClose(close: CloseBehaviour): Promise<void> {
    await this.deps.settings.set(CLOSE, close);
  }

  report(r: { visible: boolean; focused: boolean; warming?: string[] }): void {
    this.hidden = !r.visible;
    this.warming = r.warming ?? [];
  }

  isHidden(): boolean {
    return this.hidden;
  }

  /** Your own scheduled automations wait: hidden in the tray, and Pro's background mode is not on. */
  holdsSchedules(): boolean {
    return this.hidden && !(this.deps.pro()?.keepsJobsInBackground() ?? false);
  }

  async lastUpdate(): Promise<LastUpdate | null> {
    return (await this.deps.settings.get<LastUpdate>(LAST_UPDATE)) ?? null;
  }

  async updated(r: { from: string; to: string; notes: string | null }): Promise<void> {
    await this.deps.settings.set(LAST_UPDATE, { ...r, at: new Date(this.now()).toISOString() });
  }

  async state(): Promise<DesktopState> {
    return {
      close: await this.close(),
      hidden: this.hidden,
      warming: this.warming,
      last_update: await this.lastUpdate(),
      pro: this.deps.pro() !== null,
    };
  }

  /* ---- the Cockpit's commands for the shell -------------------------------- */

  command(kind: DesktopCommandKind): void {
    if (kind === 'update.go_back' && !this.deps.pro())
      throw new AncileError({
        code: 'pro.feature_required',
        title: 'Going back to the previous version is part of NVX Ancile Pro',
        hint: 'Turn on Pro in Admin → Licence. Your data is backed up first whenever an older version is installed.',
        status: 402,
        errorClass: 'permanent',
        context: { feature: 'desktop' },
      });
    this.cmds.push({ seq: ++this.seq, command: kind });
    if (this.cmds.length > KEEP) this.cmds.shift();
  }

  /* ---- the shell's look ------------------------------------------------------- */

  async poll(after: number, countsOnly = false): Promise<DesktopPoll> {
    // Core started again since the shell last looked: its cursor is ahead of ours.
    const from = after > this.seq ? 0 : after;
    const [approvals, runs, close] = await Promise.all([
      this.deps.approvals.pendingApprovals().then(
        (a) => a.length,
        () => 0,
      ),
      this.deps.runningRuns().catch(() => 0),
      this.close(),
    ]);
    return {
      seq: this.seq,
      notifications: countsOnly ? [] : this.notes.filter((n) => n.seq > from),
      commands: countsOnly ? [] : this.cmds.filter((c) => c.seq > from),
      close,
      approvals,
      runs,
      background: this.deps.pro()?.keepsJobsInBackground() ?? false,
    };
  }

  /** A button on a notification (Pro). Refused in the free build, for a critical request, or one already answered. */
  async approvalAction(id: string, action: 'approve' | 'deny'): Promise<{ status: string }> {
    const pro = this.deps.pro();
    if (!pro)
      throw new AncileError({
        code: 'pro.feature_required',
        title: 'Answering from a notification is part of NVX Ancile Pro',
        hint: 'Open the request in NVX Ancile to answer it, or turn on Pro in Admin → Licence.',
        status: 402,
        errorClass: 'permanent',
        context: { feature: 'desktop' },
      });
    // Whatever Pro does, a critical request is only ever answered in the app.
    const a = await this.deps.approvals.getApproval(id);
    if (!a) throw notFound('That request');
    if (a.tier === 'critical')
      throw new AncileError({
        code: 'desktop.critical_in_app',
        title: 'A critical request can only be answered in NVX Ancile',
        hint: 'Open the request in the app to read what it will do, then decide there.',
        status: 403,
        errorClass: 'permanent',
      });
    if (a.status !== 'pending')
      throw new AncileError({
        code: 'desktop.already_answered',
        title: 'That request was already answered',
        hint: 'Nothing more to do.',
        status: 409,
        errorClass: 'permanent',
      });
    return pro.decideFromNotification(id, action);
  }

  /* ---- events to notifications --------------------------------------------- */

  private push(
    n: Omit<DesktopNotification, 'seq' | 'actions'> & { actions?: DesktopNotification['actions'] },
  ): void {
    if (this.seen.has(n.id)) return;
    this.seen.add(n.id);
    if (this.seen.size > KEEP * 5) this.seen = new Set([...this.seen].slice(-KEEP * 2));
    this.notes.push({ ...n, actions: n.actions ?? [], seq: ++this.seq });
    if (this.notes.length > KEEP) this.notes.shift();
  }

  /** The thread is in a private notebook: say that something happened, not what. */
  private async hideBody(threadId: string | null): Promise<boolean> {
    if (!threadId) return false;
    try {
      return (await this.deps.scopes.effective({ threadId })).private;
    } catch {
      // Cannot tell: say nothing about the content.
      return true;
    }
  }

  /** `t` is when the event arrived: reading prefs takes a moment, and a run's length must not include it. */
  private async on(e: GlobalEvent, t: number): Promise<void> {
    const prefs = await this.deps.prefs().catch(() => null);
    switch (e.type) {
      case 'approval.requested': {
        if (whereFor(prefs, 'approvals') !== 'desktop') return;
        const a = await this.deps.approvals.getApproval(e.approval_id);
        if (a?.status !== 'pending') return;
        const hide = await this.hideBody(a.thread_id);
        const pro = this.deps.pro();
        const actions = pro ? await pro.notificationActions({ id: a.id, tier: a.tier }).catch(() => []) : [];
        this.push({
          id: `approval:${a.id}`,
          kind: 'approval',
          title:
            a.tier === 'critical'
              ? 'A critical request needs your decision'
              : 'A request needs your go-ahead',
          body: hide ? null : clip(`${a.tool}: ${a.resource}`, 140),
          href: `/open/approval/${encodeURIComponent(a.id)}`,
          approval_id: a.id,
          actions,
        });
        return;
      }
      case 'run.updated': {
        if (e.status === 'queued' || e.status === 'running') {
          if (!this.started.has(e.run_id)) this.started.set(e.run_id, t);
          if (this.started.size > 500) this.started.delete(this.started.keys().next().value as string);
          return;
        }
        if (e.status === 'waiting_approval' || e.status === 'waiting_compute') return;
        const began = this.started.get(e.run_id);
        this.started.delete(e.run_id);
        if (began === undefined || t - began < LONG_RUN_MS || e.status === 'cancelled' || !e.thread_id)
          return;
        if (whereFor(prefs, 'runs') !== 'desktop') return;
        const hide = await this.hideBody(e.thread_id);
        const thread = hide ? undefined : await this.deps.threads.getThread(e.thread_id);
        this.push({
          id: `run:${e.run_id}`,
          kind: 'run',
          title: e.status === 'succeeded' ? 'An answer is ready' : 'An answer did not finish',
          body: thread ? clip(thread.title, 140) : null,
          href: `/t/${encodeURIComponent(e.thread_id)}`,
        });
        return;
      }
      case 'notification': {
        // Approvals and long runs have their own notifications above.
        if (!e.category || e.category === 'approvals' || e.category === 'runs') return;
        if (whereFor(prefs, e.category) !== 'desktop') return;
        this.push({
          id: `notice:${e.id}`,
          kind: 'notice',
          title: e.title,
          body: e.body ? clip(e.body, 140) : null,
          href: e.action?.href ?? '/',
        });
        return;
      }
      default:
        return;
    }
  }
}

/** For the Cockpit: GET/PUT the close choice, the last update, and commands for the shell. */
export function desktopRoutes(host: DesktopHost) {
  const r = new Hono<AppEnv>();
  r.get('/system/desktop', async (c) => {
    c.header('cache-control', 'no-store');
    return c.json(await host.state());
  });
  r.put('/system/desktop', async (c) => {
    const req = await body(c, DesktopPatch);
    await host.setClose(req.close);
    return c.json(await host.state());
  });
  r.post('/system/desktop/command', async (c) => {
    const req = await body(c, DesktopCommandRequest);
    host.command(req.command);
    return c.json({ queued: req.command }, 202);
  });
  return r;
}

/** For the desktop shell only (service token). */
export function desktopInternalRoutes(host: DesktopHost) {
  const r = new Hono<AppEnv>();
  r.get('/desktop/poll', async (c) => {
    const after = Number(c.req.query('after') ?? 0);
    c.header('cache-control', 'no-store');
    // counts=1: only the numbers (the quit check), leaving what is queued for the next regular poll.
    return c.json(
      await host.poll(
        Number.isFinite(after) && after > 0 ? Math.floor(after) : 0,
        c.req.query('counts') === '1',
      ),
    );
  });
  r.put('/desktop/close', async (c) => {
    await host.setClose((await body(c, DesktopCloseReport)).close);
    return c.json({ ok: true });
  });
  r.post('/desktop/window', async (c) => {
    host.report(await body(c, DesktopWindowReport));
    return c.json({ ok: true });
  });
  r.post('/desktop/updated', async (c) => {
    await host.updated(await body(c, DesktopUpdatedReport));
    return c.json({ ok: true });
  });
  r.post('/desktop/approval-action', async (c) => {
    const req = await body(c, DesktopApprovalAction);
    return c.json(await host.approvalAction(req.approval_id, req.action));
  });
  return r;
}
