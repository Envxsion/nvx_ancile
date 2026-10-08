/**
 * ------------------------------------------------------------------
 *  Title    |  Cockpit entry
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Load the family tokens, then Ancile's identity, then the
 *           |  app styles, in that order: identity overrides only the
 *           |  accent and the mark (DESIGN.md §13, ancile.css). Then
 *           |  the preference layer (prefs.css), which every setting
 *           |  drives through attributes on <html>.
 * ------------------------------------------------------------------
 */

import '@nvx/aperture/tokens.css';
import '@nvx/aperture/ancile.css';
import '@nvx/aperture/prefs.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/thread.css';
import './styles/overlays.css';
import './styles/pages.css';
import './styles/kit.css';
import './styles/composer.css';
import './styles/spaces.css';
import './styles/memory.css';
import './styles/models.css';
import './styles/trust.css';
import './styles/branching.css';
import './styles/compute.css';
import './styles/ops.css';
import './styles/repos.css';

import { TooltipProvider } from '@radix-ui/react-tooltip';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { RouterProvider } from '@tanstack/react-router';
import { MotionConfig } from 'motion/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CACHE_BUSTER, persister, queryClient } from './lib/query';
import { router } from './router';
import { useUi } from './state/ui';

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');

createRoot(root).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        buster: CACHE_BUSTER,
        maxAge: 1000 * 60 * 60 * 24 * 7,
        // The sample workspace is never remembered as if it were yours.
        dehydrateOptions: {
          shouldDehydrateQuery: (q) => q.state.status === 'success' && !useUi.getState().demo,
        },
      }}
    >
      <MotionConfig reducedMotion="user">
        <TooltipProvider delayDuration={350} skipDelayDuration={200}>
          <RouterProvider router={router} />
        </TooltipProvider>
      </MotionConfig>
    </PersistQueryClientProvider>
  </StrictMode>,
);
