/**
 * ------------------------------------------------------------------
 *  Title    |  Titlebar
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  44 px of chrome: the mark as a status light, where you
 *           |  are, and what you reach for most (search, the guide,
 *           |  theme, notifications). Settings has one home, at the
 *           |  foot of the sidebar, and Ctrl+K. The sidebar toggle
 *           |  lives here too, so a hidden sidebar is always one click
 *           |  from coming back, on any screen, by touch as well.
 *  Note     |  The mark's state is the AI's state: thinking, streaming,
 *           |  or the shield closed because a decision waits on you.
 *           |  Its label says so for screen readers.
 * ------------------------------------------------------------------
 */

import { AncileMark, type MarkState, type ThemeChoice } from '@nvx/aperture';
import { Link, useRouter } from '@tanstack/react-router';
import { AnimatePresence, m as motion } from 'motion/react';
import { useEffect } from 'react';
import { useBinding } from '../keys/dispatch';
import { keysFor, keyText } from '../keys/registry';
import { notify, useNotify } from '../state/notify';
import { usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';
import { Kbd, Tip } from '../ui/primitives';

const MARK_LABEL: Record<MarkState, string> = {
  idle: 'Ready',
  thinking: 'Thinking',
  streaming: 'Writing an answer',
  ask: 'Waiting for your decision',
  offline: 'Core is not answering',
  alarm: 'Something needs attention',
};

/** Remembers that the one-time note about Settings has been shown. */
const SETTINGS_TIP = 'nvx.ancile.tip.settings-moved';
const USED_PALETTE = 'nvx.ancile.palette.frecency';

const THEME_ICON = { system: 'monitor', dark: 'moon', light: 'sun' } as const;
const THEME_LABEL = {
  system: 'Theme follows your system',
  dark: 'Dark theme',
  light: 'Light theme',
} as const;

export function Titlebar({ crumbs }: { crumbs: { label: string; to?: string }[] }) {
  const mark = useUi((s) => s.mark);
  const markAnim = usePrefs((s) => s.prefs.appearance.mark);
  const openPalette = useUi((s) => s.openPalette);
  const setCenter = useUi((s) => s.setCenter);
  const setApproval = useUi((s) => s.setApproval);
  const railOpen = useUi((s) => s.railOpen);
  const toggleRail = useUi((s) => s.toggleRail);
  const unread = useNotify((s) => s.history.filter((h) => !h.read).length);
  const theme: ThemeChoice = useUi((s) => s.theme);
  const cycleTheme = useUi((s) => s.cycleTheme);
  const router = useRouter();
  useBinding('theme.toggle', cycleTheme);

  // The top-right Settings button went (ROADMAP NV2): say so once to someone who had it.
  // Returning means they used the palette before; any stored key is not enough, because a
  // fresh install writes several on first load. Never during setup, where it covered the
  // primary button.
  useEffect(() => {
    try {
      if (localStorage.getItem(SETTINGS_TIP)) return;
      const onSetup = window.location.pathname.startsWith('/setup');
      const returning = !onSetup && localStorage.getItem(USED_PALETTE) !== null;
      localStorage.setItem(SETTINGS_TIP, '1');
      if (returning)
        notify({
          level: 'info',
          title: 'Settings moved to the sidebar',
          body: `Open it at the bottom of the sidebar, or press ${keyText('settings.open')}.`,
        });
    } catch {
      /* storage blocked: no tip */
    }
  }, []);

  // "Still" keeps the mark as a logo; "status only" keeps its colour states without motion.
  const shown: MarkState = markAnim === 'still' ? 'idle' : mark;

  return (
    <header className="titlebar">
      <Tip label={railOpen ? 'Hide sidebar' : 'Show sidebar'} binding="rail.toggle" side="bottom">
        <button
          type="button"
          className="icon-btn icon-btn--sm titlebar__rail"
          onClick={toggleRail}
          aria-label={railOpen ? 'Hide sidebar' : 'Show sidebar'}
          aria-pressed={railOpen}
        >
          <Icon name="panelLeft" size={15} />
        </button>
      </Tip>

      <Link
        to="/"
        className="titlebar__brand"
        aria-label={`NVX Ancile. ${MARK_LABEL[mark]}`}
        data-mark-anim={markAnim}
      >
        <AncileMark size={22} state={shown} />
        <span className="wordmark" aria-hidden="true">
          NVX <span>Ancile</span>
        </span>
      </Link>

      {crumbs.length > 0 ? (
        <nav className="crumbs" aria-label="Location">
          {crumbs.map((c, i) => (
            <span key={`${i === crumbs.length - 1 ? 'here' : (c.to ?? c.label)}`} className="crumbs__item">
              <span className="crumbs__sep" aria-hidden="true">
                /
              </span>
              {c.to ? (
                <a
                  href={c.to}
                  className="crumbs__link"
                  onClick={(e) => {
                    e.preventDefault();
                    if (c.to) router.history.push(c.to);
                  }}
                >
                  {c.label}
                </a>
              ) : (
                <span aria-current="page" dir="auto">
                  {c.label}
                </span>
              )}
            </span>
          ))}
        </nav>
      ) : null}

      <span className="titlebar__state" aria-live="polite">
        <AnimatePresence mode="wait" initial={false}>
          {mark !== 'idle' ? (
            <motion.button
              type="button"
              key={mark}
              className="titlebar__state-pill"
              data-mark={mark}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4, transition: { duration: 0.12 } }}
              onClick={() => (mark === 'ask' ? setApproval(true) : undefined)}
              tabIndex={mark === 'ask' ? 0 : -1}
            >
              {mark === 'thinking' || mark === 'streaming' ? (
                <span className="dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              ) : null}
              {MARK_LABEL[mark]}
            </motion.button>
          ) : null}
        </AnimatePresence>
      </span>

      <div className="titlebar__actions">
        <button
          type="button"
          className="palette-hint"
          onClick={() => openPalette()}
          aria-label="Search or run a command"
          data-tour="palette"
        >
          <Icon name="search" size={14} />
          <span>Search or run a command</span>
          <Kbd keys={keysFor('palette.open') ?? 'mod+k'} binding="palette.open" />
        </button>
        <Tip label="Guide" binding="help.open" side="bottom">
          <button
            type="button"
            className="icon-btn"
            onClick={() => useUi.getState().setHelp(true)}
            aria-label="Open the guide"
          >
            <Icon name="book" />
          </button>
        </Tip>
        <Tip label={THEME_LABEL[theme]} binding="theme.toggle" side="bottom">
          <button
            type="button"
            className="icon-btn"
            onClick={cycleTheme}
            aria-label={`${THEME_LABEL[theme]}. Switch theme`}
          >
            <Icon name={THEME_ICON[theme]} />
          </button>
        </Tip>
        <Tip label="Notifications" binding="center.open" side="bottom">
          <button
            type="button"
            className="icon-btn"
            onClick={() => setCenter(true)}
            aria-label={`Notifications, ${unread} unread`}
            data-unread={unread > 0 || undefined}
          >
            <Icon name="bell" />
            {unread > 0 ? (
              <span className="icon-btn__badge" data-num key={unread}>
                {unread > 9 ? '9+' : unread}
              </span>
            ) : null}
          </button>
        </Tip>
      </div>
    </header>
  );
}
