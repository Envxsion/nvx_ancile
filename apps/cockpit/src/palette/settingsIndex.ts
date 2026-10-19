/**
 * ------------------------------------------------------------------
 *  Title    |  Settings the palette can change in place
 *  Ref      |  ROADMAP KP1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Every settings result in the palette, and for the on
 *           |  or off and the pick-one settings, what it takes to
 *           |  change them right there: Enter flips or steps to the
 *           |  next choice, and the action panel (Tab) lists every
 *           |  choice with a live preview while you move over them.
 *  How      |  Pure data over the preferences schema. A toggle reads
 *           |  and writes one boolean; a choice reads one value and
 *           |  names the rest. Everything else (zoom, panel widths,
 *           |  shortcuts, custom CSS) still opens its Settings page,
 *           |  because it needs more than one control.
 *  Note     |  The Settings page stays the source of truth: both
 *           |  write through usePrefs.set, so they never disagree.
 *           |  Labels are plain sentence case; a choice's words are
 *           |  the ones its Settings row uses.
 * ------------------------------------------------------------------
 */

import type { Preferences, PrefGroup } from '@nvx/contracts';
import { ACCENTS } from '@nvx/contracts/prefs';

export interface Choice {
  value: string;
  label: string;
}

interface Base {
  /** Stable id, also the palette item's value. */
  key: string;
  label: string;
  group: string;
  words: string;
}

export interface Toggle extends Base {
  kind: 'toggle';
  prefGroup: PrefGroup;
  /** The preference key inside its group. */
  pref: string;
  /** The words for each state, shown beside the row. */
  on?: string;
  off?: string;
}

export interface Pick extends Base {
  kind: 'choice';
  prefGroup: PrefGroup;
  pref: string;
  options: Choice[];
}

export interface Opens extends Base {
  kind: 'opens';
}

export type SettingDef = Toggle | Pick | Opens;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const choices = (values: readonly string[], labels: Record<string, string> = {}): Choice[] =>
  values.map((v) => ({ value: v, label: labels[v] ?? cap(v) }));

