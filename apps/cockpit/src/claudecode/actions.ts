/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code thread actions
 *  Ref      |  ROADMAP P1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What NVX Ancile does for Claude Code's "/" commands,
 *           |  and the last answer with usage. Apart from LiveBar so
 *           |  the thread screen can call them without LiveBar's
 *           |  components being in the first download.
 * ------------------------------------------------------------------
 */

import type { ClaudeCodeCommand } from '@nvx/contracts';
import { useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import { branchHere } from '../lib/branching';
import { keys } from '../lib/data';
import { queryClient } from '../lib/query';
import { createThread } from '../lib/turns';
import type { MessageView } from '../lib/types';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';
import { useBranchLayer } from '../tree/store';
import { isEffort, patchCc } from './store';

/** The last answer Claude Code gave on this path, for the usage popover. */
export function lastTurn(messages: MessageView[]): MessageView | undefined {
  return messages.findLast((m) => m.role === 'assistant' && !m.cc && !!m.usage);
}

/* ---- What NVX Ancile does for its "/" commands ------------------------------ */

export function useCcActions(opts: {
  threadId: string;
  notebookId: string | null;
  headId: string | null;
}): (c: ClaudeCodeCommand, arg: string | null) => void {
  const navigate = useNavigate();
  const { threadId, notebookId, headId } = opts;
  return useCallback(
    (c: ClaudeCodeCommand, arg: string | null) => {
      const ui = useUi.getState();
      switch (c.ancile_action) {
        case 'open_mcp':
          return void navigate({ to: '/admin/$section', params: { section: 'plugins' } });
        case 'open_permissions':
          return void navigate({ to: '/admin/$section', params: { section: 'permissions' } });
        case 'open_usage':
          return patchCc(threadId, { usageOpen: true });
        case 'branch':
          if (!headId) return;
          // A fork in Claude Code: the next message carries on in a new session from here.
          patchCc(threadId, { forkNext: true });
          return void branchHere(threadId, headId, { previousHead: headId }).then((b) => {
            if (b)
              notify({
                level: 'info',
                title: 'Branched here',
                body: 'Your next message forks the Claude Code session, so the original carries on unchanged.',
              });
          });
        case 'rewind':
          return useBranchLayer.getState().setFull(true);
        case 'new_thread':
          return void newThreadHere(notebookId).then((id) => {
            if (id) void navigate({ to: '/t/$threadId', params: { threadId: id } });
          });
        case 'open_threads':
          return ui.openPalette('all');
        case 'sign_in':
        case 'open_settings':
          return void navigate({ to: '/settings/$group', params: { group: 'claude-code' } });
        case 'open_memory':
          return void navigate({ to: '/admin/$section', params: { section: 'memory' } });
        case 'set_model':
          return arg ? patchCc(threadId, { model: arg }) : patchCc(threadId, { picker: 'model' });
        case 'set_effort':
          return isEffort(arg) ? patchCc(threadId, { effort: arg }) : patchCc(threadId, { picker: 'effort' });
        default:
          return patchCc(threadId, {
            notice: { kind: 'unsupported', name: c.name, description: c.description },
          });
      }
    },
    [navigate, threadId, notebookId, headId],
  );
}

/**
 * "/clear", "/new": a new thread in the same notebook. TODO(phase-3): Core
 * has no route yet for a fresh Claude Code session in a folder, so the new
 * thread answers with your models until it has one.
 */
async function newThreadHere(notebookId: string | null): Promise<string | null> {
  const id = await createThread(null, notebookId);
  if (id) {
    notify({
      level: 'info',
      title: 'New thread in this notebook',
      body: 'Starting a fresh Claude Code session from NVX Ancile is not possible yet, so this thread answers with your models.',
    });
    void queryClient.invalidateQueries({ queryKey: keys.threads });
  }
  return id;
}
