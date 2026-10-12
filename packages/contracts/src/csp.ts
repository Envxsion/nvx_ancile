/**
 * ------------------------------------------------------------------
 *  Title    |  Content Security Policy
 *  Ref      |  docs/desktop.md (Content Security Policy) · docs/artifacts.md
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  One policy for the Cockpit window, wherever it is
 *           |  served from: the dev server, Core in production, the
 *           |  desktop app's window (which loads Core). And the policy
 *           |  of the frame host, the one empty page that sandboxed
 *           |  artifacts and the Python sandbox are written into.
 *  How      |  The Cockpit's policy is a <meta> in every HTML page the
 *           |  build emits (vite.config.ts writes it, with a hash for
 *           |  each inline script, so nothing inline runs unless it is
 *           |  ours). Core and the dev server add a header on top
 *           |  (policies only ever add up): frame-ancestors, which a
 *           |  <meta> cannot carry, and frame-src narrowed from the
 *           |  whole origin to the frame host's exact URL.
 *  Note     |  Why a frame host and not srcdoc: a srcdoc (or data:,
 *           |  or blob:) frame inherits its parent's policy, so a
 *           |  strict script-src here would stop every artifact. The
 *           |  frame host is fetched, so it has its own policy; the
 *           |  content still never comes from Core: it arrives by
 *           |  postMessage and is written into the opaque frame.
 * ------------------------------------------------------------------
 */

/** The empty page artifacts and the Python sandbox are written into (apps/cockpit/public). */
export const FRAME_HOST_PATH = '/frame.html';
/** The postMessage channel between a frame host and the window that fills it. */
export const FRAME_HOST_CHANNEL = 'nvx-ancile-frame';

/**
 * The Cockpit's directives. Each exception is explained in docs/desktop.md.
 * script-src gets the inline scripts' hashes added when the page is built.
 */
export const COCKPIT_CSP: Readonly<Record<string, readonly string[]>> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  // Runtime <style> elements: a person's own CSS (Settings → Advanced),
  // Radix's scroll lock, the dev server's CSS. Styles cannot reach the
  // network past img-src and font-src below.
  'style-src': ["'self'", "'unsafe-inline'"],
  // https: only for a picture in an answer the person chose to load (SafeImage).
  'img-src': ["'self'", 'data:', 'blob:', 'https:'],
  // data: for the fonts pdf.js embeds from a PDF.
  'font-src': ["'self'", 'data:'],
  // Core is this origin: REST, SSE and, in development, the dev server's socket.
  'connect-src': ["'self'"],
  // pdf.js's worker, from this origin.
  'worker-src': ["'self'"],
  // The frame host only (narrowed to its exact URL by the header).
  'frame-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
};

/** The Cockpit's policy as one string, with the page's inline-script hashes ('sha256-…'). */
export function cockpitCsp(scriptHashes: readonly string[] = []): string {
  return Object.entries(COCKPIT_CSP)
    .map(([k, v]) => [k, ...v, ...(k === 'script-src' ? scriptHashes.map((h) => `'${h}'`) : [])].join(' '))
    .join('; ');
}

/**
 * The frame host's own policy: the widest any document written into it
 * may need (React artifacts eval, Python needs WebAssembly and a Blob
 * worker, an artifact the person let online may use https:). Each
 * document carries its own narrower policy first in its <head>, and
 * policies only add up, so the narrower one is what holds.
 */
export const FRAME_HOST_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: https:",
  "style-src 'unsafe-inline' https:",
  'img-src data: blob: https:',
  'font-src data: https:',
  'media-src data: blob: https:',
  'connect-src https:',
  'worker-src blob:',
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * The header Core (and the dev server) adds to a page. `host` is the
 * request's Host header: the address the browser used, so the frame host
 * URL matches it exactly (an http source also matches the same host over
 * https, for a Cockpit behind a TLS proxy).
 */
export function cockpitHeaderCsp(path: string, host: string | undefined): string | null {
  if (path === FRAME_HOST_PATH) return 'sandbox allow-scripts';
  const frame = host && /^[A-Za-z0-9.:[\]-]+$/.test(host) ? `http://${host}${FRAME_HOST_PATH}` : "'none'";
  return `frame-ancestors 'none'; frame-src ${frame}`;
}
