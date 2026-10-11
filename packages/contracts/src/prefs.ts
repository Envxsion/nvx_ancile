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
  grain: z.boolean().default(true),
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
  drawerTab: z.enum(['sources', 'tree', 'why', 'evidence', 'notes']).default('sources'),
  drawerWidth: z.number().int().min(280).max(560).default(380),
  railWidth: z.number().int().min(200).max(360).default(248),
  status: z
    .object({
      model: z.boolean().default(true),
      context: z.boolean().default(true),
      node: z.boolean().default(true),
      approvals: z.boolean().default(true),
      health: z.boolean().default(true),
      clock: z.boolean().default(false),
    })
    .default({ model: true, context: true, node: true, approvals: true, health: true, clock: false }),
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

export const NotifyCategory = z.enum(['toast', 'centre', 'off']);

export const NotificationPrefs = z.object({
  position: z.enum(['bottom-right', 'top-right', 'bottom-centre']).default('bottom-right'),
  durationMs: z.number().int().min(2000).max(60_000).nullable().default(5000),
  maxStacked: z.number().int().min(1).max(6).default(3),
  sound: z.boolean().default(false),
  categories: z
    .object({
      approvals: NotifyCategory.default('toast'),
      runs: NotifyCategory.default('toast'),
      sources: NotifyCategory.default('toast'),
      health: NotifyCategory.default('toast'),
      memory: NotifyCategory.default('centre'),
    })
    .default({ approvals: 'toast', runs: 'toast', sources: 'toast', health: 'toast', memory: 'centre' }),
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
  /** Keep the try-out models in the switcher after a real model is ready. */
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

/** Help and onboarding progress, kept beside preferences. */
export const HelpProgress = z.object({
  tours: z.record(z.string(), z.enum(['done', 'skipped'])).default({}),
  checklist: z.record(z.string(), z.boolean()).default({}),
  hintsSeen: z.array(z.string()).max(500).default([]),
  lastSeenVersion: z.string().nullable().default(null),
});
export type HelpProgress = z.infer<typeof HelpProgress>;
