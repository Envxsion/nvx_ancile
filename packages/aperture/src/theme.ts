/**
 * ------------------------------------------------------------------
 *  Title    |  Theme resolution
 *  ID       |  aperture
 * ------------------------------------------------------------------
 *  Purpose  |  dark | light | system, applied before first paint and
 *           |  kept in step with the OS when the choice is "system".
 *  How      |  BOOT_SCRIPT is inlined into index.html <head> so there is
 *           |  never a flash of the wrong ground, and replays the last
 *           |  applied look (prefs.ts) the same way. setTheme() animates the
 *           |  swap by flagging the root for one theme duration only.
 * ------------------------------------------------------------------
 */

import { LOOK_KEY } from './prefs';

export type ThemeChoice = 'system' | 'dark' | 'light';
export const THEME_KEY = 'nvx.ancile.theme';
/** The edition last seen ('pro' | 'free'), replayed before first paint so Pro never flashes in. */
export const EDITION_KEY = 'nvx.ancile.edition';

/** Inline in <head>. Kept tiny and dependency-free on purpose. */
export const BOOT_SCRIPT = `(function(){var r=document.documentElement;try{var c=localStorage.getItem('${THEME_KEY}')||'system';var d=c==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):c;r.dataset.theme=d;r.dataset.themeChoice=c;if(localStorage.getItem('${EDITION_KEY}')==='pro')r.dataset.edition='pro';var l=JSON.parse(localStorage.getItem('${LOOK_KEY}')||'null');if(l){for(var k in l.attrs)r.dataset[k]=l.attrs[k];for(var v in l.vars)r.style.setProperty(v,l.vars[v])}}catch(e){r.dataset.theme=r.dataset.theme||'dark'}})();`;

function resolve(choice: ThemeChoice): 'dark' | 'light' {
  if (choice !== 'system') return choice;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function getThemeChoice(): ThemeChoice {
  try {
    return (localStorage.getItem(THEME_KEY) as ThemeChoice | null) ?? 'system';
  } catch {
    return 'system';
  }
}

/**
 * The swap is a colour cross-fade, never movement, so it plays with reduced
 * motion too: prefs.css caps --d-theme at 120 ms there (a short fade). It
 * reads the resolved data-motion, not the OS, like everything else.
 */
export function setTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  const ms = root.dataset.motion === 'reduced' ? 140 : 520;
  root.setAttribute('data-theme-switching', '');
  root.dataset.theme = resolve(choice);
  root.dataset.themeChoice = choice;
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* private mode: the choice lasts for this tab only */
  }
  window.setTimeout(() => root.removeAttribute('data-theme-switching'), ms);
}

/** Follow the OS while the choice is "system". Returns an unsubscribe. */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const onChange = () => {
    if (getThemeChoice() === 'system') setTheme('system');
  };
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
