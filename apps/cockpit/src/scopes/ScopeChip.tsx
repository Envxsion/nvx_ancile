/**
 * ------------------------------------------------------------------
 *  Title    |  The scope chip
 *  Ref      |  docs/scopes.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A small chip in the thread's header, only when what the
 *           |  thread may use is narrower than the default ("Local
 *           |  only", "Private", "Narrowed"). It opens the scope
 *           |  editor; its tooltip is the one-line summary.
 * ------------------------------------------------------------------
 */

import { openEditor } from '../editors/store';
import { Icon } from '../ui/Icon';
import { Tip } from '../ui/primitives';
import { scopeChip, scopeSummary, useThreadScope } from './api';

export function ScopeChip({ threadId }: { threadId: string }) {
  const scope = useThreadScope(threadId).data?.effective;
  const label = scopeChip(scope);
  if (!scope || !label) return null;
  const clamped = scope.clamped.length > 0;
  return (
    <Tip label={`${scopeSummary(scope)}. Change what this thread may use`}>
      <button
        type="button"
        className="scope-chip"
        data-private={scope.private || undefined}
        onClick={() => openEditor({ kind: 'scope', level: 'thread', id: threadId })}
        aria-label={`Scope: ${label}. ${scopeSummary(scope)}. Change what this thread may use`}
      >
        <Icon name={scope.private ? 'lock' : 'shield'} size={11} />
        {label}
        {clamped ? <span className="scope-chip__dot" aria-hidden="true" /> : null}
      </button>
    </Tip>
  );
}
