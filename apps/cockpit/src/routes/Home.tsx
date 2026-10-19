/**
 * ------------------------------------------------------------------
 *  Title    |  Home: a new thread
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A fresh new-thread screen on every launch (HM1): the
 *           |  composer centred and focused, the model or flow chip,
 *           |  a place to drop files, and at most three starters from
 *           |  the current notebook. It does not repeat the sidebar:
 *           |  recent threads live there.
 *  How      |  Pick a notebook (or none) at the start of the composer;
 *           |  ?notebook= arrives pre-picked from a notebook's "New
 *           |  thread here". Sending creates the thread there with the
 *           |  model you picked, sends the message, and opens it with
 *           |  the answer already streaming. If the message does not
 *           |  go, the empty thread is removed and the draft stays.
 * ------------------------------------------------------------------
 */

import { AncileMark } from '@nvx/aperture';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { type DragEvent, useState } from 'react';
import { FirstSteps } from '../help/FirstSteps';
import { useFirstSteps } from '../help/steps';
import { startersFor } from '../home/starters';
import { api } from '../lib/api';
import { keys, useNotebooks, useNotes, useSources } from '../lib/data';
import { useCurrentModel } from '../lib/models';
import { queryClient } from '../lib/query';
import { startCoreHint } from '../lib/runtime';
import { insertIntoComposer } from '../lib/selectionWords';
import { createThread, sendMessage } from '../lib/turns';
import { notify } from '../state/notify';
import { usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';
import { ShareStatsCard } from '../telemetry/ShareStats';
import { Composer, type SendExtras } from '../thread/Composer';
import { Icon } from '../ui/Icon';
import { NotebookPick } from '../ui/NotebookPick';

function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 5) return 'Working late?';
  if (h < 12) return 'Good morning.';
  if (h < 18) return 'Good afternoon.';
  return 'Good evening.';
}

export function HomeScreen() {
  const notebooks = useNotebooks().data ?? [];
  const search = useSearch({ strict: false }) as { notebook?: string };
  const mark = useUi((s) => s.mark);
  const demo = useUi((s) => s.demo);
  const navigate = useNavigate();
  const model = useCurrentModel();
  const learning = useFirstSteps();
  const showSteps = !learning.complete && !learning.dismissed;
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  // An explicit pick wins; otherwise the notebook the link came from.
  const notebookId = picked === undefined ? (search.notebook ?? null) : picked;
  const presenting = usePrefs((s) => s.prefs.layout.presentation);
  // Starters come from the notebook in scope; with none picked, from the one worked in most recently.
  const fallback = notebooks
    .filter((n) => !n.archived)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
  const startersFrom = notebookId ?? (!presenting ? (fallback?.id ?? null) : null);
  const sources = useSources(presenting ? null : startersFrom);
  const notes = useNotes(presenting ? null : startersFrom);
  const starters = startersFor({
    notebookId: startersFrom,
    notes: notes.data ?? [],
    sources: sources.data ?? [],
    presenting,
  });
  const startersNotebook = notebooks.find((n) => n.id === startersFrom);
  const [dragging, setDragging] = useState(false);
  const overDrop = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setDragging(true);
  };

  const start = async (text: string, extras: SendExtras): Promise<boolean> => {
    if (demo) {
      notify({
        level: 'info',
        title: 'Not sent: Core is not running',
        body: `${startCoreHint()} Your draft is kept.`,
      });
      return false;
    }
    const threadId = await createThread(model?.id ?? null, notebookId);
    if (!threadId) return false;
    const ok = await sendMessage({
      threadId,
      parentId: null,
      text,
      model: extras.model ?? null,
      defaultModel: model?.id ?? null,
      mentions: extras.mentions,
      flowId: extras.flowId ?? null,
    });
    if (!ok) {
      // Leave nothing behind: an empty thread in the rail would only confuse.
      void api
        .del(`/threads/${threadId}`)
        .catch(() => undefined)
        .finally(() => queryClient.invalidateQueries({ queryKey: keys.threads }));
      return false;
    }
    await navigate({ to: '/t/$threadId', params: { threadId } });
    return true;
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drag target only; the composer inside does the work
    <div
      className="home"
      onDragOver={overDrop}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        // Files dropped away from the message box must not open in the window.
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
        setDragging(false);
      }}
    >
      <div className="home__inner">
        <div className="home__mark" aria-hidden="true">
          <AncileMark size={44} state={mark === 'ask' ? 'ask' : 'idle'} />
        </div>
        <p className="home__greeting mute">{greeting()}</p>
        <h1 className="home__title" data-display>
          What are you working on?
        </h1>

        <Composer
          threadId="new"
          parentId={null}
          onSend={start}
          notebookId={notebookId}
          scope={<NotebookPick notebooks={notebooks} value={notebookId} onChange={setPicked} />}
        />

        <p className="home__drop mute" data-over={dragging || undefined}>
          <Icon name="attach" size={13} />
          {notebookId
            ? `Drop files here to add them to ${startersNotebook?.title ?? 'this notebook'}.`
            : 'Drop files here to attach them, or pick a notebook to keep them.'}
        </p>

        <ShareStatsCard place="home" />

        {showSteps ? <FirstSteps /> : null}

        {starters.length > 0 ? (
          <section
            className="home__starters"
            aria-label={`Starters from ${startersNotebook?.title ?? 'your notebook'}`}
          >
            {starters.map((s) => (
              <button
                key={s.id}
                type="button"
                className="starter"
                onClick={() => {
                  if (startersFrom && startersFrom !== notebookId) setPicked(startersFrom);
                  insertIntoComposer('new', s.text);
                }}
              >
                <span className="starter__label">{s.label}</span>
                <span className="starter__title">{s.title}</span>
              </button>
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}
