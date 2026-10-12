/**
 * ------------------------------------------------------------------
 *  Title    |  Stay at the bottom when the list gets shorter
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A notice above the composer (a moved folder, a plan
 *           |  limit) makes the message list shorter. While you were
 *           |  at the bottom, the list stays there, so the notice
 *           |  never covers the last lines of the answer.
 *  How      |  A ResizeObserver on the scroller: when its height
 *           |  drops and you were following, scroll to the end.
 * ------------------------------------------------------------------
 */

/** Watch `el`; returns the function that stops watching. */
export function stayAtBottomOnShrink(el: HTMLElement, following: () => boolean): () => void {
  if (typeof ResizeObserver === 'undefined') return () => undefined;
  let height = el.clientHeight;
  const ro = new ResizeObserver(() => {
    const shorter = el.clientHeight < height;
    height = el.clientHeight;
    if (shorter && following()) el.scrollTop = el.scrollHeight;
  });
  ro.observe(el);
  return () => ro.disconnect();
}
