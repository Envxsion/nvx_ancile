/**
 * ------------------------------------------------------------------
 *  Title    |  Routes
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The URL is state: a thread, a notebook, an admin page
 *           |  can all be bookmarked and restored.
 *  How      |  TanStack Router, code-based tree (no codegen step).
 *           |  Hovering a link preloads its route ("intent").
 * ------------------------------------------------------------------
 */

import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';
import { AppShell } from './app/AppShell';
import { keyText } from './keys/registry';
import { AdminLayout, AdminSectionScreen } from './routes/admin/Admin';
import { HomeScreen } from './routes/Home';
import { NotebookScreen } from './routes/Notebook';
import { SetupScreen } from './routes/Setup';
import { SettingsScreen } from './routes/settings/Settings';
import { ThreadScreen } from './routes/Thread';
import { EmptyState } from './ui/primitives';

function NotFound() {
  return (
    <div className="page page--center">
      <EmptyState
        icon="search"
        title="Nothing lives at this address"
        body={`The link may be from an older version or another workspace. Press ${keyText('palette.open')} to find what you were after.`}
      />
    </div>
  );
}

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFound });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomeScreen,
  // ?notebook= starts the new thread inside that notebook ("New thread here").
  validateSearch: (s: Record<string, unknown>): { notebook?: string } =>
    typeof s.notebook === 'string' && s.notebook ? { notebook: s.notebook } : {},
});
const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/t/$threadId',
  component: ThreadScreen,
});
const notebookRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/n/$notebookId',
  component: NotebookScreen,
});
const setupRoute = createRoute({ getParentRoute: () => rootRoute, path: '/setup', component: SetupScreen });

// Flows (DESIGN.md §16): the editor and its canvas load on first visit.
const flowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/flows',
  component: lazyRouteComponent(() => import('./flows/FlowsPage'), 'FlowsScreen'),
});
const flowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/flows/$flowId',
  component: lazyRouteComponent(() => import('./flows/FlowsPage'), 'FlowEditorScreen'),
});
const notebookFlowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/n/$notebookId/flow',
  component: lazyRouteComponent(() => import('./flows/FlowsPage'), 'NotebookFlowScreen'),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  beforeLoad: () => {
    throw redirect({ to: '/settings/$group', params: { group: 'appearance' } });
  },
});
const settingsGroupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/$group',
  component: SettingsScreen,
});

const adminRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin', component: AdminLayout });
const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/admin/$section', params: { section: 'health' } });
  },
});
const adminSectionRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '$section',
  component: AdminSectionScreen,
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  threadRoute,
  notebookRoute,
  notebookFlowRoute,
  flowsRoute,
  flowRoute,
  setupRoute,
  settingsRoute,
  settingsGroupRoute,
  adminRoute.addChildren([adminIndexRoute, adminSectionRoute]),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent', scrollRestoration: false });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
