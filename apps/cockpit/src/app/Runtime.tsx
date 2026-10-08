/**
 * ------------------------------------------------------------------
 *  Title    |  Runtime
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The quiet machinery under every screen: preferences on
 *           |  the document, the theme, the frame-time governor, a
 *           |  person's own keys and CSS, and the global commands
 *           |  that belong to no single screen (zoom, focus mode,
 *           |  back and forward, settings, a new thread).
 *  How      |  Effects only; renders the grain layer and nothing else.
 * ------------------------------------------------------------------
 */

import { setTheme } from '@nvx/aperture';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { BROWSER_SAFE, browserSafeOn, detectBrowser } from '../keys/browser';
import { useBinding } from '../keys/dispatch';
import { setBrowserSafe, setOverrides } from '../keys/registry';
import { startTelemetry } from '../lib/telemetry';
import { startFrameGovernor, startPrefs, usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';

const ZOOM_STEPS = [0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.3, 1.4];

function safeMode(): boolean {
  try {
    return new URLSearchParams(location.search).has('safe');
  } catch {
    return false;
  }
}

export function Runtime() {
  const navigate = useNavigate();
  const router = useRouter();
  const theme = usePrefs((s) => s.prefs.appearance.theme);
  const overrides = usePrefs((s) => s.prefs.keyboard.overrides);
  const css = usePrefs((s) => s.prefs.advanced.css);
  const grain = usePrefs((s) => s.prefs.appearance.grain);

  useEffect(() => startPrefs(), []);
  useEffect(() => startTelemetry(), []);
  useEffect(() => startFrameGovernor(), []);
  useEffect(() => setOverrides(overrides), [overrides]);
  const browserSafe = usePrefs((s) => s.prefs.keyboard.browserSafe);
  useEffect(
    () => setBrowserSafe(browserSafeOn(browserSafe, detectBrowser()) ? BROWSER_SAFE : {}),
    [browserSafe],
  );

  // The stored theme drives the document; the titlebar toggle writes the store.
  useEffect(() => {
    if (document.documentElement.dataset.themeChoice !== theme) setTheme(theme);
    if (useUi.getState().theme !== theme) useUi.setState({ theme });
  }, [theme]);

  // A person's own CSS, last in the cascade. ?safe=1 starts without it.
  useEffect(() => {
    if (safeMode()) return;
    let el = document.getElementById('ancile-user-css') as HTMLStyleElement | null;
    if (!css.trim()) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('style');
      el.id = 'ancile-user-css';
      document.head.appendChild(el);
    }
    el.textContent = css;
  }, [css]);

  const zoom = (dir: 1 | -1 | 0) => {
    const cur = usePrefs.getState().prefs.appearance.zoom;
    const i = ZOOM_STEPS.findIndex((z) => z >= cur - 0.001);
    const next =
      dir === 0 ? 1 : (ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (i < 0 ? 4 : i) + dir))] ?? 1);
    usePrefs.getState().set('appearance', { zoom: next });
  };
  useBinding('zoom.in', () => zoom(1));
  useBinding('zoom.out', () => zoom(-1));
  useBinding('zoom.reset', () => zoom(0));
  useBinding('view.focus', () => useUi.getState().toggleFocus());
  useBinding('history.back', () => router.history.back());
  useBinding('history.forward', () => router.history.forward());
  useBinding('settings.open', () => navigate({ to: '/settings/$group', params: { group: 'appearance' } }));
  useBinding('go.settings', () => navigate({ to: '/settings/$group', params: { group: 'appearance' } }));
  useBinding('thread.quick', () => navigate({ to: '/' }));

  return grain ? <div className="grain" aria-hidden="true" /> : null;
}
