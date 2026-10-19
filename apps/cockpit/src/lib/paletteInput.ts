/**
 * ------------------------------------------------------------------
 *  Title    |  The words typed in Ctrl+K, for panels beside the box
 *  Ref      |  roadmap TS1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A panel under the search box (the filters, and Pro's
 *           |  search of tool outputs, notes and claims) needs the
 *           |  words typed, and a saved search needs to put words
 *           |  back, without the palette handing them down.
 *  How      |  Reads the palette's own input (cmdk marks it with
 *           |  cmdk-input) while the panel is on screen, and asks the
 *           |  palette to reopen with the words through the UI store,
 *           |  which is how every other part of the app opens it.
 * ------------------------------------------------------------------
 */

import { useEffect, useState } from 'react';
import { useUi } from '../state/ui';

const box = (): HTMLInputElement | null => document.querySelector<HTMLInputElement>('input[cmdk-input]');

/** What is typed in the palette now. Empty when the box is not on the page. */
export function usePaletteText(): string {
  const [text, setText] = useState(() => box()?.value ?? '');
  useEffect(() => {
    const read = () => setText(box()?.value ?? '');
    read();
    // The palette sets its box from state (no input event), so look again now and then as well as on typing.
    const timer = setInterval(read, 250);
    document.addEventListener('input', read, true);
    return () => {
      clearInterval(timer);
      document.removeEventListener('input', read, true);
    };
  }, []);
  return text;
}

/** Put words in the palette's box, whatever it held: clear first so the same words still count as a change. */
export function setPaletteText(text: string): void {
  useUi.getState().openPalette('all', '');
  setTimeout(() => useUi.getState().openPalette('all', text), 0);
}
