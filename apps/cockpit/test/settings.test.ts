/**
 * Every setting does what it says: the mappings from a preference to the
 * document, the thread and the chrome.
 */
import { resolveLook } from '@nvx/aperture';
import { DEFAULT_PREFERENCES, Preferences } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import type { ComputeNode } from '../src/compute/data';
import { stamp } from '../src/lib/format';
import { shouldChime } from '../src/notify/chime';
import { shownNode } from '../src/shell/StatusBar';
import { lookOf } from '../src/state/prefs';
import { EMPTY_LIVE, nextTheme, useUi } from '../src/state/ui';
import { nextAnnouncement } from '../src/thread/announce';
import { htmlToMarkdown } from '../src/thread/pasteMarkdown';

describe('reading prefs reach the CSS variables the thread reads', () => {
  it('text size and code size become --read-size and --code-size', () => {
    const p = Preferences.parse({ reading: { size: 18, codeSize: 15.5 } });
    const { vars } = resolveLook(lookOf(p));
    expect(vars['--read-size']).toBe('18px');
    expect(vars['--code-size']).toBe('15.5px');
  });

  it('thick focus rings, gilt and density become attributes', () => {
    const p = Preferences.parse({
      accessibility: { focus: 'thick' },
      appearance: { gilt: 'subtle' },
      layout: { density: 'compact' },
    });
    const { attrs } = resolveLook(lookOf(p));
    expect(attrs.focus).toBe('thick');
    expect(attrs.gilt).toBe('subtle');
    expect(attrs.density).toBe('compact');
  });
});

describe('preferences from older files', () => {
  it('reads the old streaming values as live, and drops the removed grounded switch', () => {
    const p = Preferences.parse({ reading: { streaming: 'smooth' }, composer: { grounded: false } });
    expect(p.reading.streaming).toBe('live');
    expect(Preferences.parse({ reading: { streaming: 'raw' } }).reading.streaming).toBe('live');
    expect('grounded' in p.composer).toBe(false);
    expect(DEFAULT_PREFERENCES.reading.streaming).toBe('live');
  });

  it('keeps the new whole value', () => {
    expect(Preferences.parse({ reading: { streaming: 'whole' } }).reading.streaming).toBe('whole');
  });
});

describe('theme toggle', () => {
  it('always changes what you see, and returns to system when that matches it', () => {
    expect(nextTheme('dark', true)).toBe('light');
    expect(nextTheme('light', true)).toBe('system');
    expect(nextTheme('light', false)).toBe('dark');
    expect(nextTheme('dark', false)).toBe('system');
  });
});

describe('decision chime', () => {
  it('sounds only for approvals, and only when switched on', () => {
    expect(shouldChime(true, { category: 'approvals' })).toBe(true);
    expect(shouldChime(true, { category: 'runs' })).toBe(false);
    expect(shouldChime(true, {})).toBe(false);
    expect(shouldChime(false, { category: 'approvals' })).toBe(false);
  });
});

describe('reading answers aloud', () => {
  const text = 'First sentence. Second one! Third is still being wri';

  it('reads whole sentences, then the rest when done', () => {
    const a = nextAnnouncement(text, 0, 'sentences', false);
    expect(a.say).toBe('First sentence. Second one!');
    const b = nextAnnouncement(text, a.upTo, 'sentences', false);
    expect(b.say).toBe('');
    const c = nextAnnouncement(text, a.upTo, 'sentences', true);
    expect(c.say).toBe('Third is still being wri');
  });

  it('waits for a paragraph break in paragraph mode', () => {
    expect(nextAnnouncement(text, 0, 'paragraphs', false).say).toBe('');
    expect(nextAnnouncement('One. Two.\n\nThree', 0, 'paragraphs', false).say).toBe('One. Two.');
  });

  it('says nothing when off, and drops markdown marks', () => {
    expect(nextAnnouncement(text, 0, 'off', true).say).toBe('');
    expect(nextAnnouncement('**Bold** claim [1]. ', 0, 'sentences', false).say).toBe('Bold claim .');
  });
});

describe('message times', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  it('follows the Times setting', () => {
    expect(stamp('2026-10-11T11:55:00Z', 'relative', now)).toBe('5 min ago');
    expect(stamp('2026-10-11T11:55:00Z', 'hidden', now)).toBeNull();
    expect(stamp('2026-10-11T11:55:00Z', 'absolute', now)).toMatch(/^\d{2}:\d{2}$/);
    expect(stamp('2026-10-01T11:55:00Z', 'absolute', now)).toMatch(/Oct, \d{2}:\d{2}$/);
    expect(stamp('not a date', 'absolute', now)).toBeNull();
  });
});

describe('paste with formatting', () => {
  it('turns links, emphasis and lists into markdown', () => {
    const md = htmlToMarkdown(
      '<p>See <a href="https://nvx.sh">the site</a> and <strong>this</strong>.</p><ul><li>one</li><li>two</li></ul>',
    );
    expect(md).toBe('See [the site](https://nvx.sh) and **this**.\n\n- one\n- two');
  });

  it('leaves plain HTML and unsafe links to the ordinary paste', () => {
    expect(htmlToMarkdown('<span>just words</span>')).toBeNull();
    expect(htmlToMarkdown('<a href="javascript:alert(1)">x</a>')).toBe('x');
  });
});

describe('status bar GPU node', () => {
  const node = (name: string, state: ComputeNode['observed_state'], rate: number) =>
    ({ name, observed_state: state, hourly_rate: rate }) as ComputeNode;

  it('shows a running node, or nothing', () => {
    expect(shownNode(undefined)).toBeNull();
    expect(shownNode([node('a', 'stopped', 1)])).toBeNull();
    expect(shownNode([node('a', 'starting', 2), node('b', 'running', 0.4)])?.name).toBe('b');
  });
});

describe('ui state', () => {
  it('starts from nothing, not the demo fixtures', () => {
    expect(useUi.getState().live).toEqual(EMPTY_LIVE);
    expect(useUi.getState().drawerTab).toBe(DEFAULT_PREFERENCES.layout.drawerTab);
  });
});
