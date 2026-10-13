/**
 * ------------------------------------------------------------------
 *  Title    |  Appearance preferences on the document
 *  ID       |  aperture
 * ------------------------------------------------------------------
 *  Purpose  |  Turn a person's appearance choices into attributes and
 *           |  custom properties on <html> (prefs.css reads them), and
 *           |  replay the last applied set before first paint so a
 *           |  reload never flashes the defaults.
 *  How      |  applyLook() writes the DOM and stores the resolved
 *           |  {attrs, vars} under LOOK_KEY. BOOT_SCRIPT (theme.ts)
 *           |  copies them back in <head>, before any CSS paints.
 *  Note     |  Kept free of the contracts package: the Cockpit maps its
 *           |  Preferences onto a Look.
 * ------------------------------------------------------------------
 */

export const LOOK_KEY = 'nvx.ancile.look';

export interface Look {
  contrast: 'standard' | 'high';
  accent: string;
  tint: string;
  gilt: 'on' | 'subtle' | 'off';
  material: 'glass' | 'solid';
  grain: boolean;
  mark: 'full' | 'status' | 'still';
  font: 'archivo' | 'system';
  mono: 'martian' | 'system';
  width: number;
  corners: 'rounded' | 'sharp';
  zoom: number;
  density: 'compact' | 'comfortable' | 'spacious';
  /** Resolved: the OS setting already folded in. */
  motion: 'full' | 'reduced';
  transparency: 'full' | 'reduced';
  focus: 'standard' | 'thick';
  links: 'plain' | 'underline';
  targets: 'standard' | 'large';
  readSize: number;
  lineHeight: number;
  /** In ch, or 0 for the full column. */
  readWidth: number;
  codeSize: number;
  fx: 'full' | 'lite';
}

export interface ResolvedLook {
  attrs: Record<string, string>;
  vars: Record<string, string>;
}

export function resolveLook(l: Look): ResolvedLook {
  return {
    attrs: {
      contrast: l.contrast,
      accent: l.accent,
      tint: l.tint,
      gilt: l.gilt,
      material: l.transparency === 'reduced' ? 'solid' : l.material,
      grain: l.grain && l.transparency !== 'reduced' ? 'on' : 'off',
      markAnim: l.mark,
      font: l.font,
      mono: l.mono,
      corners: l.corners,
      density: l.density,
      motion: l.motion,
      focus: l.focus,
      links: l.links,
      targets: l.targets,
      fx: l.fx,
    },
    vars: {
      '--wdth': String(l.width),
      '--ui-zoom': String(l.zoom),
      '--read-size': `${l.readSize}px`,
      '--lh-read': String(l.lineHeight),
      '--measure': l.readWidth > 0 ? `${l.readWidth}ch` : '100%',
      '--code-size': `${l.codeSize}px`,
    },
  };
}

let stored = '';

/**
 * Write only what changed. A slider sends a value per pixel dragged, and
 * rewriting all sixteen attributes each time made the browser restyle the
 * whole document sixteen times over: text size stuttered while you dragged.
 */
export function applyLook(l: Look): void {
  const r = resolveLook(l);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(r.attrs)) if (root.dataset[k] !== v) root.dataset[k] = v;
  for (const [k, v] of Object.entries(r.vars))
    if (root.style.getPropertyValue(k) !== v) root.style.setProperty(k, v);
  const json = JSON.stringify(r);
  if (json === stored) return;
  stored = json;
  try {
    localStorage.setItem(LOOK_KEY, json);
  } catch {
    /* private mode: this tab only */
  }
}
