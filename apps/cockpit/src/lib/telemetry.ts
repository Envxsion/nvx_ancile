/**
 * ------------------------------------------------------------------
 *  Title    |  Usage statistics (Cockpit side)
 *  Ref      |  docs/telemetry.md · packages/contracts/src/telemetry.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The few things only the browser knows: which browser,
 *           |  whether a shortcut or a click did it, which help you
 *           |  opened. Counts only, handed to Core, which decides
 *           |  whether anything is ever sent.
 *  How      |  Watches the stores that already change when you do
 *           |  something (help, preferences, the shell), plus two
 *           |  explicit calls: a shortcut fired, a control clicked.
 *           |  Buffers, and posts to /api/v1/telemetry/ui every
 *           |  minute and when the tab is hidden. Nothing is kept or
 *           |  posted unless you said yes.
 * ------------------------------------------------------------------
 */

import type { telemetry } from '@nvx/contracts';
import { STEPS } from '../help/steps';
import { useHelp } from '../help/store';
import { bindingById } from '../keys/registry';
import { usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';
import { api } from './api';

type Feature = telemetry.Feature;
type Area = (typeof telemetry.UI_AREAS)[number];
type Step = (typeof telemetry.FUNNEL_STEPS)[number];

let granted = false;
let counters: Record<string, number> = {};
let firstUse: { feature: Feature; via: 'click' | 'shortcut' | 'palette' }[] = [];
const seen = new Set<string>();
let funnel: Step[] = [];
let exceptions: string[] = [];
let envSent = false;

/** Ask Core whether statistics are on (after a change in Settings, too). */
export async function refreshConsent(): Promise<boolean> {
  try {
    const s = await api.get<telemetry.TelemetryStatus>('/telemetry');
    granted = s.consent === 'granted';
  } catch {
    granted = false;
  }
  if (!granted) clear();
  else envSent = false;
  return granted;
}

function clear() {
  counters = {};
  firstUse = [];
  funnel = [];
  exceptions = [];
}

function bump(key: string, n = 1) {
  if (!granted) return;
  counters[key] = (counters[key] ?? 0) + n;
}

/** A feature only the Cockpit sees (the rest are counted by Core from the API). */
export function track(feature: Feature, via: 'click' | 'shortcut' | 'palette' = 'click') {
  if (!granted) return;
  bump(`f_${feature}`);
  if (seen.has(feature)) return;
  seen.add(feature);
  firstUse.push({ feature, via });
}

export function step(s: Step) {
  if (granted && !funnel.includes(s)) funnel.push(s);
}

const AREA_OF: Record<string, Area> = {
  Thread: 'thread',
  'Branch tree': 'tree',
  'Flow editor': 'flow',
};

function areaOf(bindingId: string): Area {
  if (bindingId.startsWith('composer.')) return 'composer';
  if (bindingId.startsWith('palette.')) return 'palette';
  return AREA_OF[bindingById(bindingId)?.group ?? ''] ?? 'shell';
}

/** A keyboard shortcut ran (keys/dispatch). */
export function shortcutUsed(bindingId: string) {
  bump(`shortcut_${areaOf(bindingId)}`);
}

/** A control that has a shortcut was clicked instead (ui/primitives Tip). */
export function controlClicked(bindingId: string) {
  bump(`click_${areaOf(bindingId)}`);
}

function browser(): { browser: string; browser_major: number } {
  const ua = navigator.userAgent;
  const nav = navigator as Navigator & { brave?: unknown };
  const pick = (re: RegExp) => Number.parseInt(re.exec(ua)?.[1] ?? '0', 10) || 0;
  if (/OPR\/|Opera/.test(ua)) return { browser: 'opera', browser_major: pick(/OPR\/(\d+)/) };
  if (/Edg\//.test(ua)) return { browser: 'edge', browser_major: pick(/Edg\/(\d+)/) };
  if (/Vivaldi\//.test(ua)) return { browser: 'vivaldi', browser_major: pick(/Vivaldi\/(\d+)/) };
  if (/Firefox\//.test(ua)) return { browser: 'firefox', browser_major: pick(/Firefox\/(\d+)/) };
  if (nav.brave) return { browser: 'brave', browser_major: pick(/Chrome\/(\d+)/) };
  if (/Chrome\//.test(ua)) return { browser: 'chrome', browser_major: pick(/Chrome\/(\d+)/) };
  if (/Safari\//.test(ua)) return { browser: 'safari', browser_major: pick(/Version\/(\d+)/) };
  return { browser: 'other', browser_major: 0 };
}

function env(): NonNullable<telemetry.TelemetryUiRequest['env']> {
  const lang = (navigator.language || 'en').split('-')[0]?.toLowerCase() ?? 'en';
  const tz = Math.max(-12, Math.min(14, Math.round(-new Date().getTimezoneOffset() / 60)));
  const theme = usePrefs.getState().prefs.appearance.theme;
  return {
    ...(browser() as { browser: 'chrome'; browser_major: number }),
    lang: /^[a-z]{2,3}$/.test(lang) ? lang : 'en',
    tz,
    theme: theme === 'light' || theme === 'dark' ? theme : 'system',
    narrow: window.matchMedia('(max-width: 820px)').matches,
    runtime: '__TAURI_INTERNALS__' in window ? 'desktop' : 'browser',
  };
}

async function flush(keepalive = false) {
  if (!granted) return;
  const body: telemetry.TelemetryUiRequest = {};
  if (Object.keys(counters).length) body.counters = counters;
  if (firstUse.length) body.first_use = firstUse.slice(0, 20);
  if (funnel.length) body.funnel = funnel;
  if (exceptions.length) body.exceptions = exceptions.slice(0, 10);
  if (!envSent) body.env = env();
  if (!Object.keys(body).length) return;
  clear();
  envSent = true;
  try {
    await fetch('/api/v1/telemetry/ui', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive,
    });
  } catch {
    /* statistics never matter more than the app */
  }
}

/** Start once, from Runtime. Returns a stop. */
export function startTelemetry(): () => void {
  void refreshConsent();
  const offs: (() => void)[] = [];

  offs.push(
    useUi.subscribe((s, p) => {
      if (s.paletteOpen && !p.paletteOpen) track('palette');
      if (s.helpOpen && !p.helpOpen) track('help_open');
      if (s.focusMode !== p.focusMode) track('focus_mode');
      if (s.theme !== p.theme) track('theme_toggle');
      if (s.evidenceMessage && s.evidenceMessage !== p.evidenceMessage) track('evidence');
      if (s.viewer && s.viewer !== p.viewer) track('citation_open');
    }),
  );
  offs.push(
    usePrefs.subscribe((s, p) => {
      if (s.changedAt !== p.changedAt) track('settings_change');
    }),
  );
  offs.push(
    useHelp.subscribe((s, p) => {
      if (s.tour && !p.tour) track('tour_start');
      for (const [id, outcome] of Object.entries(s.tours))
        if (outcome === 'done' && p.tours[id] !== 'done') track('tour_finish');
      const steps = Object.entries(s.checklist).filter(([k, v]) => k !== 'dismissed' && v);
      const before = Object.entries(p.checklist).filter(([k, v]) => k !== 'dismissed' && v);
      if (steps.length > before.length) bump('f_checklist_step', steps.length - before.length);
      const all = (c: Record<string, unknown>) => STEPS.every((x) => c[x.id]);
      if (all(s.checklist) && !all(p.checklist)) step('checklist_done');
    }),
  );
  if (location.pathname.startsWith('/setup')) step('setup_opened');

  const onError = (e: ErrorEvent | PromiseRejectionEvent) => {
    const err = 'reason' in e ? e.reason : e.error;
    const kind = (err as { constructor?: { name?: string } } | undefined)?.constructor?.name ?? 'Error';
    if (granted && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(kind) && exceptions.length < 10) exceptions.push(kind);
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onError);
  const onHide = () => {
    if (document.visibilityState === 'hidden') void flush(true);
  };
  document.addEventListener('visibilitychange', onHide);
  const timer = setInterval(() => void flush(), 60_000);

  return () => {
    for (const off of offs) off();
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onError);
    document.removeEventListener('visibilitychange', onHide);
    clearInterval(timer);
  };
}
