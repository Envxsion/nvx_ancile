/**
 * ------------------------------------------------------------------
 *  Title    |  Palette shortcuts
 *  Ref      |  ROADMAP P1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Ctrl+K must work from the first paint, before the
 *           |  palette's own chunk has loaded.
 * ------------------------------------------------------------------
 */

import { fireEvent, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { installKeys } from '../src/keys/dispatch';
import { usePaletteShortcuts } from '../src/palette/shortcuts';
import { useUi } from '../src/state/ui';

function Shell() {
  useEffect(() => installKeys(), []);
  usePaletteShortcuts();
  return null;
}

afterEach(() => useUi.getState().closePalette());

describe('the palette shortcuts in the shell', () => {
  it('Ctrl+K opens and closes it with nothing from the palette loaded', () => {
    render(<Shell />);
    expect(useUi.getState().paletteOpen).toBe(false);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(useUi.getState().paletteOpen).toBe(true);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(useUi.getState().paletteOpen).toBe(false);
  });

  it('M opens it on models, and / opens it to search', () => {
    render(<Shell />);
    fireEvent.keyDown(window, { key: 'm' });
    expect(useUi.getState().paletteOpen).toBe(true);
    expect(useUi.getState().paletteScope).toBe('models');
    useUi.getState().closePalette();
    fireEvent.keyDown(window, { key: '/' });
    expect(useUi.getState().paletteScope).toBe('all');
    expect(useUi.getState().paletteOpen).toBe(true);
  });
});
