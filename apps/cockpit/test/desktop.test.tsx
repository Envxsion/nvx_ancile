/**
 * The desktop app, seen from the Cockpit (rows DK1, NT1, DL1, UP1): what
 * closing the window does is a setting in Core, the update card offers
 * three ways to install and never installs by itself, a link only opens a
 * place, "Desktop" notifications pop up here and reach the browser too,
 * and a thread's link is ancile://thread/<id> inside the app.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.fn();
let params: Record<string, string> = {};
let search: Record<string, string> = {};
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => nav,
  useParams: () => params,
  useSearch: () => search,
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { CLOSE_WORDS, offerLine, sizeText, threadLink, tonightText } from '../src/desktop/api';
import { DesktopGroup } from '../src/desktop/DesktopGroup';
import { addToDraft, OpenApprovalScreen, OpenFlowRunScreen, OpenNewScreen } from '../src/desktop/OpenScreens';
import { shouldShow } from '../src/desktop/WhatChanged';
import { LONG_RUN_MS, webNotifyEvent, webNotifyNotice } from '../src/desktop/webNotify';
import { ApiCallError, api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { routeOf } from '../src/state/notify';
import { usePrefs } from '../src/state/prefs';
import { useUi } from '../src/state/ui';
import { draftKey } from '../src/thread/Composer';

const mocked = api as unknown as Record<'get' | 'post' | 'put', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

const setDesktop = (on: boolean) => {
  (window as unknown as { __NVX_DESKTOP__?: unknown }).__NVX_DESKTOP__ = on
    ? { version: '0.1.1' }
    : undefined;
};

const offer = (over: Record<string, unknown> = {}) => ({
  version: '0.1.2',
  edition: 'free',
  kind: 'update',
  older: false,
  found_at: '2026-10-19T09:00:00Z',
  notes: null,
  size_bytes: null,
  state: 'available',
  progress: null,
  when: 'none',
  scheduled_for: null,
  error: null,
  previous_version: null,
  ...over,
});

function serve(
  opts: {
    close?: string;
    offer?: ReturnType<typeof offer> | null;
    pro?: boolean;
    last?: { from: string; to: string; notes: string | null; at: string } | null;
  } = {},
) {
  mocked.get.mockImplementation(async (path: string) => {
    if (path === '/system/desktop')
      return {
        close: opts.close ?? 'ask',
        hidden: false,
        warming: [],
        last_update: opts.last ?? null,
        pro: !!opts.pro,
      };
    if (path === '/system/update-offer') return { offer: opts.offer ?? null };
    if (path === '/system/updates') return { channel: 'stable', beta_available: !!opts.pro };
    if (path === '/license/details')
      return {
        status: {
          tier: opts.pro ? 'pro' : 'free',
          features: [],
          verified: false,
          offline_grace: false,
          expires_at: null,
          lapse: null,
        },
        build: opts.pro ? 'pro' : 'free',
        device_id: 'dev',
        key_held: false,
        checked_at: null,
        problem: null,
        features: [{ id: 'desktop', title: 'Desktop extras', body: '', unlocked: !!opts.pro }],
      };
    throw new Error(`unexpected GET ${path}`);
  });
  mocked.put.mockResolvedValue({});
  mocked.post.mockResolvedValue({});
}

beforeEach(() => {
  queryClient.clear();
  for (const m of Object.values(mocked)) m.mockReset();
  nav.mockReset();
  params = {};
  search = {};
  setDesktop(true);
  try {
    localStorage.clear();
  } catch {
    /* no storage in this environment */
  }
});
afterEach(() => {
  setDesktop(false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the words', () => {
  it('names sizes, progress and what was chosen', () => {
    expect(sizeText(null)).toBe('');
    expect(sizeText(500 * 1024)).toBe('500 KB');
    expect(sizeText(48.2 * 1024 * 1024)).toBe('48.2 MB');
    expect(sizeText(1.5 * 1024 ** 3)).toBe('1.5 GB');
    const o = offer() as never;
    expect(offerLine({ ...(o as object), size_bytes: 10 * 1024 * 1024 } as never)).toBe(
      '0.1.2 is ready (10.0 MB)',
    );
    expect(offerLine({ ...(o as object), state: 'downloading', progress: 0.42 } as never)).toBe(
      'Downloading 0.1.2, 42%',
    );
    expect(offerLine({ ...(o as object), state: 'ready', when: 'quit' } as never)).toBe(
      '0.1.2 is downloaded and installs when you quit',
    );
    expect(offerLine({ ...(o as object), state: 'waiting' } as never)).toBe(
      '0.1.2 installs when your runs have finished',
    );
    expect(
      offerLine({ ...(o as object), state: 'failed', error: 'The download did not finish.' } as never),
    ).toBe('The download did not finish.');
    expect(tonightText(null)).toBe('tonight');
    expect(tonightText('not a date')).toBe('tonight');
    expect(CLOSE_WORDS.tray).toBe('Keep running in the tray');
  });

  it('copies ancile://thread/<id> in the desktop app and the page address in a browser', () => {
    expect(threadLink('thr_1', 'http://127.0.0.1:17700')).toBe('ancile://thread/thr_1');
    setDesktop(false);
    expect(threadLink('thr_1', 'http://localhost:5173')).toBe('http://localhost:5173/t/thr_1');
  });
});

describe('Settings → Desktop', () => {
  it('shows what closing does, and changing it is a request to Core', async () => {
    serve({ close: 'tray' });
    wrap(<DesktopGroup />);
    const keep = await screen.findByRole('radio', { name: 'Keep running in the tray' });
    await waitFor(() => expect(keep).toBeChecked());
    fireEvent.click(screen.getByRole('radio', { name: 'Quit' }));
    await waitFor(() => expect(mocked.put).toHaveBeenCalledWith('/system/desktop', { close: 'quit' }));
  });

  it('says it is up to date and offers a check when nothing is on offer', async () => {
    serve();
    wrap(<DesktopGroup />);
    expect(await screen.findByText(/is up to date/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/system/desktop/command', { command: 'update.check' }),
    );
  });

  it('offers Restart now, When I quit and Tonight, and nothing installs until one is pressed', async () => {
    serve({
      offer: offer({ notes: 'Closing the window keeps NVX Ancile running.', size_bytes: 40 * 1024 * 1024 }),
    });
    wrap(<DesktopGroup />);
    expect(await screen.findByText(/NVX Ancile 0\.1\.2/)).toBeInTheDocument();
    expect(screen.getByText(/Download size 40\.0 MB/)).toBeInTheDocument();
    expect(mocked.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'What changed' }));
    expect(screen.getByText('Closing the window keeps NVX Ancile running.')).toBeInTheDocument();
    for (const [name, command] of [
      ['Restart now', 'update.restart_now'],
      ['When I quit', 'update.on_quit'],
      ['Tonight', 'update.tonight'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name }));
      await waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/system/desktop/command', { command }));
    }
  });

  it('shows progress while it downloads and what a failure means', async () => {
    serve({ offer: offer({ state: 'downloading', progress: 0.5 }) });
    const { unmount } = wrap(<DesktopGroup />);
    const bar = await screen.findByRole('progressbar', { name: 'Download progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    unmount();
    queryClient.clear();
    serve({
      offer: offer({
        state: 'failed',
        error: 'The download did not finish. Check your connection and try again.',
      }),
    });
    wrap(<DesktopGroup />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The download did not finish');
  });

  it('warns about an older version and says tonight, with a way to cancel', async () => {
    serve({
      offer: offer({ older: true, when: 'tonight', scheduled_for: '2026-10-20T03:00:00Z', state: 'ready' }),
    });
    wrap(<DesktopGroup />);
    expect(await screen.findByText(/older than the version running now/)).toBeInTheDocument();
    expect(screen.getByText(/Installs .* once nothing is running/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/system/desktop/command', { command: 'update.cancel' }),
    );
  });

  it('keeps Beta and Go back for Pro, and says so in the free edition', async () => {
    serve({ last: { from: '0.1.0', to: '0.1.1', notes: null, at: '2026-10-19T00:00:00Z' } });
    wrap(<DesktopGroup />);
    const go = await screen.findByRole('button', { name: /Go back to 0\.1\.0/ });
    await waitFor(() => expect(go).toBeDisabled());
    expect(screen.getByText(/Beta is part of Pro/)).toBeInTheDocument();
  });

  it('lets Pro go back, after a confirm that says the data is backed up first', async () => {
    serve({ pro: true, last: { from: '0.1.0', to: '0.1.1', notes: null, at: '2026-10-19T00:00:00Z' } });
    wrap(<DesktopGroup />);
    const go = await screen.findByRole('button', { name: /Go back to 0\.1\.0/ });
    await waitFor(() => expect(go).toBeEnabled());
    fireEvent.click(go);
    expect(await screen.findByText(/backs up your data/)).toBeInTheDocument();
    expect(mocked.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Back up and go back to 0.1.0' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/system/desktop/command', { command: 'update.go_back' }),
    );
  });
});

describe('the sheet after an update', () => {
  it('opens once for the version running, with notes, and not again', () => {
    const last = { to: '0.1.1', notes: 'Closing the window keeps NVX Ancile running.' };
    expect(shouldShow(last, '0.1.1', null)).toBe(true);
    expect(shouldShow(last, '0.1.1', '0.1.1')).toBe(false);
    expect(shouldShow(last, '0.1.2', null)).toBe(false);
    expect(shouldShow({ to: '0.1.1', notes: '  ' }, '0.1.1', null)).toBe(false);
    expect(shouldShow(null, '0.1.1', null)).toBe(false);
  });
});

describe('where a link lands', () => {
  it('puts the text of a new-message link in the box and sends nothing', async () => {
    search = { text: 'Summarise my notes', notebook: 'nb_1' };
    render(<OpenNewScreen />);
    await waitFor(() =>
      expect(nav).toHaveBeenCalledWith(expect.objectContaining({ to: '/', search: { notebook: 'nb_1' } })),
    );
    expect(localStorage.getItem(draftKey('new', null))).toBe('Summarise my notes');
    expect(mocked.post).not.toHaveBeenCalled();
    expect(mocked.put).not.toHaveBeenCalled();
  });

  it('keeps what was already typed', () => {
    expect(addToDraft('Hello', '')).toBe('Hello');
    expect(addToDraft('New text', 'Half a sentence ')).toBe('Half a sentence\n\nNew text');
    expect(addToDraft('Same', 'Same')).toBe('Same');
  });

  it('opens the approval dialog for a pending request and does not answer it', async () => {
    params = { approvalId: 'apr_1' };
    mocked.get.mockResolvedValue({ id: 'apr_1', thread_id: 'thr_1', status: 'pending' });
    render(
      <QueryClientProvider client={queryClient}>
        <OpenApprovalScreen />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(useUi.getState().approvalOpen).toBe(true));
    expect(useUi.getState().approvalFocus).toBe('apr_1');
    expect(nav).toHaveBeenCalledWith(expect.objectContaining({ to: '/t/$threadId' }));
    expect(mocked.post).not.toHaveBeenCalled();
    useUi.getState().setApproval(false);
  });

  it('says plainly when the request is not here', async () => {
    params = { approvalId: 'apr_gone' };
    mocked.get.mockRejectedValue(
      new ApiCallError(404, {
        error: {
          code: 'request.not_found',
          title: 'That approval was not found',
          hint: '',
          class: 'permanent',
          status: 404,
          context: {},
          trace_id: 't',
        },
      } as never),
    );
    render(
      <QueryClientProvider client={queryClient}>
        <OpenApprovalScreen />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('That request is not here')).toBeInTheDocument();
    expect(mocked.post).not.toHaveBeenCalled();
  });

  it('explains that flow links are Pro in the free edition, and runs nothing', async () => {
    params = { flowId: 'flw_1' };
    serve();
    wrap(<OpenFlowRunScreen />);
    expect(await screen.findByText(/Open the flow instead/)).toBeInTheDocument();
    expect(mocked.post).not.toHaveBeenCalled();
  });
});

describe('Desktop notifications', () => {
  it('pop up in the app like a toast', () => {
    usePrefs.getState().set('notifications', {
      categories: {
        approvals: 'desktop',
        runs: 'desktop',
        sources: 'toast',
        health: 'toast',
        memory: 'centre',
      },
    });
    expect(routeOf({ category: 'approvals' })).toBe('toast');
    expect(routeOf({ category: 'memory' })).toBe('centre');
  });

  it('default to Desktop for approvals and runs, and not for the rest', () => {
    const c = usePrefs.getState().prefs.notifications.categories;
    expect(c.approvals).toBe('desktop');
    expect(c.runs).toBe('desktop');
    expect(c.sources).toBe('toast');
  });
});

describe('browser notifications', () => {
  let shown: { title: string; opts?: NotificationOptions }[];
  beforeEach(() => {
    setDesktop(false);
    shown = [];
    class Fake {
      static permission: NotificationPermission = 'granted';
      constructor(title: string, opts?: NotificationOptions) {
        shown.push({ title, ...(opts && { opts }) });
      }
    }
    vi.stubGlobal('Notification', Fake);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    usePrefs.getState().set('notifications', {
      categories: {
        approvals: 'desktop',
        runs: 'desktop',
        sources: 'desktop',
        health: 'toast',
        memory: 'centre',
      },
    });
  });

  it('notifies for a request that waits while the tab is not in front, with no details', () => {
    webNotifyEvent({
      type: 'approval.requested',
      approval_id: 'apr_1',
      run_id: 'r',
      tool: 'fs.write',
      tier: 'gated',
      seq: 1,
      at: '',
    } as never);
    expect(shown).toEqual([{ title: 'A request needs your go-ahead', opts: { tag: 'approval:apr_1' } }]);
  });

  it('says nothing with the tab in front, in the desktop app, or without permission', () => {
    const ev = {
      type: 'approval.requested',
      approval_id: 'apr_2',
      run_id: 'r',
      tool: 't',
      tier: 'gated',
      seq: 1,
      at: '',
    } as never;
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    webNotifyEvent(ev);
    expect(shown).toEqual([]);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    setDesktop(true);
    webNotifyEvent(ev);
    expect(shown).toEqual([]);
    setDesktop(false);
    (Notification as unknown as { permission: string }).permission = 'denied';
    webNotifyEvent(ev);
    expect(shown).toEqual([]);
  });

  it('notifies for a run only if it took 30 seconds or more', () => {
    const run = (id: string, status: string) =>
      ({ type: 'run.updated', run_id: id, status, thread_id: 'thr_1', seq: 1, at: '' }) as never;
    webNotifyEvent(run('a', 'running'), 0);
    webNotifyEvent(run('a', 'succeeded'), LONG_RUN_MS - 1);
    webNotifyEvent(run('b', 'running'), 0);
    webNotifyEvent(run('b', 'succeeded'), LONG_RUN_MS);
    expect(shown.map((s) => s.opts?.tag)).toEqual(['run:b']);
  });

  it('carries a notice in a category set to Desktop, once per id', () => {
    webNotifyNotice({ id: 'n1', title: 'Paper.pdf is ready', category: 'sources' });
    webNotifyNotice({ id: 'n2', title: 'Health', category: 'health' });
    webNotifyNotice({ id: 'n3', title: 'Waiting', category: 'approvals' });
    expect(shown.map((s) => s.title)).toEqual(['Paper.pdf is ready']);
  });
});
