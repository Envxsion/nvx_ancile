/**
 * ------------------------------------------------------------------
 *  Title    |  Open in editor
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The small button on a Read, Edit or Write step that
 *           |  opens the file in the code editor, on the Changes tab
 *           |  when the step changed it.
 *  How      |  A path relative to the session's folder is joined to
 *           |  it; the thread is the one on screen, so the thread's
 *           |  scope applies when Core reads and saves the file.
 * ------------------------------------------------------------------
 */

import { Icon } from '../ui/Icon';
import { editFromArgs } from './before';
import { openFile } from './store';

/** A step's path, made absolute against the session folder when it is relative. */
export function resolveStepPath(path: string, cwd: string | null): string {
  const p = path.trim();
  if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || !cwd) return p;
  const sep = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/';
  return `${cwd.replace(/[\\/]+$/, '')}${sep}${p.replace(/^\.[\\/]/, '')}`;
}

/** The thread on screen (/t/:id), read at the click: steps also render outside the router. */
function threadOnScreen(): string | null {
  return /^\/t\/([^/]+)/.exec(window.location.pathname)?.[1] ?? null;
}

export function OpenInEditor({
  path,
  cwd,
  tool,
  args,
}: {
  path: string | null;
  cwd: string | null;
  /** The step's tool and arguments, when it changed the file (Edit, MultiEdit, Write). */
  tool?: string;
  args?: unknown;
}) {
  if (!path) return null;
  const full = resolveStepPath(path, cwd);
  const edit = tool ? editFromArgs(tool, args) : null;
  return (
    <button
      type="button"
      className="link-btn tool-step__open"
      onClick={() => openFile({ path: full, threadId: threadOnScreen(), edit })}
      title={full}
    >
      <Icon name="ext" size={12} />
      {edit ? 'Review in editor' : 'Open in editor'}
    </button>
  );
}
