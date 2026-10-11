/**
 * ------------------------------------------------------------------
 *  Title    |  Runtime
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Whether the Cockpit runs inside the NVX Ancile desktop
 *           |  app or in a browser tab. The desktop app has no browser
 *           |  around it, so every shortcut reaches the page and the
 *           |  "your browser kept this key" notes do not apply.
 *  How      |  The desktop shell sets window.__NVX_DESKTOP__ before
 *           |  any page script runs (apps/desktop/src-tauri/src/main.rs).
 *           |  The Cockpit is a remote page to it and has no native
 *           |  APIs; this flag is all it gets.
 * ------------------------------------------------------------------
 */

declare global {
  interface Window {
    __NVX_DESKTOP__?: { version: string };
  }
}

export const isDesktop = (): boolean => typeof window !== 'undefined' && !!window.__NVX_DESKTOP__;

/**
 * How to get Core running again, in words that fit how NVX Ancile was
 * started: the desktop app has no terminal, a source checkout does.
 */
export const startCoreHint = (): string =>
  isDesktop() ? 'Quit NVX Ancile from its tray icon and open it again.' : 'Start NVX Ancile with pnpm start.';

/** Mark the document so styles can follow (html[data-runtime="desktop"]). */
export function markRuntime(): void {
  document.documentElement.dataset.runtime = isDesktop() ? 'desktop' : 'browser';
}
