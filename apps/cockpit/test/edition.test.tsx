/**
 * The edition on the document (src/pro/edition.tsx): Pro is a Pro build
 * with a Pro tier, the attribute follows the licence and is kept for the
 * theme script, and Pro's arrival plays once, never with reduced motion.
 */
import { BOOT_SCRIPT, EDITION_KEY } from '@nvx/aperture';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { ...real.api, get: vi.fn() } };
});

import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { AWAKENED_KEY, awakenPro, EditionSync, editionOf } from '../src/pro/edition';
import { usePrefs } from '../src/state/prefs';

const details = (build: 'free' | 'pro', tier: 'free' | 'pro') => ({ build, status: { tier } });

afterEach(() => {
  queryClient.clear();
  localStorage.clear();
  delete document.documentElement.dataset.edition;
  vi.mocked(api.get).mockReset();
});

describe('the edition', () => {
  it('is Pro only for a Pro build with a Pro tier', () => {
    expect(editionOf(details('pro', 'pro'))).toBe('pro');
    expect(editionOf(details('free', 'pro'))).toBe('free');
    expect(editionOf(details('pro', 'free'))).toBe('free');
    expect(editionOf(undefined)).toBeNull();
  });

  it('the theme script replays a kept Pro edition before first paint', () => {
    expect(BOOT_SCRIPT).toContain(`localStorage.getItem('${EDITION_KEY}')==='pro'`);
  });

  it('follows the licence onto <html>, keeps it, and plays the first arrival once', async () => {
    vi.mocked(api.get).mockResolvedValue(details('pro', 'pro'));
    const seen = vi.fn();
    window.addEventListener('ancile:pro-awaken', seen);
    render(
      <QueryClientProvider client={queryClient}>
        <EditionSync />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(document.documentElement.dataset.edition).toBe('pro'));
    expect(localStorage.getItem(EDITION_KEY)).toBe('pro');
    expect(localStorage.getItem(AWAKENED_KEY)).toBe('1');
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener('ancile:pro-awaken', seen);
  });

  it('draws nothing for the arrival with reduced motion', () => {
    // The in-app setting, as Settings → Accessibility → Motion sets it.
    const before = usePrefs.getState().prefs;
    usePrefs.setState({
      prefs: { ...before, accessibility: { ...before.accessibility, motion: 'reduced' } },
    });
    vi.mocked(api.get).mockResolvedValue(details('free', 'free'));
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <EditionSync />
      </QueryClientProvider>,
    );
    act(() => awakenPro());
    expect(container.querySelector('.pro-awaken')).toBeNull();
    usePrefs.setState({ prefs: before });
  });
});
