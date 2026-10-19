/**
 * ------------------------------------------------------------------
 *  Title    |  What the slash commands do
 *  Ref      |  ROADMAP.md CH5, EN1 · thread/slash.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Run a "/" command the composer recognised: open the
 *           |  memory inbox or save something to remember, compact the
 *           |  thread, branch from the last message, fact-check the
 *           |  last answer, export, edit instructions, search, draft
 *           |  an AGENTS.md, and set the reasoning effort.
 *  How      |  Loaded the first time a command runs (the composer does
 *           |  `import('./slashActions')`), so an idle composer does
 *           |  not carry it. Each command uses the same code the
 *           |  buttons and the palette use; none has a path of its own
 *           |  to Core. A command that cannot act (no answer to check,
 *           |  nothing to branch from) says so and changes nothing.
 *  Note     |  /memory with words sends them as a message ("Remember
 *           |  that ...") so the memory module's own capture (M2, GR3)
 *           |  saves it with its note and Undo; nothing is written to
 *           |  memory from here. /compact starts a new prompt epoch on
 *           |  the next answer (CA2), which the notice says.
 * ------------------------------------------------------------------
 */

import type { Effort } from '@nvx/contracts';
import { openEditor } from '../editors/store';
import { api } from '../lib/api';
import { branchHere, compactNow } from '../lib/branching';
import { keys } from '../lib/data';
import { startFactcheck } from '../lib/factcheck';
import { queryClient } from '../lib/query';
import { exportThread } from '../lib/threads';
import type { ThreadView } from '../lib/types';
import { useMemoryUi } from '../memory/api';
import { openBeam } from '../pro/beam';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';
import { setEffort } from './effort';
import type { SlashId } from './slash';

export interface SlashCtx {
  threadId: string;
  /** A real thread exists (Home composes for one that does not). */
  realThread: boolean;
  notebookId: string | null;
  /** The message the next one would answer: the last on screen. */
  parentId: string | null;
  arg: string;
  /** Send this text as a message, as if typed. Resolves false when it was not sent. */
  send: (text: string) => Promise<boolean>;
  /** The efforts the current model takes. */
  efforts: readonly Effort[];
}

const nothing = (title: string, body: string) => notify({ level: 'info', title, body });

const cached = (threadId: string) => queryClient.getQueryData<ThreadView>(keys.thread(threadId));

/** The newest answer on screen that is finished, or null. */
export function lastAnswer(threadId: string) {
  return (
    cached(threadId)?.messages.findLast(
      (m) => m.role === 'assistant' && (m.status === undefined || m.status === 'complete'),
    ) ?? null
  );
}

/** What /memory with words sends: the person's own request, in their words. */
export function rememberText(arg: string): string {
  const t = arg.trim();
  return /^(remember|never|always|from now on|going forward)\b/i.test(t) ? t : `Remember that ${t}`;
}

const toMemory = () =>
  void import('../router').then(({ router }) =>
    router.navigate({ to: '/admin/$section', params: { section: 'memory' } }),
  );

/** Run one command. Resolves true when it did its work (so the composer clears the line). */
export async function runSlash(id: SlashId, c: SlashCtx): Promise<boolean> {
  const ui = useUi.getState();
  switch (id) {
    case 'models':
      ui.openPalette('models', c.arg);
      return true;
    case 'sources':
      ui.openDrawer('sources');
      return true;
    case 'shortcuts':
      ui.setShortcuts(true);
      return true;
    case 'beam':
      openBeam({
        threadId: c.realThread ? c.threadId : null,
        notebookId: c.notebookId,
        parentId: c.parentId,
        text: c.arg,
      });
      return true;
    case 'find':
      ui.openPalette('all', c.arg);
      return true;
    case 'memory': {
      if (c.arg) return c.send(rememberText(c.arg));
      useMemoryUi.getState().setTab('inbox');
      toMemory();
      return true;
    }
    case 'compact': {
      if (!c.parentId) {
        nothing('Nothing to compact yet', 'Compacting summarises the older messages of a thread.');
        return false;
      }
      return (await compactNow(c.threadId, c.parentId)) !== null;
    }
    case 'branch': {
      if (!c.parentId) {
        nothing('Nothing to branch from yet', 'A branch starts at a message. Send one first.');
        return false;
      }
      return (
        (await branchHere(c.threadId, c.parentId, {
          ...(c.arg && { name: c.arg }),
          previousHead: c.parentId,
        })) !== null
      );
    }
    case 'factcheck': {
      const a = lastAnswer(c.threadId);
      if (!a) {
        nothing('No answer to check yet', 'Fact-check works on a finished answer. Ask something first.');
        return false;
      }
      void startFactcheck(a.id, { web: /^web\b/i.test(c.arg) });
      ui.showEvidence(a.id);
      return true;
    }
    case 'export':
      exportThread(c.threadId);
      return true;
    case 'instructions':
      openEditor({ kind: 'instructions', level: 'thread', id: c.threadId });
      return true;
    case 'init': {
      const r = await api
        .get<{ repo: { id: string; name: string } | null }>(
          `/repos/linked?thread_id=${encodeURIComponent(c.threadId)}`,
        )
        .catch(() => null);
      if (!r?.repo) {
        notify({
          level: 'info',
          title: 'This thread has no repository linked',
          body: 'Link one in the Repo panel, then run /init again. It drafts an AGENTS.md and writes nothing until you say.',
          action: { label: 'Open Repo panel', run: () => useUi.getState().openDrawer('repo') },
        });
        return false;
      }
      openEditor({ kind: 'init-agents', repoId: r.repo.id, repoName: r.repo.name });
      return true;
    }
    case 'effort': {
      const want = c.arg.toLowerCase();
      if (want === 'auto' || want === 'default') {
        const ok = await setEffort(c.threadId, null);
        if (ok) notify({ level: 'success', title: 'Reasoning effort is back to the model default' });
        return ok;
      }
      if ((c.efforts as readonly string[]).includes(want)) {
        const ok = await setEffort(c.threadId, want as Effort);
        if (ok) notify({ level: 'success', title: `Reasoning effort is ${want}` });
        return ok;
      }
      if (!want) {
        const now = cached(c.threadId)?.effort;
        notify({
          level: 'info',
          title: `Thinking effort is ${now ?? 'the model default'}`,
          body: `Use /effort ${[...c.efforts, 'auto'].join(', ')}, or the chip beside the model.`,
        });
        return true;
      }
      notify({
        level: 'info',
        title: `${c.arg} is not an effort this model takes`,
        body: `Use ${[...c.efforts, 'auto'].join(', ')}.`,
      });
      return false;
    }
    default:
      return false;
  }
}
