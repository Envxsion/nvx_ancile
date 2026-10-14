/**
 * What Pro's screen tests (pro/cockpit/test, a private submodule) need from
 * the Cockpit: Testing Library, Vitest and the kit the Cockpit lends Pro.
 * They resolve from here, so pro/ needs no node_modules of its own. Holds no
 * Pro code; a public clone simply never imports it.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';

export { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
export { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
export { api } from '../src/lib/api';
export { queryClient } from '../src/lib/query';
export { proKit } from '../src/pro/slot';
export { usePrefs } from '../src/state/prefs';

import { queryClient } from '../src/lib/query';

/** Render inside the providers every Cockpit screen has. */
export function renderPro(ui: ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );
}
