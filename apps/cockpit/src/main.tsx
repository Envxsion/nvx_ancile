/**
 * ------------------------------------------------------------------
 *  Title    |  Cockpit entry
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Load the family tokens, then Ancile's identity, then the
 *           |  app styles, in that order: identity overrides only the
 *           |  accent and the mark (DESIGN.md §13, ancile.css). Then
 *           |  the preference layer (prefs.css), which every setting
 *           |  drives through attributes on <html>, and the Pro layer
 *           |  (pro.css: the Pro palette and the gilt kit).
 * ------------------------------------------------------------------
 */

import './lib/strict';
import '@nvx/aperture/tokens.css';
import '@nvx/aperture/ancile.css';
import '@nvx/aperture/prefs.css';
import '@nvx/aperture/pro.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/thread.css';
import './styles/overlays.css';
import './styles/pages.css';
import './styles/kit.css';
import './styles/viewer.css';
import './styles/composer.css';
import './styles/spaces.css';
import './styles/memory.css';
import './styles/models.css';
import './styles/trust.css';
import './styles/branching.css';
import './styles/compute.css';
import './styles/ops.css';
import './styles/repos.css';
import './styles/engines.css';
import './styles/auto.css';
import './styles/code.css';
import './styles/artifacts.css';
import './styles/interpreter.css';
import './styles/images.css';
import './styles/receipt.css';

import { TooltipProvider } from '@radix-ui/react-tooltip';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StartupGate } from './app/StartupScreen';
import { MotionPrefs } from './lib/motion';
import { CACHE_BUSTER, persistable, persister, queryClient } from './lib/query';
import { markRuntime } from './lib/runtime';
import { router } from './router';
import { useUi } from './state/ui';

markRuntime();
// Dev only: the screenshot scripts (scripts/shoot-*.mjs) seed the stores to draw states demo data cannot reach.
if (import.meta.env.DEV)
  void Promise.all([
    import('./auto/store'),
    import('./editors/store'),
    import('./engines/notice'),
    import('./artifacts/store'),
    import('./code/store'),
  ]).then(([auto, editors, notice, artifacts, code]) => {
    (window as unknown as { __ancile: unknown }).__ancile = {
      queryClient,
      useUi,
      useAuto: auto.useAuto,
      openEditor: editors.openEditor,
      showContextNotice: notice.showContextNotice,
      openArtifact: artifacts.openArtifact,
      openFile: code.openFile,
    };
  });
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
          // Large and live queries stay out (lib/query.ts); what is kept is trimmed when written.
          shouldDehydrateQuery: (q) => persistable(q.queryKey, q.state.status) && !useUi.getState().demo,
        },
      }}
    >
      {/* Motion follows Settings → Accessibility → Motion, not only the OS. */}
      <MotionPrefs>
        <TooltipProvider delayDuration={350} skipDelayDuration={200}>
          {/* Core stopped before opening the database: its start-up screen instead of the app. */}
          <StartupGate>
            <RouterProvider router={router} />
          </StartupGate>
        </TooltipProvider>
      </MotionPrefs>
    </PersistQueryClientProvider>
  </StrictMode>,
);