export const SETTINGS_INDEX: SettingDef[] = [
  {
    key: 'theme',
    kind: 'choice',
    label: 'Theme',
    group: 'appearance',
    words: 'dark light system mode',
    prefGroup: 'appearance',
    pref: 'theme',
    options: choices(['system', 'dark', 'light']),
  },
  {
    key: 'accent',
    kind: 'choice',
    label: 'Accent colour',
    group: 'appearance',
    words: 'colour color signal violet iris rose jade',
    prefGroup: 'appearance',
    pref: 'accent',
    options: choices(ACCENTS),
  },
  {
    key: 'tint',
    kind: 'choice',
    label: 'Ground tint',
    group: 'appearance',
    words: 'graphite ink obsidian background',
    prefGroup: 'appearance',
    pref: 'tint',
    options: choices(['graphite', 'ink', 'obsidian']),
  },
  {
    key: 'contrast',
    kind: 'choice',
    label: 'Contrast',
    group: 'appearance',
    words: 'high contrast accessibility',
    prefGroup: 'appearance',
    pref: 'contrast',
    options: choices(['standard', 'high']),
  },
  {
    key: 'material',
    kind: 'choice',
    label: 'Glass or solid surfaces',
    group: 'appearance',
    words: 'blur transparency material',
    prefGroup: 'appearance',
    pref: 'material',
    options: choices(['glass', 'solid']),
  },
  {
    key: 'grain',
    kind: 'toggle',
    label: 'Film grain',
    group: 'appearance',
    words: 'noise texture',
    prefGroup: 'appearance',
    pref: 'grain',
  },
  {
    key: 'gilt',
    kind: 'choice',
    label: 'Gilt details',
    group: 'appearance',
    words: 'gold brass',
    prefGroup: 'appearance',
    pref: 'gilt',
    options: choices(['on', 'subtle', 'off']),
  },
  {
    key: 'corners',
    kind: 'choice',
    label: 'Corners',
    group: 'appearance',
    words: 'radius sharp rounded',
    prefGroup: 'appearance',
    pref: 'corners',
    options: choices(['rounded', 'sharp']),
  },
  {
    key: 'font',
    kind: 'choice',
    label: 'Interface font',
    group: 'appearance',
    words: 'archivo system typeface',
    prefGroup: 'appearance',
    pref: 'font',
    options: choices(['archivo', 'system'], { archivo: 'Archivo', system: 'System' }),
  },
  { key: 'zoom', kind: 'opens', label: 'Zoom', group: 'appearance', words: 'scale size bigger smaller' },
  {
    key: 'density',
    kind: 'choice',
    label: 'Density',
    group: 'layout',
    words: 'compact comfortable spacious',
    prefGroup: 'layout',
    pref: 'density',
    options: choices(['compact', 'comfortable', 'spacious']),
  },
  {
    key: 'presentation',
    kind: 'toggle',
    label: 'Presentation mode',
    group: 'layout',
    words: 'screen share hide private starters demo',
    prefGroup: 'layout',
    pref: 'presentation',
  },
  {
    key: 'widths',
    kind: 'opens',
    label: 'Sidebar and panel widths',
    group: 'layout',
    words: 'rail drawer width',
  },
  { key: 'status', kind: 'opens', label: 'Status bar items', group: 'layout', words: 'footer bar' },
  { key: 'text-size', kind: 'opens', label: 'Text size', group: 'reading', words: 'font size reading' },
  {
    key: 'line-height',
    kind: 'choice',
    label: 'Line spacing',
    group: 'reading',
    words: 'leading line height',
    prefGroup: 'reading',
    pref: 'lineHeight',
    options: choices(['tight', 'normal', 'loose']),
  },
  {
    key: 'reading-width',
    kind: 'choice',
    label: 'Reading width',
    group: 'reading',
    words: 'measure column',
    prefGroup: 'reading',
    pref: 'width',
    options: choices(['narrow', 'normal', 'wide', 'full']),
  },
  {
    key: 'citations',
    kind: 'choice',
    label: 'Citations style',
    group: 'reading',
    words: 'footnote superscript',
    prefGroup: 'reading',
    pref: 'citations',
    options: choices(['inline', 'superscript', 'hover']),
  },
  {
    key: 'send',
    kind: 'choice',
    label: 'Send with Enter or Ctrl Enter',
    group: 'composer',
    words: 'send key newline',
    prefGroup: 'composer',
    pref: 'send',
    options: [
      { value: 'enter', label: 'Enter' },
      { value: 'mod-enter', label: 'Ctrl or Cmd Enter' },
    ],
  },
  { key: 'snippets', kind: 'opens', label: 'Snippets', group: 'composer', words: 'abbreviation template' },
  {
    key: 'shortcut',
    kind: 'opens',
    label: 'Change a shortcut',
    group: 'keyboard',
    words: 'keys rebind shortcuts',
  },
  {
    key: 'toasts',
    kind: 'opens',
    label: 'Toasts',
    group: 'notifications',
    words: 'notification position duration',
  },
  {
    key: 'motion',
    kind: 'choice',
    label: 'Motion',
    group: 'accessibility',
    words: 'reduce animation',
    prefGroup: 'accessibility',
    pref: 'motion',
    options: choices(['system', 'reduced', 'full']),
  },
  {
    key: 'large-targets',
    kind: 'toggle',
    label: 'Larger buttons',
    group: 'accessibility',
    words: 'touch targets',
    prefGroup: 'accessibility',
    pref: 'largeTargets',
  },
  {
    key: 'underline-links',
    kind: 'toggle',
    label: 'Underline links',
    group: 'accessibility',
    words: 'links underline accessibility',
    prefGroup: 'accessibility',
    pref: 'underlineLinks',
  },
  {
    key: 'hints',
    kind: 'toggle',
    label: 'Help hints',
    group: 'advanced',
    words: 'tips help question mark',
    prefGroup: 'advanced',
    pref: 'hints',
  },
  {
    key: 'developer',
    kind: 'toggle',
    label: 'Developer details',
    group: 'advanced',
    words: 'debug trace json',
    prefGroup: 'advanced',
    pref: 'developer',
  },
  { key: 'css', kind: 'opens', label: 'Custom CSS', group: 'advanced', words: 'style theme css' },
  {
    key: 'claude-code',
    kind: 'opens',
    label: 'Claude Code',
    group: 'claude-code',
    words: 'claude code install sign in sessions anthropic',
  },
  {
    key: 'claude-code-import',
    kind: 'opens',
    label: 'Bring Claude Code sessions in by themselves',
    group: 'claude-code',
    words: 'claude code import sessions automatic',
  },
  {
    key: 'effects',
    kind: 'choice',
    label: 'Effects and performance',
    group: 'advanced',
    words: 'lite blur performance',
    prefGroup: 'advanced',
    pref: 'performance',
    options: [
      { value: 'auto', label: 'Automatic' },
      { value: 'full', label: 'Always on' },
      { value: 'lite', label: 'Light' },
    ],
  },
  {
    key: 'ocr',
    kind: 'opens',
    label: 'Read scanned PDFs with OCR',
    group: 'sources',
    words: 'ocr scan scanned pdf text recognise',
  },
];

const read = (prefs: Preferences, def: Toggle | Pick): unknown =>
  (prefs[def.prefGroup] as unknown as Record<string, unknown>)[def.pref];

/** The current value of a toggle or a choice. */
export const currentOf = (prefs: Preferences, def: Toggle | Pick): unknown => read(prefs, def);

/** The state in words, for the chip beside the row: "On", "Off", "Dark". */
export function stateWords(prefs: Preferences, def: SettingDef): string | null {
  if (def.kind === 'opens') return null;
  const v = read(prefs, def);
  if (def.kind === 'toggle') return v ? (def.on ?? 'On') : (def.off ?? 'Off');
  return def.options.find((o) => o.value === v)?.label ?? String(v);
}

/** What Enter does: flip a toggle, or step to the next choice (after the last, the first). */
export function nextState(
  prefs: Preferences,
  def: Toggle | Pick,
): { group: PrefGroup; patch: Record<string, unknown> } {
  const v = read(prefs, def);
  if (def.kind === 'toggle') return { group: def.prefGroup, patch: { [def.pref]: !v } };
  const i = def.options.findIndex((o) => o.value === v);
  const next = def.options[(i + 1) % def.options.length] as Choice;
  return { group: def.prefGroup, patch: { [def.pref]: next.value } };
}

/** A sentence for a screen reader after a change: "Film grain on." */
export function announceChange(def: Toggle | Pick, prefs: Preferences): string {
  return `${def.label}: ${stateWords(prefs, def)?.toLowerCase()}.`;
}

export const settingByKey = (key: string): SettingDef | undefined =>
  SETTINGS_INDEX.find((s) => s.key === key);
