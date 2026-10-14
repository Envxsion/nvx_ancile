/**
 * X1: custom CSS stays on this device (never sent to Core, never taken
 * from its copy or from a file), is confirmed the first time it is
 * applied here, says so with a chip, and never reaches a permission
 * request: those render in the protected layer, with the CSS off and a
 * visibility check that pauses the answers while anything covers them.
 */
import {
  DEFAULT_PREFERENCES,
  isDevicePref,
  keepDevicePrefs,
  type Preferences,
  withoutDevicePrefs,
} from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({
    children,
    to: _to,
    params: _p,
    ...rest
  }: {
    children: ReactNode;
    to: string;
    params?: unknown;
  }) => (
    <a href="#link" {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { hiddenReason, protectedLayer, useProtect, useProtected } from '../src/app/protected';
import { applyUserCss, USER_CSS_ID, userCssOn } from '../src/app/userCss';
import { ApprovalDialog } from '../src/approvals/ApprovalDialog';
import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import type { PendingApproval } from '../src/lib/types';
import { CustomCssBlock } from '../src/routes/settings/CustomCss';
import { CustomCssChip } from '../src/shell/StatusBar';
import { adoptRemotePrefs, usePrefs } from '../src/state/prefs';
import { useUi } from '../src/state/ui';

const mocked = api as unknown as Record<'get' | 'post' | 'put', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

const withCss = (css: string, extra: Partial<Preferences['advanced']> = {}): Preferences => ({
  ...DEFAULT_PREFERENCES,
  appearance: { ...DEFAULT_PREFERENCES.appearance, zoom: 1.2, theme: 'dark' },
  advanced: { ...DEFAULT_PREFERENCES.advanced, css, ...extra },
});

beforeEach(() => {
  mocked.get.mockReset().mockResolvedValue({ value: null });
  mocked.put.mockReset().mockResolvedValue({});
  mocked.post.mockReset();
  usePrefs.setState({ prefs: DEFAULT_PREFERENCES, changedAt: 0, cssConsent: false });
  useProtected.setState({ open: 0 });
  document.getElementById(USER_CSS_ID)?.remove();
});
afterEach(() => {
  vi.useRealTimers();
  queryClient.clear();
});

describe('device-only preferences', () => {
  it('names the settings that belong to a device', () => {
    expect(isDevicePref('advanced', 'css')).toBe(true);
    expect(isDevicePref('appearance', 'zoom')).toBe(true);
    expect(isDevicePref('layout', 'railWidth')).toBe(true);
    expect(isDevicePref('appearance', 'theme')).toBe(false);
    expect(isDevicePref('nope', 'css')).toBe(false);
  });

  it('takes them out of what may leave the device, and leaves the rest alone', () => {
    const out = withoutDevicePrefs(withCss('body { color: red }', { performance: 'lite' }));
    expect(out.advanced).not.toHaveProperty('css');
    expect(out.advanced).not.toHaveProperty('performance');
    expect(out.appearance).not.toHaveProperty('zoom');
    expect(out.appearance.theme).toBe('dark');
    expect(out.advanced.hints).toBe(true);
    // Anything else passes through untouched.
    expect(withoutDevicePrefs(null)).toBeNull();
    expect(withoutDevicePrefs('x')).toBe('x');
  });

  it('keeps this device’s own when settings come from elsewhere', () => {
    const local = withCss('', { performance: 'full' });
    const incoming = withCss('.approval { display: none }', { performance: 'lite' });
    incoming.appearance = { ...incoming.appearance, zoom: 0.8, theme: 'light' };
    const merged = keepDevicePrefs(incoming, local);
    expect(merged.advanced.css).toBe('');
    expect(merged.advanced.performance).toBe('full');
    expect(merged.appearance.zoom).toBe(1.2);
    // What is not device-only does come across.
    expect(merged.appearance.theme).toBe('light');
  });

  it('never sends custom CSS to Core', async () => {
    vi.useFakeTimers();
    usePrefs.getState().set('advanced', { css: 'body { color: red }' });
    await vi.advanceTimersByTimeAsync(900);
    expect(mocked.put).toHaveBeenCalledTimes(1);
    const body = mocked.put.mock.calls[0]?.[1] as { value: { prefs: Preferences } };
    expect(body.value.prefs.advanced).not.toHaveProperty('css');
    expect(body.value.prefs.appearance).not.toHaveProperty('zoom');
    expect(body.value.prefs.appearance.theme).toBe('system');
  });

  it('takes a newer copy from Core but never its CSS, and ignores an older one', () => {
    usePrefs.setState({ prefs: withCss('mine'), changedAt: 100 });
    const remote = withCss('.approval { opacity: 0 }');
    remote.appearance = { ...remote.appearance, theme: 'light', zoom: 1.4 };
    expect(adoptRemotePrefs({ prefs: remote, changedAt: 50 })).toBe(false);
    expect(adoptRemotePrefs({ prefs: remote, changedAt: 200 })).toBe(true);
    const now = usePrefs.getState().prefs;
    expect(now.appearance.theme).toBe('light');
    expect(now.advanced.css).toBe('mine');
    expect(now.appearance.zoom).toBe(1.2);
    expect(adoptRemotePrefs(null)).toBe(false);
    expect(adoptRemotePrefs({ prefs: 'garbage', changedAt: 999 })).toBe(false);
  });
});

describe('applying custom CSS', () => {
  const el = () => document.getElementById(USER_CSS_ID) as HTMLStyleElement | null;

  it('is not applied until confirmed on this device', () => {
    expect(applyUserCss({ css: 'a{}', consent: false, safe: false, suspended: false })).toBe(false);
    expect(el()).toBeNull();
    expect(applyUserCss({ css: 'a{}', consent: true, safe: false, suspended: false })).toBe(true);
    expect(el()?.textContent).toBe('a{}');
    expect(el()?.dataset.suspended).toBeUndefined();
  });

  it('is switched off while a permission request is open, the saved CSS untouched', () => {
    usePrefs.setState({ prefs: withCss('a{}'), cssConsent: true });
    applyUserCss({ css: 'a{}', consent: true, safe: false, suspended: false });
    expect(applyUserCss({ css: 'a{}', consent: true, safe: false, suspended: true })).toBe(false);
    expect(el()?.textContent).toBe('');
    expect(el()?.dataset.suspended).toBe('');
    expect(usePrefs.getState().prefs.advanced.css).toBe('a{}');
    applyUserCss({ css: 'a{}', consent: true, safe: false, suspended: false });
    expect(el()?.textContent).toBe('a{}');
  });

  it('?safe=1 or empty CSS removes it', () => {
    applyUserCss({ css: 'a{}', consent: true, safe: false, suspended: false });
    applyUserCss({ css: 'a{}', consent: true, safe: true, suspended: false });
    expect(el()).toBeNull();
    applyUserCss({ css: 'a{}', consent: true, safe: false, suspended: false });
    applyUserCss({ css: '   ', consent: true, safe: false, suspended: false });
    expect(el()).toBeNull();
    expect(userCssOn({ css: ' ', consent: true, safe: false })).toBe(false);
  });

  it('a protected surface counts itself open while mounted', () => {
    function Probe({ on }: { on: boolean }) {
      useProtect(on);
      return null;
    }
    const { rerender, unmount } = render(<Probe on />);
    expect(useProtected.getState().open).toBe(1);
    rerender(<Probe on={false} />);
    expect(useProtected.getState().open).toBe(0);
    rerender(<Probe on />);
    unmount();
    expect(useProtected.getState().open).toBe(0);
  });
});

describe('the first time CSS is applied', () => {
  it('asks first, then applies and remembers the yes on this device', () => {
    wrap(<CustomCssBlock />);
    fireEvent.change(screen.getByLabelText('Custom CSS'), { target: { value: 'body { color: red }' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByText('Apply custom CSS on this device?')).toBeInTheDocument();
    expect(usePrefs.getState().prefs.advanced.css).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Apply CSS' }));
    expect(usePrefs.getState().prefs.advanced.css).toBe('body { color: red }');
    expect(usePrefs.getState().cssConsent).toBe(true);
  });

  it('once confirmed, changes apply without asking; clearing never asks', () => {
    usePrefs.setState({ prefs: withCss('a{}'), cssConsent: true });
    wrap(<CustomCssBlock />);
    fireEvent.change(screen.getByLabelText('Custom CSS'), { target: { value: 'b{}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.queryByText('Apply custom CSS on this device?')).toBeNull();
    expect(usePrefs.getState().prefs.advanced.css).toBe('b{}');
    usePrefs.setState({ cssConsent: false });
    fireEvent.change(screen.getByLabelText('Custom CSS'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.queryByText('Apply custom CSS on this device?')).toBeNull();
    expect(usePrefs.getState().prefs.advanced.css).toBe('');
  });

  it('CSS saved before but never confirmed here waits, and says so', () => {
    usePrefs.setState({ prefs: withCss('a{}'), cssConsent: false });
    wrap(<CustomCssBlock />);
    expect(
      screen.getByText('Saved but not applied on this device yet. Apply it to confirm.'),
    ).toBeInTheDocument();
    // Apply is offered even though nothing was typed.
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByText('Apply custom CSS on this device?')).toBeInTheDocument();
  });
});

describe('the Custom CSS on chip', () => {
  it('shows only while this device’s CSS is in force', () => {
    usePrefs.setState({ prefs: withCss('a{}'), cssConsent: false });
    const { rerender } = wrap(<CustomCssChip />);
    expect(screen.queryByText('Custom CSS on')).toBeNull();
    act(() => usePrefs.setState({ cssConsent: true }));
    rerender(
      <QueryClientProvider client={queryClient}>
        <Tooltip.Provider>
          <CustomCssChip />
        </Tooltip.Provider>
      </QueryClientProvider>,
    );
    expect(screen.getByText('Custom CSS on')).toBeInTheDocument();
  });
});

describe('the protected layer', () => {
  const approval: PendingApproval = {
    id: 'apr_1',
    runId: 'run_1',
    threadId: 'thr_1',
    tool: 'fs_write',
    action: 'fs.write',
    resource: 'fs:/workspace/a.md',
    tier: 'gated',
    argsPreview: 'path: a.md',
    suggestions: ['fs:/workspace/a.md'],
    reason: 'The agent wants to write a file.',
  };

  it('renders a permission request there, with the custom CSS off while it is open', () => {
    mocked.get.mockResolvedValue([]);
    usePrefs.setState({ prefs: withCss('.approval { display: none }'), cssConsent: true });
    applyUserCss({ css: '.approval { display: none }', consent: true, safe: false, suspended: false });
    useUi.setState({ approvalOpen: true, approvalFocus: 'apr_1', demo: false });
    const { unmount } = wrap(<ApprovalDialog approval={approval} />);
    const dialog = document.querySelector('.approval') as HTMLElement;
    expect(protectedLayer().contains(dialog)).toBe(true);
    expect(useProtected.getState().open).toBe(1);
    // What Runtime does with that: the CSS stays saved but stops applying.
    const suspended = useProtected.getState().open > 0;
    applyUserCss({ css: '.approval { display: none }', consent: true, safe: false, suspended });
    expect(document.getElementById(USER_CSS_ID)?.textContent).toBe('');
    // Seen again, as a person would see it.
    expect(screen.getByRole('dialog')).toBe(dialog);
    unmount();
    expect(useProtected.getState().open).toBe(0);
  });

  const box = (r: Partial<DOMRect>) => () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
      ...r,
    }) as DOMRect;
  const env = (hit: (x: number, y: number) => Element | null) => ({
    innerWidth: 1200,
    innerHeight: 800,
    elementFromPoint: hit,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  });
  const setup = () => {
    const el = document.createElement('div');
    const btn = document.createElement('button');
    btn.dataset.protectedAction = '';
    el.appendChild(btn);
    document.body.appendChild(el);
    el.getBoundingClientRect = box({ top: 100, left: 300, right: 860, bottom: 500, width: 560, height: 400 });
    btn.getBoundingClientRect = box({ top: 450, left: 700, right: 800, bottom: 480, width: 100, height: 30 });
    return { el, btn };
  };

  it('finds a request that can be seen and used', () => {
    const { el, btn } = setup();
    expect(
      hiddenReason(
        el,
        env(() => btn),
      ),
    ).toBeNull();
  });

  it('finds one that is covered, off screen, too small or hidden', () => {
    const { el } = setup();
    const cover = document.createElement('div');
    expect(
      hiddenReason(
        el,
        env(() => cover),
      ),
    ).toBe('covered');
    el.getBoundingClientRect = box({
      top: 900,
      left: 300,
      right: 860,
      bottom: 1300,
      width: 560,
      height: 400,
    });
    expect(
      hiddenReason(
        el,
        env(() => null),
      ),
    ).toBe('off_screen');
    el.getBoundingClientRect = box({ top: 100, left: 300, right: 310, bottom: 110, width: 10, height: 10 });
    expect(
      hiddenReason(
        el,
        env(() => null),
      ),
    ).toBe('too_small');
    const hidden = {
      ...env(() => null),
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '0' }),
    };
    expect(hiddenReason(el, hidden)).toBe('hidden');
    (el as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility = () => false;
    expect(
      hiddenReason(
        el,
        env(() => null),
      ),
    ).toBe('hidden');
  });

  it('cannot measure without a layout, and then does not block', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    expect(
      hiddenReason(el, {
        innerWidth: 0,
        innerHeight: 0,
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
      }),
    ).toBeNull();
  });
});
