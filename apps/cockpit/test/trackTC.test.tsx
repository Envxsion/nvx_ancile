/**
 * ------------------------------------------------------------------
 *  Title    |  Feel, navigation and source tags
 *  Ref      |  ROADMAP TC1, TC2, NV2, S6
 *  ID       |  cockpit/test
 * ------------------------------------------------------------------
 *  Purpose  |  TC1: scrolled up while an answer arrives, a "New text
 *           |  below" pill appears once, announced politely, and
 *           |  catches up smoothly (or at once with reduced motion).
 *           |  TC2: one press token and shade for rows, cards, chips
 *           |  and menu items, with no size change, flat under
 *           |  reduced motion, and never on a disabled item. NV2:
 *           |  Settings has one home; the old addresses redirect.
 *           |  S6: tags are parsed, added and removed in bulk,
 *           |  counted and filtered; the details dialog sends only
 *           |  what changed; a failed source in a bulk tag is named.
 * ------------------------------------------------------------------
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { api } from '../src/lib/api';
import { saveSourceDetails, tagSources } from '../src/lib/notebooks';
import { queryClient } from '../src/lib/query';
import { useRuns } from '../src/lib/run';
import { createAppRouter } from '../src/router';
import { SourceDetails } from '../src/sources/SourceDetails';
import { editTags, hasTag, parseTags, tagCounts } from '../src/sources/tags';
import { useNotify } from '../src/state/notify';
import { AT_END_PX, gapBelow, NewTextPill, streamedSize } from '../src/thread/NewTextPill';
import { APERTURE, read, STYLES } from './tokenCss';

const patch = vi.mocked(api.patch);

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
  useRuns.setState({ turns: {} });
  delete document.documentElement.dataset.motion;
});

/* ---- TC1 ----------------------------------------------------------------- */

describe('New text below (TC1)', () => {
  function scrollerAt(gap: number) {
    const el = document.createElement('div');
    let top = 1000 - gap - 600;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 600 });
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v) => (top = v) });
    el.scrollTo = vi.fn();
    return { el, scrollBy: (g: number) => (top = 1000 - g - 600) };
  }
  const turn = (text: string) => ({
    m1: {
      runId: 'r',
      threadId: 't',
      messageId: 'm1',
      parts: [{ type: 'text', text }],
      status: 'running',
    } as never,
  });

  function mount(gap: number) {
    const s = scrollerAt(gap);
    const ref = createRef<HTMLElement>() as { current: HTMLElement | null };
    ref.current = s.el;
    const following = { current: gap < AT_END_PX };
    const ui = (count: number) => (
      <NewTextPill scroller={ref} following={following} lastId="m1" messageCount={count} threadId="t" ready />
    );
    const r = render(ui(2));
    return { ...s, following, rerender: (count = 2) => r.rerender(ui(count)) };
  }

  it('measures how far from the end you are, and what grows while an answer is written', () => {
    expect(gapBelow({ scrollHeight: 1000, scrollTop: 300, clientHeight: 600 })).toBe(100);
    expect(streamedSize(undefined)).toBe(0);
    expect(streamedSize([{ type: 'text', text: 'abcd' }, { type: 'tool_call' }])).toBe(5);
  });

  it('shows nothing at the end of the thread, however fast text arrives', () => {
    const m = mount(0);
    act(() => useRuns.setState({ turns: turn('hello') }));
    act(() => useRuns.setState({ turns: turn('hello there, this keeps coming') }));
    expect(screen.queryByRole('button', { name: /New text below/ })).toBeNull();
    expect(m.following.current).toBe(true);
  });

  it('shows once when you are scrolled up and more arrives, announces it politely, and does not flicker', () => {
    const m = mount(0);
    act(() => useRuns.setState({ turns: turn('first') }));
    m.scrollBy(400);
    act(() => {
      m.el.dispatchEvent(new Event('scroll'));
    });
    // Nothing new since you scrolled away: no pill.
    expect(screen.queryByRole('button', { name: /New text below/ })).toBeNull();

    act(() => useRuns.setState({ turns: turn('first and more') }));
    const pill = screen.getByRole('button', { name: /New text below/ });
    expect(pill).toBeInTheDocument();
    expect(pill.querySelector('.live-dot')).not.toBeNull();
    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('New text below.');

    // A fast stream: many more tokens change nothing about the pill or what is announced.
    for (let i = 0; i < 20; i++)
      act(() => useRuns.setState({ turns: turn(`first and more ${'x'.repeat(i)}`) }));
    expect(screen.getAllByRole('button', { name: /New text below/ })).toHaveLength(1);
    expect(live).toHaveTextContent('New text below.');
  });

  it('a new message counts too, and a step opening (no new text) does not', () => {
    const m = mount(0);
    act(() => useRuns.setState({ turns: turn('same') }));
    m.scrollBy(400);
    act(() => {
      m.el.dispatchEvent(new Event('scroll'));
    });
    // The same text, a step expanding: size is unchanged, so no pill.
    act(() => useRuns.setState({ turns: turn('same') }));
    expect(screen.queryByRole('button', { name: /New text below/ })).toBeNull();
    m.rerender(3);
    expect(screen.getByRole('button', { name: /New text below/ })).toBeInTheDocument();
  });

  it('catches up smoothly, and at once when motion is reduced; reaching the end hides it', () => {
    const m = mount(0);
    m.scrollBy(400);
    act(() => {
      m.el.dispatchEvent(new Event('scroll'));
    });
    act(() => useRuns.setState({ turns: turn('more') }));
    fireEvent.click(screen.getByRole('button', { name: /New text below/ }));
    expect(m.el.scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: 'smooth' });
    expect(m.following.current).toBe(true);

    document.documentElement.dataset.motion = 'reduced';
    fireEvent.click(screen.getByRole('button', { name: /New text below/ }));
    expect(m.el.scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: 'auto' });

    m.scrollBy(0);
    act(() => {
      m.el.dispatchEvent(new Event('scroll'));
    });
    expect(screen.queryByRole('button', { name: /New text below/ })).toBeNull();
  });
});

