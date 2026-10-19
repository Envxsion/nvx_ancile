/**
 * ------------------------------------------------------------------
 *  Title    |  A notebook's default effort
 *  Ref      |  ROADMAP EN1 (Pro half) · pro/slot.tsx · thread/EffortChip.tsx
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Set how hard the models think by default for every
 *           |  thread in a notebook, or let NVX Ancile choose by how
 *           |  hard each question is ("Auto"). A thread's own effort
 *           |  still wins. The receipt's Why line says which applied.
 *  How      |  useNotebookEffort reads and saves through Pro's part
 *           |  (ProUi.parts.effortDefaults), only when flow_lab is
 *           |  unlocked. The dialog is opened from the notebook's
 *           |  menu; the effort chip shares the hook. Without Pro
 *           |  the dialog says what it is and what unlocks it, and
 *           |  per-thread effort stays free.
 * ------------------------------------------------------------------
 */

import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useLayer } from '../keys/dispatch';
import { ApiCallError } from '../lib/api';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import { EFFORT_WORDS } from '../thread/effort';
import '../styles/pro-seams.css';
import { Icon } from '../ui/Icon';
import { LoadFailed } from '../ui/LoadFailed';
import { Skeleton } from '../ui/primitives';
import { type EffortDefault, ProUpsell, useProFeature } from './slot';

export const NO_DEFAULT: EffortDefault = { level: null, auto: false };
const key = (notebookId: string) => ['pro', 'effort', notebookId] as const;

/** What the default means, in a few words (the chip's menu and this dialog). */
export function defaultWords(d: EffortDefault | undefined): string {
  if (d?.auto) return 'Auto, by how hard each question is';
  if (d?.level) return EFFORT_WORDS[d.level];
  return 'The model default';
}

/** A notebook's default, once the licence unlocks it; usable false otherwise (the caller shows the upsell). */
export function useNotebookEffort(notebookId: string | null | undefined) {
  const { ui, unlocked, build, loading, noSeat } = useProFeature('flow_lab');
  const part = ui?.parts?.effortDefaults;
  const usable = unlocked && !!part && !!notebookId;
  const q = useQuery({
    queryKey: key(notebookId ?? 'none'),
    enabled: usable,
    staleTime: 30_000,
    queryFn: () => (part as NonNullable<typeof part>).get(notebookId as string),
  });
  const save = useMutation({
    mutationFn: (v: EffortDefault) => (part as NonNullable<typeof part>).set(notebookId as string, v),
    onSuccess: (saved) => queryClient.setQueryData(key(notebookId as string), saved),
    onError: (e) =>
      notify({
        level: 'error',
        title: "The default didn't save",
        body:
          e instanceof ApiCallError
            ? e.body.error.hint
            : 'Nothing changed. Check that NVX Ancile is running, then try again.',
      }),
  });
  return {
    /** Pro is here and unlocked for this person. */
    usable,
    build,
    noSeat,
    loading: loading || (usable && q.isLoading),
    error: usable && q.isError ? q.error : null,
    refetch: () => q.refetch(),
    value: q.data as EffortDefault | undefined,
    save: (v: EffortDefault) =>
      save.mutateAsync(v).then(
        () => true,
        () => false,
      ),
    saving: save.isPending,
  };
}

const CHOICES: { id: string; label: string; hint: string; value: EffortDefault }[] = [
  {
    id: 'model',
    label: 'The model default',
    hint: 'Each model thinks as much as it usually does.',
    value: NO_DEFAULT,
  },
  {
    id: 'low',
    label: 'Low',
    hint: 'Quicker and cheaper. For lookups and rewrites.',
    value: { level: 'low', auto: false },
  },
  {
    id: 'medium',
    label: 'Medium',
    hint: 'A middle way for most questions.',
    value: { level: 'medium', auto: false },
  },
  {
    id: 'high',
    label: 'High',
    hint: 'Slower and can cost more. For hard problems.',
    value: { level: 'high', auto: false },
  },
  {
    id: 'auto',
    label: 'Auto',
    hint: 'A short, cheap check sorts each question as easy, medium or hard first, and picks low, medium or high.',
    value: { level: null, auto: true },
  },
];

const choiceOf = (d: EffortDefault | undefined) =>
  CHOICES.find((c) => c.value.auto === !!d?.auto && c.value.level === (d?.level ?? null))?.id ?? 'model';

export function NotebookEffortDialog({
  notebookId,
  title,
  onClose,
}: {
  notebookId: string;
  title: string;
  onClose: () => void;
}) {
  useLayer(true);
  const e = useNotebookEffort(notebookId);
  const [said, setSaid] = useState('');
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog pack-picker" aria-describedby={undefined}>
          <Dialog.Title className="dialog__title">
            <Icon name="sparkle" size={18} /> Thinking effort for {title || 'this notebook'}
          </Dialog.Title>
          {e.loading ? (
            <Skeleton lines={3} label="Loading the default" />
          ) : e.error ? (
            <LoadFailed error={e.error} what="The effort default" onRetry={() => void e.refetch()} />
          ) : e.usable ? (
            <fieldset className="effort-default">
              <legend className="mute">
                Applies to every thread here that has no effort of its own. Set one on a thread with the
                Effort button to override it. Models that take no effort ignore it.
              </legend>
              {CHOICES.map((c) => (
                <label key={c.id} className="effort-default__row">
                  <input
                    type="radio"
                    name="effort-default"
                    checked={choiceOf(e.value) === c.id}
                    disabled={e.saving}
                    onChange={() =>
                      void e
                        .save(c.value)
                        .then((ok) => ok && setSaid(`Default set to ${c.label.toLowerCase()}.`))
                    }
                  />
                  <span>
                    <b>{c.label}</b>
                    <span className="mute"> {c.hint}</span>
                  </span>
                </label>
              ))}
              <p className="sr-only" role="status" aria-live="polite">
                {said}
              </p>
            </fieldset>
          ) : (
            <div className="pack-picker__locked">
              <p>
                Thinking effort for a single thread is free: use the Effort button beside the model in the
                composer.
              </p>
              <ProUpsell feature="flow_lab" build={e.build} />
            </div>
          )}
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
  );
}
