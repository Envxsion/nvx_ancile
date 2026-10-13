/**
 * ------------------------------------------------------------------
 *  Title    |  Links in answers
 *  Ref      |  apps/desktop/src-tauri/src/links.rs
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Say what a link does when clicked: an NVX Ancile page
 *           |  opens in the app, a web or mail link opens outside it,
 *           |  and any other scheme does nothing.
 *  How      |  classifyLink() is pure. External links carry
 *           |  target="_blank" rel="noopener noreferrer": a browser
 *           |  opens a tab, and the desktop shell's new-window handler
 *           |  hands them to the system browser.
 *  Note     |  The desktop shell applies the same rule again in Rust,
 *           |  so a link that slips past this file is still refused.
 * ------------------------------------------------------------------
 */

export type LinkKind =
  | { kind: 'internal'; to: string }
  | { kind: 'external'; href: string }
  | { kind: 'anchor'; href: string }
  | { kind: 'refused' };

const EXTERNAL = new Set(['http:', 'https:', 'mailto:']);

export function classifyLink(href: string | undefined | null, origin: string): LinkKind {
  const raw = (href ?? '').trim();
  if (!raw) return { kind: 'refused' };
  if (raw.startsWith('#')) return { kind: 'anchor', href: raw };
  // A path on this origin; "//host" is another site, not a path.
  // Core's own files (a source's original) open beside the app, not in it.
  if (raw.startsWith('/api/')) return { kind: 'external', href: raw };
  if (raw.startsWith('/') && !raw.startsWith('//')) return { kind: 'internal', to: raw };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'refused' };
  }
  if (!EXTERNAL.has(url.protocol)) return { kind: 'refused' };
  if (url.protocol !== 'mailto:' && url.origin === origin && !url.pathname.startsWith('/api/'))
    return { kind: 'internal', to: `${url.pathname}${url.search}${url.hash}` };
  return { kind: 'external', href: url.href };
}
