/**
 * ------------------------------------------------------------------
 *  Title    |  Home: a new thread
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The blank page, made useful: where to start, what you
 *           |  were doing, and the composer already focused.
 *  How      |  Pick a notebook (or none) at the start of the composer;
 *           |  ?notebook= arrives pre-picked from a notebook's "New
 *           |  thread here". Sending creates the thread there with the
 *           |  model you picked, sends the message, and opens it with
 *           |  the answer already streaming. If the message does not
 *           |  go, the empty thread is removed and the draft stays.
 * ------------------------------------------------------------------
 */

import { AncileMark } from '@nvx/aperture';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { type CSSProperties, useState } from 'react';
import { FirstSteps } from '../help/FirstSteps';
import { useFirstSteps } from '../help/steps';
import { api } from '../lib/api';
import { useNotebooks, useThreads } from '../lib/data';
import { hueVar, relative } from '../lib/format';
import { useCurrentModel } from '../lib/models';
import { createThread, sendMessage } from '../lib/turns';
import type { Hue, NotebookView } from '../lib/types';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';
import { ShareStatsCard } from '../telemetry/ShareStats';
import { Composer, type SendExtras } from '../thread/Composer';
import { Icon } from '../ui/Icon';
import { DropMenu, type MenuEntry } from '../ui/Menu';

const STARTERS = [
  {
    title: 'Ask across a notebook',
    body: 'Answers cite the exact passage they came from.',
    scope: 'notebooks' as const,
  },
  {
    title: 'Compare two models on one question',
    body: 'Branch after the question, then regenerate with another model.',
    scope: 'models' as const,
  },
  {
    title: 'See what NVX Ancile remembers',
    body: 'Preferences, projects and lessons, all plain files you can edit.',
    scope: 'commands' as const,
  },
];

function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 5) return 'Working late?';
  if (h < 12) return 'Good morning.';
  if (h < 18) return 'Good afternoon.';
  return 'Good evening.';
}

function NotebookPick({
  notebooks,
  value,
  onChange,
}: {
  notebooks: NotebookView[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const current = notebooks.find((n) => n.id === value) ?? null;
  const items: MenuEntry[] = [
    { kind: 'label', label: 'Answer from' },
    { label: 'No notebook', icon: 'thread', onSelect: () => onChange(null) },
    ...(notebooks.length ? [{ kind: 'separator' as const }] : []),
    ...notebooks
      .filter((n) => !n.archived)
      .slice(0, 30)
      .map((n) => ({ label: n.title, icon: 'notebook' as const, onSelect: () => onChange(n.id) })),
  ];
  return (
    <DropMenu
      align="start"
      side="top"
      items={items}
      trigger={
        <button
          type="button"
          className="scope-pick"
          data-set={current ? true : undefined}
          style={current?.color ? ({ '--hue': hueVar(current.color as Hue) } as CSSProperties) : undefined}
          aria-label={current ? `Notebook: ${current.title}. Change` : 'Choose a notebook'}
        >
          {current ? (
            <span className="scope-pick__dot" aria-hidden="true" />
          ) : (
            <Icon name="notebook" size={13} />
          )}
          <span className="scope-pick__label">{current ? current.title : 'No notebook'}</span>
          <Icon name="chevronDown" size={11} />
        </button>
      }
    />
  );
}

export function HomeScreen() {
  const threads = useThreads();
  const notebooks = useNotebooks().data ?? [];
  const search = useSearch({ strict: false }) as { notebook?: string };
  const openPalette = useUi((s) => s.openPalette);
  const mark = useUi((s) => s.mark);
  const demo = useUi((s) => s.demo);
  const navigate = useNavigate();
  const model = useCurrentModel();
  const learning = useFirstSteps();
  const showSteps = !learning.complete && !learning.dismissed;
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  // An explicit pick wins; otherwise the notebook the link came from.
  const notebookId = picked === undefined ? (search.notebook ?? null) : picked;
  const recent = (threads.data ?? []).slice(0, 5);
  const titleOf = new Map(notebooks.map((n) => [n.id, n]));

  const start = async (text: string, extras: SendExtras): Promise<boolean> => {
    if (demo) {
      notify({
        level: 'info',
        title: 'Not sent: Core is not running',
        body: 'Start NVX Ancile with pnpm start. Your draft is kept.',
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
      void api.del(`/threads/${threadId}`).catch(() => undefined);
      return false;
    }
    await navigate({ to: '/t/$threadId', params: { threadId } });
    return true;
  };

  return (
    <div className="home">
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

        <ShareStatsCard place="home" />

        {showSteps ? (
          <FirstSteps />
        ) : (
          <div className="home__starters">
            {STARTERS.map((s) => (
              <button key={s.title} type="button" className="starter" onClick={() => openPalette(s.scope)}>
                <span className="starter__title">{s.title}</span>
                <span className="starter__body">{s.body}</span>
              </button>
            ))}
          </div>
        )}

        {recent.length > 0 ? (
          <section className="home__recent" aria-label="Recent threads">
            <h2 className="home__h">Pick up where you left off</h2>
            <ul>
              {recent.map((t) => {
                const nb = t.notebookId ? titleOf.get(t.notebookId) : undefined;
                return (
                  <li key={t.id}>
                    <Link to="/t/$threadId" params={{ threadId: t.id }} className="recent">
                      <Icon name="thread" size={14} />
                      <span className="recent__title" dir="auto">
                        {t.title}
                      </span>
                      {nb ? (
                        <span
                          className="recent__nb"
                          style={
                            nb.color ? ({ '--hue': hueVar(nb.color as Hue) } as CSSProperties) : undefined
                          }
                        >
                          {nb.title}
                        </span>
                      ) : null}
                      {t.live ? <span className="recent__live">Waiting on you</span> : null}
                      <span className="mute">{relative(t.updatedAt)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