/* ---- TC2 ----------------------------------------------------------------- */

describe('One press feedback (TC2)', () => {
  const press = read(`${STYLES}press.css`);
  const tokens = read(`${APERTURE}tokens.css`);
  const prefs = read(`${APERTURE}prefs.css`);

  it('rows, cards, chips and menu items share one rule: the press token and the shade', () => {
    for (const sel of [
      '.rail__item',
      '.chip',
      '.artifact-card',
      '.cc-card',
      '.menu__item',
      "[role='option']",
      "[role='menuitem']",
    ])
      expect(press).toContain(sel);
    expect(press).toContain('transform: scale(var(--press-soft))');
    expect(press).toContain('var(--press-shade)');
  });

  it('changes no size or position: only a transform and a background layer', () => {
    const active = press.slice(press.indexOf('):active'), press.indexOf('}', press.indexOf('):active')));
    for (const prop of [
      'width',
      'height',
      'margin',
      'padding',
      'border',
      'top',
      'left',
      'position',
      'display',
    ])
      expect(active, prop).not.toMatch(new RegExp(`(^|[\\s;{])${prop}\\s*:`));
  });

  it('leaves disabled items alone, and has no literal colours', () => {
    expect(press).toContain(':not(:disabled)');
    expect(press).toContain("[aria-disabled='true']");
    expect(press).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  });

  it('the token exists, is gentler than a button, and goes flat under reduced motion (the shade stays)', () => {
    expect(tokens).toMatch(/--press-soft:\s*0\.985/);
    expect(tokens).toMatch(/--press-shade:\s*color-mix/);
    const reduced = prefs.slice(prefs.indexOf("[data-motion='reduced']"));
    expect(reduced).toMatch(/--press-soft:\s*1;/);
    expect(prefs).not.toMatch(/--press-shade:\s*none/);
    expect(prefs.match(/--press-soft:\s*1;/g)?.length).toBe(2);
  });
});

/* ---- NV2 ----------------------------------------------------------------- */

describe('One home for each place (NV2)', () => {
  async function landing(path: string) {
    const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
    await router.load();
    return router.state.location.pathname;
  }

  it('old addresses still land where the place now lives', async () => {
    expect(await landing('/settings/models')).toBe('/admin/models');
    expect(await landing('/automations')).toBe('/admin/automations');
    expect(await landing('/admin/grants')).toBe('/admin/permissions');
  });

  it('Settings itself is still at the same address', async () => {
    expect(await landing('/settings')).toBe('/settings/appearance');
    expect(await landing('/settings/keyboard')).toBe('/settings/keyboard');
  });

  it('the top bar has no Settings button; the sidebar foot keeps it', () => {
    const bar = read('../src/shell/Titlebar.tsx');
    expect(bar).not.toMatch(/aria-label="Settings"/);
    expect(bar).not.toMatch(/data-tour="settings"/);
    const rail = read('../src/shell/Rail.tsx');
    expect(rail).toMatch(/aria-label="Settings"/);
    // The guide has one home too: the top bar, not also the sidebar foot.
    expect(rail).not.toMatch(/aria-label="Help"/);
  });
});

