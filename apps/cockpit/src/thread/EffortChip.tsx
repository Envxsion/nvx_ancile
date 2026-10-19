/**
 * ------------------------------------------------------------------
 *  Title    |  Reasoning effort chip
 *  Ref      |  ROADMAP.md EN1 · gateway/effort.ts · docs/prompt-caching.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Beside the model chip, for a model that takes a
 *           |  reasoning effort: how hard it thinks in this thread
 *           |  (low, medium or high), or its own default.
 *  How      |  The levels come from the model (Core reads them from
 *           |  the provider's profile, so a model that ignores effort
 *           |  never shows the chip). Choosing saves the setting on
 *           |  the thread (PATCH /threads/:id { effort }); every later
 *           |  message in the thread sends it. It reads the thread
 *           |  itself, so changing it never redraws the composer.
 *  Note     |  Effort is a request setting, not part of the prompt:
 *           |  changing it keeps the cached start of the conversation.
 *           |  Thinking shows folded under the answer (Parts.tsx).
 *  EN1 Pro  |  With a notebook, the menu also offers Auto (the
 *           |  models are asked how hard a question is, and the
 *           |  effort follows) and a default for the whole notebook.
 *           |  A thread's own choice still wins; the receipt's Why
 *           |  line says what applied. Without Pro those rows carry a
 *           |  Pro mark and open a card that says what unlocks them.
 * ------------------------------------------------------------------
 */

import type { Effort } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { useThread } from '../lib/data';
import { defaultWords, NO_DEFAULT, useNotebookEffort } from '../pro/NotebookEffort';
import { ProUpsell } from '../pro/slot';
import { Icon } from '../ui/Icon';
import { DropMenu, type MenuEntry } from '../ui/Menu';
import { BarLabel, Tip } from '../ui/primitives';
import { EFFORT_WORDS, setEffort } from './effort';

export function EffortChip({ threadId, levels }: { threadId: string; levels: readonly Effort[] }) {
  const thread = useThread(threadId).data;
  const value = thread?.effort ?? null;
  const notebookId = thread?.notebookId ?? null;
  const pro = useNotebookEffort(notebookId);
  const [upsell, setUpsell] = useState(false);
  const fromNotebook = value === null && pro.usable ? pro.value : undefined;
  const notebookWord = fromNotebook?.auto
    ? 'Auto'
    : fromNotebook?.level
      ? EFFORT_WORDS[fromNotebook.level]
      : null;
  const word = value ? EFFORT_WORDS[value] : notebookWord;
  const saveDefault = (v: typeof NO_DEFAULT) => void pro.save(v);
  // Pro's rows need a notebook to hold the default; a thread outside one keeps the free menu.
  const proRows: MenuEntry[] =
    !notebookId || pro.loading
      ? []
      : pro.usable
        ? [
            { kind: 'separator' },
            { kind: 'label', label: 'This notebook' },
            {
              label: 'Auto, by how hard the question is',
              icon: pro.value?.auto ? 'check' : undefined,
              onSelect: () => {
                // Choosing Auto hands the thread back to the notebook, so it takes effect here too.
                if (pro.value?.auto) return saveDefault(NO_DEFAULT);
                saveDefault({ level: null, auto: true });
                if (value !== null) void setEffort(threadId, null);
              },
            },
            {
              kind: 'sub',
              label: 'Notebook default',
              icon: 'notebook',
              items: [
                { kind: 'label', label: `Now: ${defaultWords(pro.value)}` },
                ...([null, ...levels] as (Effort | null)[]).map(
                  (l): MenuEntry => ({
                    label: l ? EFFORT_WORDS[l] : 'Model default',
                    icon: !pro.value?.auto && (pro.value?.level ?? null) === l ? 'check' : undefined,
                    onSelect: () => saveDefault({ level: l, auto: false }),
                  }),
                ),
              ],
            },
          ]
        : [
            { kind: 'separator' },
            { kind: 'label', label: 'This notebook' },
            { label: 'Auto (Pro)', icon: 'seal', onSelect: () => setUpsell(true) },
            { label: 'Notebook default (Pro)', icon: 'seal', onSelect: () => setUpsell(true) },
          ];
  const items: MenuEntry[] = [
    { kind: 'label', label: 'How hard the model thinks' },
    {
      label: fromNotebook && notebookWord ? `Notebook default (${notebookWord})` : 'Model default',
      icon: value === null ? 'check' : undefined,
      onSelect: () => void setEffort(threadId, null),
    },
    ...levels.map(
      (l): MenuEntry => ({
        label: EFFORT_WORDS[l],
        icon: value === l ? 'check' : undefined,
        onSelect: () => void setEffort(threadId, l),
      }),
    ),
    ...proRows,
    { kind: 'separator' },
    { kind: 'label', label: 'Higher can cost more. Changing it keeps the cache.' },
  ];
  const from = word && value === null ? ', from the notebook' : '';
  const said = `Thinking effort: ${word ? word.toLowerCase() : 'model default'}${from}`;
  return (
    <>
      <DropMenu
        align="start"
        side="top"
        items={items}
        trigger={
          <Tip label={word ? said : 'Thinking effort: the model default'}>
            <button
              type="button"
              className="effort-chip"
              data-set={value ?? undefined}
              data-tour="effort-chip"
              aria-label={`${said}. Change`}
            >
              <Icon name="sparkle" size={12} />
              <BarLabel full={word ? `Effort: ${word}` : 'Effort'} short={word ?? 'Effort'} />
            </button>
          </Tip>
        }
      />
      {upsell ? (
        <Dialog.Root open onOpenChange={setUpsell}>
          <Dialog.Portal>
            <Dialog.Overlay className="scrim" />
            <Dialog.Content className="dialog pack-picker" aria-describedby={undefined}>
              <Dialog.Title className="dialog__title">
                <Icon name="sparkle" size={18} /> Effort for the whole notebook
              </Dialog.Title>
              <div className="pack-picker__locked">
                <p>
                  Choosing the effort for one thread is free and stays that way. Auto and a default for every
                  thread in a notebook are part of Pro.
                </p>
                <ProUpsell feature="flow_lab" build={pro.build} />
              </div>
              <div className="dialog__actions">
                <Dialog.Close asChild>
                  <button type="button" className="btn btn--ghost">
                    Close
                  </button>
                </Dialog.Close>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </>
  );
}
