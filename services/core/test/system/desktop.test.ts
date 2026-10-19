/**
 * The desktop host (rows DK1, NT1): which events become native
 * notifications, what a private notebook hides, that none repeats, what the
 * shell is told to count, and that a critical request never gets a button.
 */
import type { EffectiveScope } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { MemoryEventBus } from '../../src/events/bus';
import { errorHandler } from '../../src/obs/errors';
import type { ProDesktop } from '../../src/pro/types';
import { MemorySettings } from '../../src/settings';
import {
  DesktopHost,
  desktopInternalRoutes,
  desktopRoutes,
  LONG_RUN_MS,
  whereFor,
} from '../../src/system/desktop';

type Appr = {
  id: string;
  status: string;
  tier: 'gated' | 'critical';
  tool: string;
  resource: string;
  thread_id: string | null;
};

const prefsWith = (categories: Record<string, string>) => ({
  prefs: { notifications: { categories } },
  changedAt: 1,
});
const ALL_DESKTOP = prefsWith({
  approvals: 'desktop',
  runs: 'desktop',
  sources: 'desktop',
  health: 'desktop',
  memory: 'desktop',
});

function setup(
  opts: {
    approvals?: Appr[];
    prefs?: unknown;
    privateThreads?: string[];
    pro?: ProDesktop | null;
    running?: number;
  } = {},
) {
  let now = Date.parse('2026-01-01T10:00:00Z');
  const bus = new MemoryEventBus();
  const approvals = new Map((opts.approvals ?? []).map((a) => [a.id, a]));
  const host = new DesktopHost({
    settings: new MemorySettings(),
    bus,
    approvals: {
      getApproval: async (id) => approvals.get(id),
      pendingApprovals: async () => [...approvals.values()].filter((a) => a.status === 'pending'),
    },
    runningRuns: async () => opts.running ?? 0,
    threads: { getThread: async (id) => ({ title: `Thread ${id}` }) },
    scopes: {
      effective: async (ref) =>
        ({
          private: opts.privateThreads?.includes((ref as { threadId: string }).threadId) ?? false,
        }) as EffectiveScope,
    },
    prefs: async () => opts.prefs ?? ALL_DESKTOP,
    pro: () => opts.pro ?? null,
    now: () => now,
  });
  host.start();
  const settle = () => new Promise((r) => setTimeout(r, 15));
  return {
    host,
    bus,
    approvals,
    settle,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const asked = (id: string, tier: Appr['tier'] = 'gated', thread = 'thr_1'): Appr => ({
  id,
  status: 'pending',
  tier,
  tool: 'fs.write',
  resource: 'fs:/work/a.txt',
  thread_id: thread,
});

describe('which events reach the desktop', () => {
  it('notifies for a waiting approval once, however often it is announced', async () => {
    const t = setup({ approvals: [asked('apr_1')] });
    const ev = {
      type: 'approval.requested' as const,
      approval_id: 'apr_1',
      run_id: 'run_1',
      tool: 'fs.write',
      tier: 'gated' as const,
    };
    await t.bus.publish(ev);
    await t.bus.publish(ev);
    await t.settle();
    const p = await t.host.poll(0);
    expect(p.notifications).toHaveLength(1);
    expect(p.notifications[0]).toMatchObject({
      id: 'approval:apr_1',
      kind: 'approval',
      title: 'A request needs your go-ahead',
      body: 'fs.write: fs:/work/a.txt',
      href: '/open/approval/apr_1',
    });
    expect(p.approvals).toBe(1);
  });

  it('hides the body for a private notebook, but still says something is waiting', async () => {
    const t = setup({ approvals: [asked('apr_p', 'gated', 'thr_priv')], privateThreads: ['thr_priv'] });
    await t.bus.publish({
      type: 'approval.requested',
      approval_id: 'apr_p',
      run_id: 'r',
      tool: 'fs.write',
      tier: 'gated',
    });
    await t.settle();
    const [n] = (await t.host.poll(0)).notifications;
    expect(n?.title).toBe('A request needs your go-ahead');
    expect(n?.body).toBeNull();
    expect(JSON.stringify(n)).not.toContain('a.txt');
  });

  it('says nothing when the category is not set to Desktop', async () => {
    const t = setup({ approvals: [asked('apr_1')], prefs: prefsWith({ approvals: 'toast' }) });
    await t.bus.publish({
      type: 'approval.requested',
      approval_id: 'apr_1',
      run_id: 'r',
      tool: 'fs.write',
      tier: 'gated',
    });
    await t.settle();
    expect((await t.host.poll(0)).notifications).toEqual([]);
  });

  it('defaults approvals and runs to Desktop when nothing was ever saved', () => {
    expect(whereFor(null, 'approvals')).toBe('desktop');
    expect(whereFor(null, 'runs')).toBe('desktop');
    expect(whereFor(null, 'sources')).toBe('toast');
    expect(whereFor(prefsWith({ runs: 'off' }), 'runs')).toBe('off');
  });

  it('notifies for a run that took 30 seconds or more, not a quick one, and hides a private title', async () => {
    const t = setup({ privateThreads: ['thr_priv'] });
    await t.bus.publish({ type: 'run.updated', run_id: 'run_a', status: 'running', thread_id: 'thr_1' });
    t.advance(LONG_RUN_MS - 1);
    await t.bus.publish({ type: 'run.updated', run_id: 'run_a', status: 'succeeded', thread_id: 'thr_1' });
    await t.bus.publish({ type: 'run.updated', run_id: 'run_b', status: 'running', thread_id: 'thr_1' });
    t.advance(LONG_RUN_MS);
    await t.bus.publish({ type: 'run.updated', run_id: 'run_b', status: 'succeeded', thread_id: 'thr_1' });
    await t.bus.publish({ type: 'run.updated', run_id: 'run_c', status: 'running', thread_id: 'thr_priv' });
    t.advance(LONG_RUN_MS + 5);
    await t.bus.publish({ type: 'run.updated', run_id: 'run_c', status: 'failed', thread_id: 'thr_priv' });
    await t.settle();
    const { notifications } = await t.host.poll(0);
    expect(notifications.map((n) => n.id)).toEqual(['run:run_b', 'run:run_c']);
    expect(notifications[0]).toMatchObject({
      title: 'An answer is ready',
      body: 'Thread thr_1',
      href: '/t/thr_1',
    });
    expect(notifications[1]).toMatchObject({ title: 'An answer did not finish', body: null });
  });

  it('does not notify for a cancelled run or one with no thread', async () => {
    const t = setup();
    for (const [id, status, thread] of [
      ['run_x', 'cancelled', 'thr_1'],
      ['run_y', 'succeeded', null],
    ] as const) {
      await t.bus.publish({ type: 'run.updated', run_id: id, status: 'running', thread_id: thread });
      t.advance(LONG_RUN_MS * 2);
      await t.bus.publish({ type: 'run.updated', run_id: id, status, thread_id: thread });
    }
    await t.settle();
    expect((await t.host.poll(0)).notifications).toEqual([]);
  });

  it('carries a notice in a category set to Desktop, and leaves approvals and runs to their own paths', async () => {
    const t = setup();
    await t.bus.publish({
      type: 'notification',
      id: 'n1',
      level: 'success',
      title: 'Paper.pdf is ready',
      category: 'sources',
      action: { label: 'Open', href: '/n/nb1' },
    });
    await t.bus.publish({
      type: 'notification',
      id: 'n2',
      level: 'info',
      title: 'Waiting',
      category: 'approvals',
    });
    await t.bus.publish({ type: 'notification', id: 'n3', level: 'info', title: 'No category' });
    await t.settle();
    const { notifications } = await t.host.poll(0);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ id: 'notice:n1', title: 'Paper.pdf is ready', href: '/n/nb1' });
  });
});

