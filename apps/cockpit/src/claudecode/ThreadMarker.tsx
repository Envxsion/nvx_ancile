/**
 * ------------------------------------------------------------------
 *  Title    |  From Claude Code
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A quiet mark under a thread's title when the thread
 *           |  came from a Claude Code session: the folder it ran in,
 *           |  and a small menu to sync it again or copy the session
 *           |  id. Also the quiet rows for what else Claude Code
 *           |  recorded: the divider (and "What came before") where it
 *           |  compacted, slash commands, notices, "Stopped by you".
 *           |  None of them is a conversation bubble.
 *  How      |  Reads ThreadSettings.claude_code (ClaudeCodeBinding).
 *           |  Sync is POST /claude-code/threads/:id/sync (syncThread).
 * ------------------------------------------------------------------
 */

import type { ClaudeCodeBinding } from '@nvx/contracts';
import type { CcEvent } from '../lib/types';
import { notify } from '../state/notify';
import { Prose } from '../thread/ToolSteps';
import { Icon, type IconName } from '../ui/Icon';
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

export function CompactionDivider({ summary }: { summary?: string | null }) {
  return (
    <>
      <div className="cc-compact" role="separator" aria-label="Conversation compacted here">
        <span>Conversation compacted here</span>
      </div>
      {summary ? <WhatCameBefore summary={summary} /> : null}
    </>
  );
}

/** Claude Code's summary of the conversation before a compaction, folded away. */
export function WhatCameBefore({ summary }: { summary: string }) {
  return (
    <details className="cc-before">
      <summary>
        <Icon name="chevronRight" size={11} className="cc-chev" />
        What came before
      </summary>
      <div className="cc-before__body">
        <Prose text={summary} />
      </div>
    </details>
  );
}

/** A slash command you ran in Claude Code: the command, and its output folded away. */
export function CommandRow({ e }: { e: Extract<CcEvent, { kind: 'command' }> }) {
  const head = (
    <>
      <Icon name="terminal" size={12} className="cc-row__icon" />
      {e.name ? <code className="cc-cmd__name">{e.name}</code> : <span>Command output</span>}
      {e.args ? <span className="cc-cmd__args">{e.args}</span> : null}
    </>
  );
  if (!e.output)
    return (
      <div className="cc-row cc-cmd">
        <div className="cc-row__line">{head}</div>
      </div>
    );
  return (
    <details className="cc-row cc-cmd">
      <summary className="cc-row__line" aria-label={`You ran ${e.name ?? 'a command'}. Show its output`}>
        {head}
        <Icon name="chevronRight" size={11} className="cc-chev cc-row__end" />
      </summary>
      <pre className="cc-cmd__out">{e.output}</pre>
    </details>
  );
}

const NOTICE_ICONS: Record<Extract<CcEvent, { kind: 'notification' }>['source'], IconName> = {
  task: 'logs',
  session: 'clock',
  agent: 'branch',
  system: 'bell',
};

/** A notice Claude Code put in the session (a task finished, an agent reported). */
export function NoticeRow({ e }: { e: Extract<CcEvent, { kind: 'notification' }> }) {
  const head = (
    <>
      <Icon name={NOTICE_ICONS[e.source]} size={12} className="cc-row__icon" />
      <span className="cc-note__title">{e.title}</span>
      {e.from ? <span className="cc-note__meta">{e.from}</span> : null}
      {e.status ? <span className="cc-note__meta">{e.status}</span> : null}
    </>
  );
  if (!e.body.trim())
    return (
      <div className="cc-row cc-note">
        <div className="cc-row__line">{head}</div>
      </div>
    );
  return (
    <details className="cc-row cc-note">
      <summary className="cc-row__line">
        {head}
        <Icon name="chevronRight" size={11} className="cc-chev cc-row__end" />
      </summary>
      <div className="cc-note__body">
        <Prose text={e.body} />
      </div>
    </details>
  );
}

/** Where you stopped Claude Code mid-answer. */
export function InterruptedMark() {
  return (
    <p className="cc-stopped">
      <Icon name="stop" size={10} />
      Stopped by you
    </p>
  );
}

/** "1 entry this version of NVX Ancile can't show yet". */
export const unknownLine = (n: number) =>
  `${n} ${n === 1 ? 'entry' : 'entries'} this version of NVX Ancile can't show yet`;

/**
 * Something Claude Code wrote that this version does not know how to
 * show: a quiet mark, never dropped. The entry is kept as written, so a
 * later version shows it.
 */
export function UnknownMark({ count }: { count: number }) {
  return (
    <p
      className="cc-unknown"
      title="Kept as Claude Code wrote it. A later version of NVX Ancile will show it."
    >
      <Icon name="question" size={10} />
      {unknownLine(count)}
    </p>
  );
}

/** Any of the above for one turn. */
export function CcEventRow({ e }: { e: CcEvent }) {
  switch (e.kind) {
    case 'compact_boundary':
      return <CompactionDivider summary={e.summary} />;
    case 'compact_summary':
      return e.summary ? <WhatCameBefore summary={e.summary} /> : null;
    case 'command':
      return <CommandRow e={e} />;
    case 'notification':
      return <NoticeRow e={e} />;
    case 'interrupted':
      return <InterruptedMark />;
    case 'unknown':
      return <UnknownMark count={e.count} />;
  }
}
