import { describe, expect, it } from 'vitest';
import { chordOf, isControl, isTyping } from '../src/keys/dispatch';
import { displayKeys, findConflicts, normalise } from '../src/keys/registry';

const key = (init: KeyboardEventInit & { key: string }) => new KeyboardEvent('keydown', init);

describe('keymap', () => {
  it('normalises modifier order and case', () => {
    expect(normalise('Shift+Mod+O')).toBe('mod+shift+o');
    expect(normalise('g  n')).toBe('g n');
  });

  it('reads shifted punctuation without naming shift', () => {
    expect(chordOf(key({ key: '?', shiftKey: true }))).toBe('?');
  });

  it('names shift for letters', () => {
    expect(chordOf(key({ key: 'O', ctrlKey: true, shiftKey: true }))).toBe('mod+shift+o');
  });

  it('detects a prefix conflict', () => {
    const conflicts = findConflicts([
      { id: 'a', keys: 'g', label: '', group: 'Go to', scope: 'global' },
      { id: 'b', keys: 'g n', label: '', group: 'Go to', scope: 'global' },
    ]);
    expect(conflicts).toHaveLength(1);
  });

  it('allows the same key in scopes that are never live together', () => {
    expect(
      findConflicts([
        { id: 'a', keys: 'j', label: '', group: 'Lists', scope: 'list' },
        { id: 'b', keys: 'j', label: '', group: 'Branch tree', scope: 'tree' },
      ]),
    ).toEqual([]);
  });

  it('treats text fields as typing, checkboxes as not', () => {
    const input = document.createElement('input');
    const box = document.createElement('input');
    box.type = 'checkbox';
    expect(isTyping(input)).toBe(true);
    expect(isTyping(box)).toBe(false);
    expect(isTyping(document.createElement('textarea'))).toBe(true);
  });

  it('renders sequences as separate chords', () => {
    expect(displayKeys('g n')).toEqual([['G'], ['N']]);
  });
});

describe('Enter and Space on controls', () => {
  // Regression: a list-level "Enter opens" binding swallowed Enter on every
  // focused button, so nothing could be pressed from the keyboard.
  it('treats buttons, links and ARIA widgets as controls that own Enter', () => {
    const btn = document.createElement('button');
    const icon = document.createElement('span');
    btn.append(icon);
    const link = Object.assign(document.createElement('a'), { href: '#x' });
    const option = Object.assign(document.createElement('div'), { role: 'option' });
    option.setAttribute('role', 'option');
    for (const el of [btn, icon, link, option]) expect(isControl(el)).toBe(true);
    expect(isControl(document.createElement('div'))).toBe(false);
    expect(isControl(document.body)).toBe(false);
  });
});

describe('shortcut nudge', () => {
  it('names the key on the third click, once', async () => {
    const { noteClick } = await import('../src/keys/nudge');
    const { useNotify } = await import('../src/state/notify');
    localStorage.removeItem('nvx.ancile.shortcut-nudges');
    const before = useNotify.getState().toasts.length;
    expect(noteClick('message.why')).toBe(false);
    expect(noteClick('message.why')).toBe(false);
    expect(noteClick('message.why')).toBe(true);
    const toasts = useNotify.getState().toasts;
    expect(toasts.length).toBe(before + 1);
    expect(toasts.at(-1)).toMatchObject({ title: 'Next time, press W', body: 'Why did it say this?' });
    for (let i = 0; i < 5; i++) expect(noteClick('message.why')).toBe(false);
  });
});

describe('browser-safe keys', () => {
  const OPERA_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0';
  const CHROME_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

  it('tells Opera from Chrome and Edge', async () => {
    const { detectBrowser } = await import('../src/keys/browser');
    expect(detectBrowser(OPERA_UA, [])).toBe('opera');
    expect(detectBrowser(CHROME_UA, [{ brand: 'Opera' }])).toBe('opera');
    expect(detectBrowser(CHROME_UA, [])).toBe('chrome');
    expect(detectBrowser(`${CHROME_UA} Edg/130.0.0.0`, [])).toBe('edge');
  });

  it('auto is on in Opera only', async () => {
    const { browserSafeOn } = await import('../src/keys/browser');
    expect(browserSafeOn('auto', 'opera')).toBe(true);
    expect(browserSafeOn('auto', 'chrome')).toBe(false);
    expect(browserSafeOn('on', 'chrome')).toBe(true);
    expect(browserSafeOn('off', 'opera')).toBe(false);
  });

  it('in Opera, no shortcut is left on a key Opera keeps, and nothing clashes', async () => {
    const { BROWSER_SAFE, keptBy } = await import('../src/keys/browser');
    const { effectiveBindings, findConflicts, normalise, setBrowserSafe } = await import(
      '../src/keys/registry'
    );
    setBrowserSafe(BROWSER_SAFE);
    try {
      const kept = keptBy('opera');
      const bindings = effectiveBindings();
      const stuck = bindings.filter((b) => kept.has(normalise(b.keys).split(' ')[0] ?? ''));
      expect(stuck.map((b) => `${b.id}=${b.keys}`)).toEqual([]);
      expect(findConflicts(bindings)).toEqual([]);
    } finally {
      setBrowserSafe({});
    }
  });

  it('a person’s own key wins over the browser-safe one', async () => {
    const { BROWSER_SAFE } = await import('../src/keys/browser');
    const { keysFor, setBrowserSafe, setOverrides } = await import('../src/keys/registry');
    setBrowserSafe(BROWSER_SAFE);
    try {
      expect(keysFor('zoom.in')).toBe('alt+=');
      setOverrides({ 'zoom.in': 'mod+shift+=' });
      expect(keysFor('zoom.in')).toBe('mod+shift+=');
    } finally {
      setOverrides({});
      setBrowserSafe({});
    }
    expect(keysFor('zoom.in')).toBe('mod+=');
  });
});