describe('Pro buttons on a notification', () => {
  const pro = (calls: string[]): ProDesktop => ({
    notificationActions: async (a) =>
      a.tier === 'critical'
        ? []
        : [
            { id: 'approve', label: 'Approve' },
            { id: 'deny', label: 'Deny' },
          ],
    decideFromNotification: async (id, action) => {
      calls.push(`${id}:${action}`);
      return { status: action === 'approve' ? 'approved' : 'denied' };
    },
    keepsJobsInBackground: () => true,
  });

  it('adds Approve and Deny to an ordinary request and none to a critical one', async () => {
    const t = setup({ approvals: [asked('apr_1'), asked('apr_c', 'critical')], pro: pro([]) });
    for (const id of ['apr_1', 'apr_c'])
      await t.bus.publish({
        type: 'approval.requested',
        approval_id: id,
        run_id: 'r',
        tool: 'fs.write',
        tier: 'gated',
      });
    await t.settle();
    const { notifications } = await t.host.poll(0);
    expect(notifications.find((n) => n.approval_id === 'apr_1')?.actions.map((a) => a.id)).toEqual([
      'approve',
      'deny',
    ]);
    expect(notifications.find((n) => n.approval_id === 'apr_c')?.actions).toEqual([]);
  });

  it('is refused in the free build, and never lets a critical request through even from Pro', async () => {
    const free = setup({ approvals: [asked('apr_1')] });
    await expect(free.host.approvalAction('apr_1', 'approve')).rejects.toMatchObject({
      code: 'pro.feature_required',
    });
    const calls: string[] = [];
    const t = setup({ approvals: [asked('apr_c', 'critical'), asked('apr_1')], pro: pro(calls) });
    await expect(t.host.approvalAction('apr_c', 'approve')).rejects.toMatchObject({
      code: 'desktop.critical_in_app',
    });
    await expect(t.host.approvalAction('missing', 'approve')).rejects.toMatchObject({
      code: 'request.not_found',
    });
    expect(await t.host.approvalAction('apr_1', 'deny')).toEqual({ status: 'denied' });
    expect(calls).toEqual(['apr_1:deny']);
  });

  it('holds your own schedules while hidden, unless Pro keeps them going', () => {
    const free = setup();
    expect(free.host.holdsSchedules()).toBe(false);
    free.host.report({ visible: false, focused: false });
    expect(free.host.holdsSchedules()).toBe(true);
    free.host.report({ visible: true, focused: true });
    expect(free.host.holdsSchedules()).toBe(false);
    const p = setup({ pro: pro([]) });
    p.host.report({ visible: false, focused: false });
    expect(p.host.holdsSchedules()).toBe(false);
  });
});

