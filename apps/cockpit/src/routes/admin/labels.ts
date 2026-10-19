/**
 * ------------------------------------------------------------------
 *  Title    |  Admin section names
 *  Ref      |  ROADMAP P1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The title of each admin section, apart from the screens,
 *           |  so the shell can name the open section in its breadcrumb
 *           |  without loading Admin.
 *  Note     |  sections.tsx must agree with this list; the shell boot
 *           |  test checks it.
 * ------------------------------------------------------------------
 */

import { PRO_SURFACES } from '../../pro/slot';

export const ADMIN_LABELS: Record<string, string> = {
  health: 'Health',
  compute: 'Compute',
  diagnostics: 'Diagnostics',
  logs: 'Logs',
  traces: 'Traces',
  permissions: 'Permissions',
  decisions: 'Decisions',
  memory: 'Memory',
  models: 'Models',
  routing: 'Routing',
  plugins: 'Plugins',
  automations: 'Automations',
  license: 'Licence',
};

export function adminLabel(id: string | undefined): string {
  if (!id) return '';
  return ADMIN_LABELS[id] ?? PRO_SURFACES.find((s) => s.id === id)?.label ?? '';
}
