/**
 * ------------------------------------------------------------------
 *  Title    |  From Claude Code
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A quiet mark under a thread's title when the thread
 *           |  came from a Claude Code session: the folder it ran in,
 *           |  and a small menu to sync it again or copy the session
 *           |  id. Also the divider an imported compaction leaves.
 *  How      |  Reads ThreadSettings.claude_code (ClaudeCodeBinding).
 *           |  Sync is POST /claude-code/threads/:id/sync (syncThread).
 * ------------------------------------------------------------------
 */

import type { ClaudeCodeBinding } from '@nvx/contracts';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';
import { DropMenu } from '../ui/Menu';
import { syncThread } from './api';
import '../styles/claudecode.css';

/** "/home/me/work/site" → "site". */
export function folderName(cwd: string | null): string | null {
  if (!cwd) return null;
  const parts = cwd.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/** "From Claude Code in cyberfolio". */
export function markerText(cwd: string | null): string {
  const folder = folderName(cwd);
  return folder ? `From Claude Code in ${folder}` : 'From Claude Code';
}

export function ClaudeCodeMarker({ threadId, binding }: { threadId: string; binding: ClaudeCodeBinding }) {
  const folder = folderName(binding.cwd);
  return (
    <DropMenu
      align="start"
      items={[
        { label: 'Sync from Claude Code', icon: 'regenerate', onSelect: () => void syncThread(threadId) },
        {
          label: 'Copy session id',
          icon: 'copy',
          onSelect: () => {
            void navigator.clipboard?.writeText(binding.session_id);
            notify({ level: 'success', title: 'Session id copied' });
          },
        },
      ]}
      trigger={
        <button
          type="button"
          className="cc-marker"
          title={`${binding.cwd ? `${binding.cwd}\n` : ''}Claude Code session ${binding.session_id}`}
          aria-label={`${markerText(binding.cwd)}. Session ${binding.session_id}`}
        >
          <Icon name="command" size={12} />
          <span>From Claude Code</span>
          {folder ? (
            <>
              <span className="cc-marker__in">in</span>
              <span className="cc-marker__folder">{folder}</span>
            </>
          ) : null}
        </button>
      }
    />
  );
}

export function CompactionDivider() {
  return (
    <div className="cc-compact" role="separator" aria-label="Conversation compacted here">
      <span>Conversation compacted here</span>
    </div>
  );
}
