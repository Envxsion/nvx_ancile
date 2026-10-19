/**
 * ------------------------------------------------------------------
 *  Title    |  Palette shortcuts
 *  Ref      |  ROADMAP P1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Ctrl+K (and the model switcher and search keys) open
 *           |  the palette from the first paint.
 *  How      |  The palette's code loads after the shell, so the keys
 *           |  are bound here, in the shell, and only set its state
 *           |  in the store. A press before the chunk arrives is not
 *           |  lost: the palette mounts already open. Keep this file
 *           |  free of imports from the palette itself.
 * ------------------------------------------------------------------
 */

import { useBinding } from '../keys/dispatch';
import { useUi } from '../state/ui';

export function usePaletteShortcuts(): void {
  useBinding('palette.open', () => {
    const ui = useUi.getState();
    if (ui.paletteOpen) ui.closePalette();
    else ui.openPalette();
  });
  useBinding('model.switch', () => useUi.getState().openPalette('models'));
  useBinding('search.focus', () => useUi.getState().openPalette('all'));
}
