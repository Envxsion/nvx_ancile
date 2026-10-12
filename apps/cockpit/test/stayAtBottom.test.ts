/**
 * A notice above the composer makes the list shorter: while you were at
 * the bottom, the list stays there, so the notice never covers the end.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stayAtBottomOnShrink } from '../src/thread/stayAtBottom';

let fire: () => void = () => undefined;
class FakeResizeObserver {
  constructor(cb: () => void) {
    fire = cb;
  }
  observe() {}
  disconnect() {}
}

afterEach(() => vi.unstubAllGlobals());

function scroller(height: number) {
  const el = {
    clientHeight: height,
    scrollHeight: 2000,
    scrollTop: 2000 - height,
  } as unknown as HTMLElement & {
    clientHeight: number;
  };
  return el;
}

describe('stayAtBottomOnShrink', () => {
  it('scrolls to the end when the list gets shorter while you follow it', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const el = scroller(600);
    stayAtBottomOnShrink(el, () => true);
    (el as { clientHeight: number }).clientHeight = 480; // a notice appeared above the composer
    fire();
    expect(el.scrollTop).toBe(2000);
  });

  it('leaves you where you are when you had scrolled up, or the list grew', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const el = scroller(600);
    el.scrollTop = 300;
    stayAtBottomOnShrink(el, () => false);
    (el as { clientHeight: number }).clientHeight = 480;
    fire();
    expect(el.scrollTop).toBe(300);
    const grown = scroller(480);
    grown.scrollTop = 100;
    stayAtBottomOnShrink(grown, () => true);
    (grown as { clientHeight: number }).clientHeight = 600;
    fire();
    expect(grown.scrollTop).toBe(100);
  });
});