describe('the shell polls', () => {
  it('gets only what is new, and starts again when Core restarted behind its cursor', async () => {
    const t = setup({ approvals: [asked('apr_1'), asked('apr_2')], running: 2 });
    await t.bus.publish({
      type: 'approval.requested',
      approval_id: 'apr_1',
      run_id: 'r',
      tool: 't',
      tier: 'gated',
    });
    await t.settle();
    const first = await t.host.poll(0);
    await t.bus.publish({
      type: 'approval.requested',
      approval_id: 'apr_2',
      run_id: 'r',
      tool: 't',
      tier: 'gated',
    });
    await t.settle();
    const second = await t.host.poll(first.seq);
    expect(second.notifications.map((n) => n.id)).toEqual(['approval:apr_2']);
    expect(second).toMatchObject({ approvals: 2, runs: 2, close: 'ask', background: false });
    // The shell remembers a cursor from before Core restarted: everything is new again.
    expect((await t.host.poll(9999)).notifications).toHaveLength(2);
  });

  it('queues commands from the Cockpit for the shell', async () => {
    const t = setup();
    t.host.command('update.tonight');
    t.host.command('quit');
    const p = await t.host.poll(0);
    expect(p.commands.map((c) => c.command)).toEqual(['update.tonight', 'quit']);
    expect((await t.host.poll(p.seq)).commands).toEqual([]);
  });

  it('remembers the close choice from either side', async () => {
    const t = setup();
    const pub = desktopRoutes(t.host);
    const internal = desktopInternalRoutes(t.host);
    pub.onError(errorHandler);
    expect(await (await pub.request('/system/desktop')).json()).toMatchObject({
      close: 'ask',
      hidden: false,
      pro: false,
    });
    const put = await pub.request('/system/desktop', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ close: 'tray' }),
    });
    expect(put.status).toBe(200);
    expect((await t.host.poll(0)).close).toBe('tray');
    await internal.request('/desktop/close', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ close: 'quit' }),
    });
    expect((await t.host.poll(0)).close).toBe('quit');
    const bad = await pub.request('/system/desktop', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ close: 'sometimes' }),
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });

  it('keeps what the last update changed, for the one-time sheet', async () => {
    const t = setup();
    await t.host.updated({
      from: '0.1.0',
      to: '0.1.1',
      notes: 'Closing the window keeps NVX Ancile running.',
    });
    expect(await t.host.lastUpdate()).toMatchObject({ from: '0.1.0', to: '0.1.1' });
    expect((await t.host.state()).last_update?.notes).toContain('keeps NVX Ancile running');
  });
});
