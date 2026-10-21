/**
 * ------------------------------------------------------------------
 *  Title    |  Tour events
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The one small thing the rest of the app needs from the
 *           |  tours: a way to say "this real action just happened",
 *           |  so a waiting tour step moves on.
 *  How      |  tourEvent(name) dispatches a window event the tour
 *           |  overlay listens for. Kept apart from the tour text
 *           |  (help/tours.ts) so the stores and screens that call it
 *           |  do not pull every tour into the first download.
 * ------------------------------------------------------------------
 */

export type TourEvent =
  | 'sent'
  | 'model-changed'
  | 'palette-opened'
  | 'notebook-created'
  | 'source-added'
  | 'citation-opened'
  | 'approval-opened'
  | 'shortcuts-opened'
  | 'branched';

/** Called where the real action happens, so a waiting tour step moves on. */
export function tourEvent(name: TourEvent): void {
  window.dispatchEvent(new CustomEvent(`ancile:tour:${name}`));
}
