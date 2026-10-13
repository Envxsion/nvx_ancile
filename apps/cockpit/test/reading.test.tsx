/**
 * Settings → Reading: every control changes the store, reaches the document
 * at once, keeps its place while you drag, and survives a restart.
 */
import { applyLook, LOOK_KEY } from '@nvx/aperture';
import { DEFAULT_PREFERENCES } from '@nvx/contracts';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', () => ({
  API_BASE: '/api/v1',
  api: {
    get: vi.fn(() => Promise.resolve({ value: null })),
    put: vi.fn(() => Promise.resolve({})),
  },
}));

import { ReadingGroup } from '../src/routes/settings/groups';
import { lookOf, startPrefs, usePrefs } from '../src/state/prefs';

const root = document.documentElement;
const cssVar = (k: string) => root.style.getPropertyValue(k);
const reading = () => usePrefs.getState().prefs.reading;

let stop: () => void;
beforeAll(() => {
  stop = startPrefs();
});
afterAll(() => stop());
beforeEach(() => {
  usePrefs.getState().reset();
});

function group(name: string) {
  return screen.getByRole('radiogroup', { name });
}
function pick(groupName: string, option: string) {
  fireEvent.click(
    Array.from(group(groupName).querySelectorAll('[role="radio"]')).find(
      (b) => b.textContent === option,
    ) as HTMLElement,
  );
}

describe('Settings → Reading, control by control', () => {
  it('text size applies to --read-size while you drag', () => {
    render(<ReadingGroup />);
    const slider = screen.getByRole('slider', { name: 'Text size' });
    fireEvent.change(slider, { target: { value: '18' } });
    expect(reading().size).toBe(18);
    expect(cssVar('--read-size')).toBe('18px');
    fireEvent.change(slider, { target: { value: '13.5' } });
    expect(cssVar('--read-size')).toBe('13.5px');
  });

  it('line spacing applies to --lh-read', () => {
    render(<ReadingGroup />);
    pick('Line spacing', 'Loose');
    expect(reading().lineHeight).toBe('loose');
    expect(cssVar('--lh-read')).toBe('1.8');
    pick('Line spacing', 'Tight');
    expect(cssVar('--lh-read')).toBe('1.5');
  });

  it('reading width applies to --measure, full meaning the whole column', () => {
    render(<ReadingGroup />);
    pick('Reading width', 'Narrow');
    expect(cssVar('--measure')).toBe('60ch');
    pick('Reading width', 'Full');
    expect(cssVar('--measure')).toBe('100%');
  });

  it('code size applies to --code-size', () => {
    render(<ReadingGroup />);
    fireEvent.change(screen.getByRole('slider', { name: 'Code size' }), { target: { value: '15' } });
    expect(reading().codeSize).toBe(15);
    expect(cssVar('--code-size')).toBe('15px');
  });

  it('show answers, citations and times change the store the thread reads', () => {
    render(<ReadingGroup />);
    pick('Show answers', 'When finished');
    expect(reading().streaming).toBe('whole');
    pick('Citations', 'Superscript');
    expect(reading().citations).toBe('superscript');
    pick('Times', 'Hidden');
    expect(reading().timestamps).toBe('hidden');
  });

  it('the cost and fold switches flip', () => {
    render(<ReadingGroup />);
    fireEvent.click(screen.getByRole('switch', { name: 'Tokens and cost under answers' }));
    expect(reading().cost).toBe(!DEFAULT_PREFERENCES.reading.cost);
    fireEvent.click(screen.getByRole('switch', { name: 'Fold tool steps' }));
    expect(reading().collapseTools).toBe(!DEFAULT_PREFERENCES.reading.collapseTools);
  });

  it('shows a preview drawn with the thread classes, so changes are visible here', () => {
    const { container } = render(<ReadingGroup />);
    expect(
      container.querySelector('.reading-preview .msg[data-role="assistant"] .msg__body .md'),
    ).not.toBeNull();
    expect(container.querySelector('.reading-preview .code__pre')).not.toBeNull();
  });
});

describe('the slider keeps its place', () => {
  it('Reset is laid out before and after a change, so the slider never shifts mid-drag', () => {
    const { container } = render(<ReadingGroup />);
    const row = screen.getByRole('slider', { name: 'Text size' }).closest('.setting') as HTMLElement;
    const resetBefore = row.querySelector('.setting__reset');
    expect(resetBefore).not.toBeNull();
    expect(resetBefore).toHaveAttribute('data-hidden');
    fireEvent.change(screen.getByRole('slider', { name: 'Text size' }), { target: { value: '17' } });
    const resetAfter = row.querySelector('.setting__reset');
    expect(resetAfter).toBe(resetBefore);
    expect(resetAfter).not.toHaveAttribute('data-hidden');
    fireEvent.click(resetAfter as HTMLElement);
    expect(reading().size).toBe(DEFAULT_PREFERENCES.reading.size);
    expect(container.querySelector('.setting__reset:not([data-hidden])')).toBeNull();
  });

  it('applying the same look twice writes nothing to the document', () => {
    const look = lookOf(usePrefs.getState().prefs);
    applyLook(look);
    const spy = vi.spyOn(root.style, 'setProperty');
    applyLook(look);
    applyLook({ ...look, readSize: 19 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('--read-size', '19px');
    spy.mockRestore();
  });
});

describe('reading choices survive a restart', () => {
  it('are written to this device and read back on start', async () => {
    usePrefs.getState().set('reading', { size: 17.5, lineHeight: 'loose', width: 'wide', codeSize: 14 });
    const saved = JSON.parse(localStorage.getItem('nvx.ancile.prefs') ?? '{}');
    expect(saved.state.prefs.reading).toMatchObject({ size: 17.5, lineHeight: 'loose', width: 'wide' });
    const look = JSON.parse(localStorage.getItem(LOOK_KEY) ?? '{}');
    expect(look.vars['--read-size']).toBe('17.5px');

    // A fresh start: the store comes back from storage and the document follows.
    usePrefs.setState({ prefs: DEFAULT_PREFERENCES, changedAt: 0 });
    expect(cssVar('--read-size')).toBe('15.5px');
    localStorage.setItem('nvx.ancile.prefs', JSON.stringify(saved));
    await usePrefs.persist.rehydrate();
    expect(reading()).toMatchObject({ size: 17.5, lineHeight: 'loose', width: 'wide', codeSize: 14 });
    expect(cssVar('--read-size')).toBe('17.5px');
    expect(cssVar('--measure')).toBe('84ch');
  });
});
