/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code: lean sessions
 *  Ref      |  docs/claude-code.md (Lean sessions)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The thread's Claude Code setting "Load only this
 *           |  project's Claude Code settings": on, a session skips the
 *           |  person's user plugins, MCP servers and user CLAUDE.md,
 *           |  which saves tokens on every turn.
 *  How      |  Reads ClaudeCodeBinding (lean, started_in) from the
 *           |  thread; PATCH /threads/:id { claude_code_lean } changes
 *           |  it, and the next turn opens the session that way.
 *  Note     |  On by default for threads started in NVX Ancile, off
 *           |  for imported ones. Nothing in Claude Code's own files is
 *           |  changed.
 * ------------------------------------------------------------------
 */

import { claudeCodeLean } from '@nvx/contracts';
import * as DM from '@radix-ui/react-dropdown-menu';
import { useState } from 'react';
import { ApiCallError, api } from '../lib/api';
import { keys, useThread } from '../lib/data';
import { queryClient } from '../lib/query';
import type { ThreadView } from '../lib/types';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';
import { BarLabel, Tip } from '../ui/primitives';

export const LEAN_LABEL = "Load only this project's Claude Code settings";
export const LEAN_HELP =
  'Skips your user plugins, MCP servers and user CLAUDE.md, so each turn reads fewer tokens. Takes effect from the next message.';

/** Turn lean on or off for a thread; the cache changes first and goes back if Core says no. */
export async function setClaudeCodeLean(threadId: string, lean: boolean): Promise<boolean> {
  const key = keys.thread(threadId);
  const before = queryClient.getQueryData<ThreadView>(key);
  if (before?.claudeCode)
    queryClient.setQueryData<ThreadView>(key, { ...before, claudeCode: { ...before.claudeCode, lean } });
  try {
    await api.patch(`/threads/${threadId}`, { claude_code_lean: lean });
    return true;
  } catch (error) {
    queryClient.setQueryData(key, before);
    notify({
      level: 'error',
      title: error instanceof ApiCallError ? error.body.error.title : "The setting didn't reach Core",
      body:
        error instanceof ApiCallError
          ? error.body.error.hint
          : 'Nothing changed. Check that NVX Ancile is running, then try again.',
    });
    return false;
  }
}

/** The composer's setup chip: project settings only, or the whole Claude Code setup. */
export function CcLeanToggle({ threadId }: { threadId: string }) {
  const thread = useThread(threadId);
  const [open, setOpen] = useState(false);
  const cc = thread.data?.claudeCode;
  if (!cc) return null;
  const lean = claudeCodeLean(cc);
  return (
    <DM.Root modal={false} open={open} onOpenChange={setOpen}>
      <DM.Trigger asChild>
        <Tip label={lean ? "Settings: this project's only" : 'Settings: your whole setup'}>
          <button
            type="button"
            className="cc-pick"
            aria-label={`Claude Code settings: ${lean ? "this project's only" : 'your whole setup'}. Change`}
          >
            <Icon name="settings" size={12} />
            <BarLabel
              className="cc-pick__label"
              full={lean ? 'Project settings' : 'Whole setup'}
              short={lean ? 'Project' : 'All'}
            />
            <Icon name="chevronDown" size={10} className="cc-pick__chev" />
          </button>
        </Tip>
      </DM.Trigger>
      <DM.Portal>
        <DM.Content
          className="menu cc-pick__menu"
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
        >
          <DM.CheckboxItem
            className="menu__item"
            checked={lean}
            onCheckedChange={(on) => void setClaudeCodeLean(threadId, on === true)}
          >
            {lean ? <Icon name="check" size={14} /> : <span className="menu__noicon" />}
            <span className="menu__text">
              {LEAN_LABEL}
              <span className="cc-pick__desc">{LEAN_HELP}</span>
            </span>
          </DM.CheckboxItem>
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