/* ---- S6 ------------------------------------------------------------------ */

describe('Source tags (S6)', () => {
  const src = (id: string, tags: string[]) => ({ id, title: `Source ${id}`, tags });

  it('reads tags as typed: trimmed, no blanks, no repeats in any case, at most 40 of 60 characters', () => {
    expect(parseTags('energy, Sea ,\n ,energy,SEA, tides')).toEqual(['energy', 'Sea', 'tides']);
    expect(parseTags('x'.repeat(80))[0]).toHaveLength(60);
    expect(parseTags(Array.from({ length: 60 }, (_, i) => `t${i}`).join(','))).toHaveLength(40);
  });

  it('adds and removes in bulk, matching without regard to case', () => {
    expect(editTags(['a', 'B'], ['c', 'b'], [])).toEqual(['a', 'B', 'c']);
    expect(editTags(['a', 'B', 'c'], [], ['b', 'C'])).toEqual(['a']);
    expect(editTags(['a'], ['z'], ['z'])).toEqual(['a']);
  });

  it('counts tags, most used first, and filters by one', () => {
    const list = [src('1', ['sea', 'Energy']), src('2', ['energy']), src('3', [])];
    expect(tagCounts(list)).toEqual([
      { tag: 'Energy', count: 2 },
      { tag: 'sea', count: 1 },
    ]);
    expect(list.filter((s) => hasTag(s, 'ENERGY')).map((s) => s.id)).toEqual(['1', '2']);
  });

  it('bulk tagging saves each source on its own and names the ones that failed', async () => {
    patch.mockReset();
    useNotify.setState({ toasts: [], history: [] });
    patch.mockImplementation(async (path: string) => {
      if (path.endsWith('/s2')) throw new Error('gone');
      return {} as never;
    });
    const r = await tagSources(
      [src('s1', ['a']), src('s2', ['a']), src('s3', ['tide'])],
      ['tide', 'sea'],
      ['a'],
    );
    expect(r).toEqual({ done: 2, failed: ['Source s2'] });
    expect(patch).toHaveBeenCalledWith('/sources/s1', { tags: ['tide', 'sea'] });
    expect(patch).toHaveBeenCalledWith('/sources/s3', { tags: ['tide', 'sea'] });
    const t = useNotify.getState().toasts.at(-1);
    expect(t?.title).toBe('Tags added tide, sea and removed a on 2 sources');
    expect(t?.level).toBe('warn');
    expect(t?.body).toContain('Source s2');
  });

  it('saving details rolls the lists back and says so when Core refuses', async () => {
    patch.mockReset();
    useNotify.setState({ toasts: [], history: [] });
    queryClient.setQueryData(['sources', 'nb'], [{ id: 's1', title: 'S', tags: ['a'], author: null }]);
    patch.mockRejectedValue(new Error('offline'));
    const ok = await saveSourceDetails('s1', { tags: ['a', 'b'], author: 'Ada' });
    expect(ok).toBe(false);
    expect(queryClient.getQueryData<{ tags: string[] }[]>(['sources', 'nb'])?.[0]?.tags).toEqual(['a']);
    expect(useNotify.getState().toasts.at(-1)?.level).toBe('error');
  });

  it('the details dialog sends only what changed, and clears with null', async () => {
    patch.mockReset();
    patch.mockResolvedValue({} as never);
    const s = {
      id: 's1',
      title: 'Tides',
      kind: 'text' as const,
      status: 'ready' as const,
      detail: '',
      contextLevel: 'full' as const,
      tags: ['sea'],
      author: 'Old Author',
      publishedOn: '2024-05-01',
      language: 'en',
    };
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <SourceDetails s={s} onClose={onClose} />
      </QueryClientProvider>,
    );
    // Nothing changed: Save just closes.
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(patch).not.toHaveBeenCalled();

    onClose.mockClear();
    fireEvent.change(screen.getByLabelText('Author'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Date published'), { target: { value: '2025-03-04' } });
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'fr' } });
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'energy' } });
    fireEvent.keyDown(screen.getByLabelText('Tags'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag sea' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(patch).toHaveBeenCalledWith('/sources/s1', {
      tags: ['energy'],
      author: null,
      published_on: '2025-03-04',
      language: 'fr',
    });
  });
});
