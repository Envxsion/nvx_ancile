/**
 * ------------------------------------------------------------------
 *  Title    |  Build info
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The version this Cockpit was built as, for the debug
 *           |  info an error copies, never written into the code.
 *  How      |  Vite replaces __ANCILE_VERSION__ with package.json's
 *           |  version (vite.config.ts); tests use a fixed one.
 * ------------------------------------------------------------------
 */

declare const __ANCILE_VERSION__: string | undefined;

export const COCKPIT_VERSION: string =
  typeof __ANCILE_VERSION__ !== 'undefined' && __ANCILE_VERSION__ ? __ANCILE_VERSION__ : '0.0.0-dev';
