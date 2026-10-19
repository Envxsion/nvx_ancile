/**
 * ------------------------------------------------------------------
 *  Title    |  Demo live state
 *  Ref      |  ROADMAP P1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The few live-state numbers the status bar and context
 *           |  meter show in demo mode, kept apart from the sample
 *           |  workspace (fixtures/demo.ts) so the shell can use them
 *           |  without loading the rest.
 * ------------------------------------------------------------------
 */

import type { LiveState } from '../lib/types';

export const live: LiveState = {
  modelId: 'anthropic/claude-sonnet-5-5',
  context: { ratio: 0.62, used: 248_000, window: 400_000 },
  node: { name: 'depot-gpu', state: 'running', rate: 0.44 },
  approvals: 1,
  health: 'degraded',
};
