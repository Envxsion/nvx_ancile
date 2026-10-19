/**
 * ------------------------------------------------------------------
 *  Title    |  Preferences
 *  Ref      |  DESIGN.md §13.7 · DESIGN-UI.md §4
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  Every setting a person can change, with the default
 *           |  that is right for most people. One schema for the
 *           |  Settings screen, the server copy (ui-state "prefs"),
 *           |  and the exported ancile-settings.json.
 *  How      |  Each group is .default()ed field by field, so an older
 *           |  file or a partial import parses to a complete object.
 *           |  Unknown keys are dropped, never fatal, so a setting
 *           |  that is removed (composer.grounded) simply falls away.
 * ------------------------------------------------------------------
 */
import { z } from 'zod';

export const ACCENTS = ['ultraviolet', 'iris', 'orchid', 'rose', 'ember', 'jade', 'graphite'] as const;

export const AppearancePrefs = z.object({
  theme: z.enum(['system', 'dark', 'light']).default('system'),
  contrast: z.enum(['standard', 'high']).default('standard'),
  accent: z.enum(ACCENTS).default('ultraviolet'),
  tint: z.enum(['graphite', 'ink', 'obsidian']).default('graphite'),
  gilt: z.enum(['on', 'subtle', 'off']).default('on'),
  material: z.enum(['glass', 'solid']).default('glass'),
  /** Off by default: a texture some like, not part of the look everyone gets. */
  grain: z.boolean().default(false),
  mark: z.enum(['full', 'status', 'still']).default('full'),
  font: z.enum(['archivo', 'system']).default('archivo'),
  /** Archivo's width axis: 88 narrow, 100, 112 wide. */
  width: z.number().int().min(80).max(120).default(100),
  mono: z.enum(['martian', 'system']).default('martian'),
  corners: z.enum(['rounded', 'sharp']).default('rounded'),
  /** Whole-interface zoom, 0.8 to 1.4. */
  zoom: z.number().min(0.8).max(1.4).default(1),
});

export const LayoutPrefs = z.object({
  density: z.enum(['compact', 'comfortable', 'spacious']).default('comfortable'),
  rail: z.enum(['expanded', 'hidden']).default('expanded'),
  // 'why' was a tab until the answer's receipt replaced it (WY1): a saved choice of it opens Sources.
  drawerTab: z
    .preprocess((v) => (v === 'why' ? 'sources' : v), z.enum(['sources', 'tree', 'evidence', 'notes']))
    .default('sources'),
  drawerWidth: z.number().int().min(280).max(560).default(380),
  railWidth: z.number().int().min(200).max(360).default(248),
  status: z
    .object({
      model: z.boolean().default(true),
      context: z.boolean().default(true),
      /** Claude Code's plan limits (or Usage), opening Settings → Usage. */
      usage: z.boolean().default(true),
      node: z.boolean().default(true),
      approvals: z.boolean().default(true),
      health: z.boolean().default(true),
      clock: z.boolean().default(false),
    })
    .default({
      model: true,
      context: true,
      usage: true,
      node: true,
      approvals: true,
      health: true,
      clock: false,
    }),
});

export const ReadingPrefs = z.object({
  size: z.number().min(13).max(20).default(15.5),
  lineHeight: z.enum(['tight', 'normal', 'loose']).default('normal'),
  width: z.enum(['narrow', 'normal', 'wide', 'full']).default('normal'),
  codeSize: z.number().min(11).max(17).default(13),
  citations: z.enum(['inline', 'superscript', 'hover']).default('inline'),
  cost: z.boolean().default(true),
  timestamps: z.enum(['relative', 'absolute', 'hidden']).default('relative'),
  /** Tool steps start folded to one line. */
  collapseTools: z.boolean().default(true),
  /** "live" shows the answer as it is written; "whole" waits and shows it finished.
   *  Older files said smooth or raw: both read as live. */
  streaming: z.enum(['live', 'whole']).catch('live'),
});

export const Snippet = z.object({
  trigger: z.string().regex(/^;[a-z0-9-]{1,24}$/),
  text: z.string().max(20_000),
});

export const ComposerPrefs = z.object({
  send: z.enum(['enter', 'mod-enter']).default('enter'),
  spellcheck: z.boolean().default(true),
  pastePlain: z.boolean().default(false),
  menus: z.boolean().default(true),
  snippets: z.array(Snippet).max(200).default([]),
});

export const KeyboardPrefs = z.object({
  singleKeys: z.boolean().default(true),
  hintFlash: z.boolean().default(true),
  sequenceMs: z.number().int().min(300).max(2000).default(800),
  /** binding id → key string, e.g. { "palette.open": "mod+p" }. */
  overrides: z.record(z.string(), z.string()).default({}),
  /** Move the few defaults a browser keeps (Opera): auto turns it on where needed. */
  browserSafe: z.enum(['auto', 'on', 'off']).default('auto'),
});

/**
 * toast: pops up in the app. centre: only the notification centre. off: nothing.
 * desktop: pops up in the app, and also reaches you outside it (a native
 * notification in the desktop app, a browser notification in a tab) while
 * NVX Ancile is not the window in front.
 */
export const NotifyCategory = z.enum(['desktop', 'toast', 'centre', 'off']);

