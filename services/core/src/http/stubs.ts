/**
 * ------------------------------------------------------------------
 *  Title    |  API surface, not yet built
 *  Ref      |  DESIGN.md §4.1, ROADMAP.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Every route in the design exists from day one, so the
 *           |  Cockpit can be built against the real paths. Routes not
 *           |  built yet answer 501 with the standard error shape and
 *           |  the phase that delivers them. Each phase deletes its
 *           |  rows here as it mounts the real handlers.
 * ------------------------------------------------------------------
 */

import type { Env, Hono } from 'hono';
import { notImplemented } from '../obs/errors';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export const PLANNED: [Method, string, number, string][] = [
  // Session and setup
  ['post', '/session', 2, 'Signing in'],
  ['get', '/me', 2, 'Your profile'],
  ['delete', '/session', 2, 'Signing out'],
  // Threads, messages, branches
  ['get', '/threads/:id/context-budget', 4, 'The context meter'],
  ['delete', '/messages/:id', 4, 'Deleting a message'],
  ['get', '/threads/:id/tree', 4, 'The branch tree'],
  ['get', '/threads/:id/branches', 4, 'Branches'],
  ['post', '/messages/:id/branch', 4, 'Branching'],
  ['patch', '/branches/:id', 4, 'Renaming a branch'],
  ['post', '/threads/:id/compare', 4, 'Comparing branches'],
  ['post', '/merge', 4, 'Merging branches'],
  ['post', '/threads/:id/compact', 4, 'Compacting a thread'],
  // Runs and approvals
  // Palette
  ['get', '/suggest', 2, 'Palette suggestions'],
  // Models and routing
  ['get', '/models/suggest', 5, 'Model suggestions'],
  ['put', '/routing', 2, 'Editing routing'],
  // System
  ['post', '/system/services/:name/restart', 5, 'Restarting a service'],
  ['post', '/system/diagnostics', 5, 'Self-diagnostic'],
  ['get', '/system/diagnostics/:id', 5, 'Diagnostic results'],
  ['get', '/logs', 5, 'Logs'],
  ['get', '/logs/export', 5, 'Log export'],
  ['get', '/logs/stream', 5, 'Live logs'],
  ['get', '/traces/:id', 5, 'Traces'],
  ['get', '/traces/:id/replay', 5, 'Replay'],
  ['post', '/runs/:id/rerun', 5, 'Re-running from a step'],
  // Tools
  ['post', '/mcp/servers', 5, 'Adding an MCP server'],
  ['get', '/plugins', 5, 'Plugins'],
  // State and notifications
  ['post', '/license/activate', 5, 'Activating Pro'],
];

export function mountPlanned<E extends Env>(api: Hono<E>): void {
  for (const [method, path, phase, what] of PLANNED) {
    api.on(method.toUpperCase(), path, () => {
      throw notImplemented(phase, what);
    });
  }
}
