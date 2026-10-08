/**
 * ------------------------------------------------------------------
 *  Title    |  Repo segment
 *  Ref      |  DESIGN.md §17
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The status bar's branch, like an editor's: which
 *           |  repository this thread works in, the branch, commits
 *           |  to push and pull, and how many files changed.
 *  How      |  Only when this thread or notebook is linked to a
 *           |  repository. Click opens the Repo panel. Live through
 *           |  repo.changed, so a `git switch` in a terminal shows here.
 * ------------------------------------------------------------------
 */

import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';
import { Tip } from '../ui/primitives';
import { useLinkedRepo, useRepoScope, useRepoStatus } from './data';

export function RepoSegment() {
  const linked = useLinkedRepo(useRepoScope());
  const repo = linked.data;
  const status = useRepoStatus(repo?.id);
  const s = status.data ?? repo?.status;
  if (!repo || !s) return null;
  const changed = s.files.length;
  const branch = s.branch ?? s.head?.slice(0, 7) ?? '?';
  const parts = [
    `${repo.name} on ${branch}`,
    s.upstream ? `${s.ahead} to push, ${s.behind} to pull` : 'not pushed yet',
    changed ? `${changed} changed ${changed === 1 ? 'file' : 'files'}` : 'no changes',
  ];
  return (
    <Tip label="Open the Repo panel">
      <button
        type="button"
        className="status-seg repo-seg"
        onClick={() => useUi.getState().openDrawer('repo')}
        aria-label={parts.join(', ')}
      >
        <Icon name="branch" size={13} />
        <span className="repo-seg__branch">{branch}</span>
        {s.upstream && (s.ahead || s.behind) ? (
          <span className="mute" data-num>
            {s.ahead ? `↑${s.ahead}` : ''}
            {s.ahead && s.behind ? ' ' : ''}
            {s.behind ? `↓${s.behind}` : ''}
          </span>
        ) : null}
        {changed ? (
          <span className="repo-seg__dirty" data-num>
            •{changed}
          </span>
        ) : null}
      </button>
    </Tip>
  );
}