export const NotificationPrefs = z.object({
  position: z.enum(['bottom-right', 'top-right', 'bottom-centre']).default('bottom-right'),
  durationMs: z.number().int().min(2000).max(60_000).nullable().default(5000),
  maxStacked: z.number().int().min(1).max(6).default(3),
  sound: z.boolean().default(false),
  categories: z
    .object({
      approvals: NotifyCategory.default('desktop'),
      runs: NotifyCategory.default('desktop'),
      sources: NotifyCategory.default('toast'),
      health: NotifyCategory.default('toast'),
      memory: NotifyCategory.default('centre'),
    })
    .default({ approvals: 'desktop', runs: 'desktop', sources: 'toast', health: 'toast', memory: 'centre' }),
});

export const AccessibilityPrefs = z.object({
  motion: z.enum(['system', 'reduced', 'full']).default('system'),
  transparency: z.enum(['system', 'reduced']).default('system'),
  focus: z.enum(['standard', 'thick']).default('standard'),
  underlineLinks: z.boolean().default(false),
  announce: z.enum(['sentences', 'paragraphs', 'off']).default('sentences'),
  largeTargets: z.boolean().default(false),
});

export const AdvancedPrefs = z.object({
  css: z.string().max(50_000).default(''),
  developer: z.boolean().default(false),
  performance: z.enum(['auto', 'full', 'lite']).default('auto'),
  hints: z.boolean().default(true),
  /** Keep the test models (no AI) in the switcher and pickers after a real model is ready. */
  tryoutModels: z.boolean().default(false),
});

export const Preferences = z.object({
  version: z.literal(1).default(1),
  appearance: AppearancePrefs.default(AppearancePrefs.parse({})),
  layout: LayoutPrefs.default(LayoutPrefs.parse({})),
  reading: ReadingPrefs.default(ReadingPrefs.parse({})),
  composer: ComposerPrefs.default(ComposerPrefs.parse({})),
  keyboard: KeyboardPrefs.default(KeyboardPrefs.parse({})),
  notifications: NotificationPrefs.default(NotificationPrefs.parse({})),
  accessibility: AccessibilityPrefs.default(AccessibilityPrefs.parse({})),
  advanced: AdvancedPrefs.default(AdvancedPrefs.parse({})),
});
export type Preferences = z.infer<typeof Preferences>;
export type PrefGroup = Exclude<keyof Preferences, 'version'>;

export const DEFAULT_PREFERENCES: Preferences = Preferences.parse({});

/**
 * Settings that belong to this device, not to you: they depend on its
 * screen, hardware or browser, or (custom CSS) could change how another
 * computer shows a permission request. They stay in this browser: never
 * sent to Core, synced to another computer, or written to an export.
 */
export const DEVICE_PREFS = {
  appearance: ['zoom'],
  layout: ['rail', 'railWidth', 'drawerWidth'],
  keyboard: ['browserSafe'],
  advanced: ['css', 'performance'],
} as const satisfies { [G in PrefGroup]?: readonly (keyof Preferences[G])[] };

type DeviceGroup = keyof typeof DEVICE_PREFS;
const deviceGroups = Object.keys(DEVICE_PREFS) as DeviceGroup[];

/** Whether one setting is device-only (DEVICE_PREFS). */
export function isDevicePref(group: string, key: string): boolean {
  const keys = (DEVICE_PREFS as Record<string, readonly string[]>)[group];
  return keys?.includes(key) ?? false;
}

/**
 * The preferences that may leave this device: every device-only setting
 * taken out. Accepts anything (an old server copy, an import) and never
 * throws; what is not an object is returned as it is.
 */
export function withoutDevicePrefs<T>(prefs: T): T {
  if (!prefs || typeof prefs !== 'object') return prefs;
  const out: Record<string, unknown> = { ...(prefs as Record<string, unknown>) };
  for (const g of deviceGroups) {
    const group = out[g];
    if (!group || typeof group !== 'object') continue;
    const copy = { ...(group as Record<string, unknown>) };
    for (const k of DEVICE_PREFS[g] as readonly string[]) delete copy[k];
    out[g] = copy;
  }
  return out as T;
}

/**
 * Preferences from somewhere else (Core's copy, another computer, a file),
 * with this device's own settings kept: nothing device-only is ever taken
 * from outside.
 */
export function keepDevicePrefs(incoming: Preferences, local: Preferences): Preferences {
  const out = { ...incoming } as Record<string, unknown>;
  for (const g of deviceGroups) {
    const keep: Record<string, unknown> = {};
    for (const k of DEVICE_PREFS[g] as readonly string[]) keep[k] = (local[g] as Record<string, unknown>)[k];
    out[g] = { ...(incoming[g] as Record<string, unknown>), ...keep };
  }
  return out as Preferences;
}

/** Help and onboarding progress, kept beside preferences. */
export const HelpProgress = z.object({
  tours: z.record(z.string(), z.enum(['done', 'skipped'])).default({}),
  checklist: z.record(z.string(), z.boolean()).default({}),
  hintsSeen: z.array(z.string()).max(500).default([]),
  lastSeenVersion: z.string().nullable().default(null),
});
export type HelpProgress = z.infer<typeof HelpProgress>;
