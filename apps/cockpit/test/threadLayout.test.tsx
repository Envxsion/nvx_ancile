/**
 * The thread's layout: a size container with a centred column and token
 * gutters, a composer bar that fits its width a step at a time (whole
 * labels, short labels, icons), and a key hint that gives way first.
 */
import { act, render, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composerBar, shortModelName, useComposerBar } from '../src/thread/composerBar';
import { BarLabel } from '../src/ui/primitives';
import { read, STYLES, stripComments } from './tokenCss';

const rule = (css: string, sel: string) => {
  const at = css.indexOf(`\n${sel} {`);
  if (at === -1) throw new Error(`no rule ${sel}`);
  return css.slice(at, css.indexOf('}', at));
};

describe('composerBar', () => {
  it('shows everything before it has been measured', () => {
    expect(composerBar(0, 3)).toEqual({ fit: 'full', hint: true });
  });

  it('steps chips down as the width shrinks, and drops the hint first', () => {
    expect(composerBar(1000, 3)).toEqual({ fit: 'full', hint: true });
    expect(composerBar(700, 3)).toEqual({ fit: 'full', hint: false });
    expect(composerBar(560, 3)).toEqual({ fit: 'short', hint: false });
    expect(composerBar(380, 3)).toEqual({ fit: 'icon', hint: false });
  });

  it('never steps back up as the width shrinks', () => {
    const rank = { full: 2, short: 1, icon: 0 } as const;
    for (const chips of [1, 2, 3]) {
      let last = composerBar(1600, chips);
      for (let w = 1600; w >= 240; w -= 8) {
        const now = composerBar(w, chips);
        expect(rank[now.fit]).toBeLessThanOrEqual(rank[last.fit]);
        if (!last.hint) expect(now.hint).toBe(false);
        last = now;
      }
    }
  });

  it('a single model chip keeps its whole name longer than three chips do', () => {
    expect(composerBar(560, 1).fit).toBe('full');
    expect(composerBar(560, 3).fit).not.toBe('full');
  });
});

describe('shortModelName', () => {
  it('drops the vendor, the date and extra words, never cutting a word', () => {
    expect(shortModelName('Default model')).toBe('Default');
    expect(shortModelName('claude-sonnet-4-5-20250929')).toBe('sonnet-4-5');
    expect(shortModelName('anthropic/claude-opus-4')).toBe('opus-4');
    expect(shortModelName('Claude Sonnet 4.5')).toBe('Sonnet 4.5');
    expect(shortModelName('GPT-4o mini via OpenRouter')).toBe('GPT-4o mini');
    expect(shortModelName('Llama')).toBe('Llama');
  });
});

describe('useComposerBar', () => {
  let observed: ((width: number) => void) | null = null;
  afterEach(() => {
    observed = null;
    vi.unstubAllGlobals();
  });

  it('follows the composer as it resizes, keeping the same layout while the fit holds', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private cb: ResizeObserverCallback) {}
        observe() {
          observed = (width) =>
            this.cb([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        disconnect() {}
      },
    );
    const { result } = renderHook(() => {
      const ref = useRef<HTMLDivElement>(document.createElement('div'));
      return useComposerBar(ref, 3);
    });
    expect(result.current.fit).toBe('full');
    act(() => observed?.(380));
    expect(result.current).toEqual({ fit: 'icon', hint: false });
    const same = result.current;
    act(() => observed?.(384));
    expect(result.current).toBe(same);
    act(() => observed?.(1200));
    expect(result.current).toEqual({ fit: 'full', hint: true });
  });
});

describe('BarLabel', () => {
  it('draws a short form only when it says something shorter', () => {
    const { container, rerender } = render(<BarLabel full="Whole setup" short="All" />);
    expect(container.querySelectorAll('[data-fit]')).toHaveLength(2);
    expect(container.querySelector('[data-fit="short"]')?.getAttribute('aria-hidden')).toBe('true');
    rerender(<BarLabel full="Auto" short="Auto" />);
    expect(container.querySelectorAll('[data-fit]')).toHaveLength(1);
  });
});

describe('thread layout CSS', () => {
  const thread = stripComments(read(`${STYLES}thread.css`));
  const composer = stripComments(read(`${STYLES}composer.css`));
  const shell = stripComments(read(`${STYLES}shell.css`));

  it('the thread is a size container and the column is centred, never a fixed width', () => {
    expect(rule(thread, '.thread')).toMatch(/container:\s*thread\s*\/\s*inline-size/);
    const measure = rule(thread, '.thread__measure');
    expect(measure).toMatch(/margin:\s*0 auto/);
    expect(measure).toMatch(/max-width:\s*min\(100%,\s*calc\(var\(--measure\)/);
    expect(measure).not.toMatch(/(?<!-)width:\s*\d+px/);
  });

  it('gutters and rhythm come from tokens, the same for the thread and the composer', () => {
    expect(rule(thread, '.thread')).toMatch(/--gutter:\s*clamp\(var\(--sp-4\),\s*\d+cqi,\s*var\(--sp-7\)\)/);
    expect(rule(thread, '.thread__scroll')).toMatch(/var\(--gutter\)/);
    expect(rule(thread, '.thread__composer')).toMatch(/var\(--gutter\)/);
    expect(rule(thread, '.msg')).toMatch(/gap:\s*var\(--block-gap\)/);
  });

  it('reflows with the pane, not the window: container queries, no width media queries', () => {
    expect(thread).toMatch(/@container thread \(max-width: 560px\)/);
    expect(thread).not.toMatch(/@media \(max-width/);
    expect(composer).not.toMatch(/@media \(max-width/);
  });

  it("your message's time takes no room of its own", () => {
    expect(thread).toMatch(/\n\.msg__foot--user \{[^}]*position:\s*absolute/);
  });

  it("an answer's quiet line shows on hover and focus, always on touch, and stays for an alert", () => {
    expect(thread).toMatch(
      /@media \(hover: hover\) \{[^@]*\.msg__foot:not\(\.msg__foot--user, \[data-alert\]\)/,
    );
    expect(thread).toMatch(/:not\(:hover, :focus-within, \[data-selected\]\)/);
    // Faded, never display:none, so a screen reader and Tab still reach it.
    expect(rule(thread, '.msg__foot')).not.toMatch(/display:\s*none/);
  });

  it('the hint is the spacer and gives way; Send never shrinks', () => {
    expect(rule(thread, '.composer__hint')).toMatch(/flex:\s*1 1 0/);
    expect(rule(thread, '.composer__hint')).toMatch(/min-width:\s*0/);
    expect(rule(thread, '.send')).toMatch(/flex:\s*none/);
    expect(composer).toMatch(/\.composer\[data-bar='icon'\] \.bar-label/);
  });

  it('side columns give way to the thread as the window shrinks', () => {
    expect(rule(shell, '.shell')).toMatch(/min\(var\(--rail-w\),\s*\d+vw\)/);
    expect(shell).toMatch(/--drawer-col:\s*min\(var\(--drawer-w\),\s*\d+vw\)/);
  });
});
