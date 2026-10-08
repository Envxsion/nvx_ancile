/**
 * ------------------------------------------------------------------
 *  Title    |  Browser keys
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Know which browser NVX Ancile runs in, which keys that
 *           |  browser keeps for itself, and the few defaults that
 *           |  move so every shortcut still reaches the page.
 *  How      |  Detection from the user agent (Opera adds "OPR/" or
 *           |  an "Opera" brand). Keep-lists are normalised chords.
 *           |  Settings → Keyboard "Browser-safe keys" is auto (on in
 *           |  Opera), on or off; the person's own keys always win.
 *  Note     |  Sources: Opera's shortcut list for Windows (tabs, the
 *           |  sidebar, extensions, quit, zoom) and its optional
 *           |  "advanced keyboard shortcuts" single keys (1, 2, z, x,
 *           |  /, 8, 7, 6). Chromium itself never lets a page see
 *           |  Ctrl+N, Ctrl+T or Ctrl+W.
 * ------------------------------------------------------------------
 */

export type Browser = 'opera' | 'edge' | 'firefox' | 'safari' | 'chrome' | 'desktop' | 'other';

interface Brand {
  brand: string;
}

/** Which browser this is, from the user agent and, where offered, its brands. */
export function detectBrowser(
  ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  brands: readonly Brand[] = (
    typeof navigator === 'undefined'
      ? []
      : ((navigator as Navigator & { userAgentData?: { brands?: Brand[] } }).userAgentData?.brands ?? [])
  ) as Brand[],
): Browser {
  if (/Tauri/i.test(ua)) return 'desktop';
  if (/\bOPR\/|\bOPRGX\/|\bOpera\b/.test(ua) || brands.some((b) => /Opera/i.test(b.brand))) return 'opera';
  if (/\bEdg\//.test(ua)) return 'edge';
  if (/\bFirefox\//.test(ua)) return 'firefox';
  if (/\bSafari\//.test(ua) && !/\bChrom(e|ium)\//.test(ua)) return 'safari';
  if (/\bChrom(e|ium)\//.test(ua)) return 'chrome';
  return 'other';
}

/** Every browser keeps these: a page never receives them. */
const ALWAYS = [
  'mod+n',
  'mod+shift+n',
  'mod+t',
  'mod+shift+t',
  'mod+w',
  'mod+shift+w',
  'mod+tab',
  'mod+shift+tab',
];

/** Opera's own keys on top of those, and its optional single-key mode. */
const OPERA = [
  'mod+shift+e',
  'mod+shift+x',
  'mod+shift+s',
  'mod+j',
  'mod+h',
  'mod+m',
  'mod+`',
  'mod+space',
  'mod+=',
  'mod+-',
  'mod+0',
  'alt+p',
  // "Advanced keyboard shortcuts", when turned on in Opera's settings.
  '1',
  '2',
  'z',
  'x',
  '/',
  '8',
  '7',
  '6',
];

export function keptBy(browser: Browser): ReadonlySet<string> {
  if (browser === 'desktop') return new Set();
  return new Set(browser === 'opera' ? [...ALWAYS, ...OPERA] : ALWAYS);
}

/**
 * Defaults that move when browser-safe keys are on, so nothing the browser
 * may keep is the only way to reach a command. Each new key is free in
 * every scope it shares (checked by the keymap's conflict test).
 */
export const BROWSER_SAFE: Readonly<Record<string, string>> = {
  'zoom.in': 'alt+=',
  'zoom.out': 'alt+-',
  'zoom.reset': 'alt+0',
  'search.focus': 'g /',
  'message.lab': 'shift+x',
};

export type BrowserSafeChoice = 'auto' | 'on' | 'off';

/** Whether the browser-safe variant applies: auto turns it on in Opera. */
export function browserSafeOn(choice: BrowserSafeChoice, browser: Browser): boolean {
  return choice === 'on' || (choice === 'auto' && browser === 'opera');
}
