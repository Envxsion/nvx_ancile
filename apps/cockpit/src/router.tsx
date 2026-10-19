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
  type RouterHistory,
  redirect,
} from '@tanstack/react-router';
import { AppShell } from './app/AppShell';
import { keyText } from './keys/registry';
import { loadNotebook, loadThread, PRELOAD_DELAY_MS } from './lib/prefetch';
import { HomeScreen } from './routes/Home';
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
  // Runs for a link only once it has been hovered or focused for PRELOAD_DELAY_MS (lib/prefetch.ts);
  // returns at once, so opening the thread never waits for it.
  loader: loadThread,
});
const notebookRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/n/$notebookId',
  component: lazyRouteComponent(() => import('./routes/Notebook'), 'NotebookScreen'),
  loader: loadNotebook,
});
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  component: lazyRouteComponent(() => import('./routes/Setup'), 'SetupScreen'),
});

// Where an ancile:// link lands (desktop/OpenScreens.tsx). Each only opens a place.
const openApprovalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/open/approval/$approvalId',
  component: lazyRouteComponent(() => import('./desktop/OpenScreens'), 'OpenApprovalScreen'),
});
const openNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/open/new',
  component: lazyRouteComponent(() => import('./desktop/OpenScreens'), 'OpenNewScreen'),
  validateSearch: (s: Record<string, unknown>): { text?: string; notebook?: string } => ({
    ...(typeof s.text === 'string' && s.text ? { text: s.text.slice(0, 4000) } : {}),
    ...(typeof s.notebook === 'string' && s.notebook ? { notebook: s.notebook } : {}),
  }),
});
const openHelpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/open/help',
  component: lazyRouteComponent(() => import('./desktop/OpenScreens'), 'OpenHelpScreen'),
  validateSearch: (s: Record<string, unknown>): { topic?: string } =>
    typeof s.topic === 'string' && s.topic ? { topic: s.topic } : {},
});
const openFlowRunRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/open/flow/$flowId/run',
  component: lazyRouteComponent(() => import('./desktop/OpenScreens'), 'OpenFlowRunScreen'),
});

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
  component: lazyRouteComponent(() => import('./routes/settings/Settings'), 'SettingsScreen'),
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: lazyRouteComponent(() => import('./routes/admin/Admin'), 'AdminLayout'),
});
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
  component: lazyRouteComponent(() => import('./routes/admin/Admin'), 'AdminSectionScreen'),
});

// Places that used to be reachable by a second address (ROADMAP NV2). Each destination has one home;
// the old address still lands there, so a bookmark or an old link never breaks.
const modelsAliasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/models',
  beforeLoad: () => {
    throw redirect({ to: '/admin/$section', params: { section: 'models' }, replace: true });
  },
});
const automationsAliasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/automations',
  beforeLoad: () => {
    throw redirect({ to: '/admin/$section', params: { section: 'automations' }, replace: true });
  },
});
const grantsAliasRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'grants',
  beforeLoad: () => {
    throw redirect({ to: '/admin/$section', params: { section: 'permissions' }, replace: true });
  },
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  threadRoute,
  notebookRoute,
  notebookFlowRoute,
  flowsRoute,
  flowRoute,
  setupRoute,
  openApprovalRoute,
  openNewRoute,
  openHelpRoute,
  openFlowRunRoute,
  settingsRoute,
  modelsAliasRoute,
  automationsAliasRoute,
  settingsGroupRoute,
  adminRoute.addChildren([adminIndexRoute, grantsAliasRoute, adminSectionRoute]),
]);

/** Hover or focus loads a link's code and, after a short rest, its data (lib/prefetch.ts). */
export function createAppRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    ...(history && { history }),
    defaultPreload: 'intent',
    defaultPreloadDelay: PRELOAD_DELAY_MS,
    scrollRestoration: false,
  });
}

export const router = createAppRouter();

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
