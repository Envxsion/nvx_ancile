/**
 * ------------------------------------------------------------------
 *  Title    |  Merge two branches
 *  Ref      |  DESIGN.md §8.3
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Keep the best of both branches in a new thread, without
 *           |  touching either: pick the messages yourself, or let a
 *           |  model write one combined answer that says which side
 *           |  each point came from.
 *  How      |  Both paths are loaded exactly to their heads; what they
 *           |  share is carried over automatically, and only what came
 *           |  after the split is offered as picks. Branch A starts
 *           |  ticked: it is usually where you were.
 * ------------------------------------------------------------------
 */

import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useLayer } from '../keys/dispatch';
import { merge, pathTo } from '../lib/branching';
import { useThread } from '../lib/data';
import { modelName } from '../lib/format';
import { partsText } from '../lib/mappers';
import type { MessageView } from '../lib/types';
import { notify } from '../state/notify';
import { plainQuote } from '../thread/Citations';
import { Check, Segmented } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../ui/primitives';
import { type ComparePair, useBranchLayer } from './store';

type Strategy = 'manual' | 'synthesize';

function split(a: MessageView[], b: MessageView[]) {
  let i = 0;
  while (i < a.length && i < b.length && a[i]?.id === b[i]?.id) i++;
  return { shared: a.slice(0, i), a: a.slice(i), b: b.slice(i) };
}

const firstLine = (m: MessageView) => {
  const t = plainQuote(partsText(m.parts)).replace(/\s+/g, ' ').trim();
  return t.length > 140 ? `${t.slice(0, 139)}…` : t || 'Empty message';
};

function Pick({
  m,
  checked,
  onChange,
}: {
  m: MessageView;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the Check inside is the control
    <label className="merge__pick" data-checked={checked || undefined} data-role={m.role}>
      <Check checked={checked} onChange={onChange} label={`Keep: ${firstLine(m)}`} />
      <span className="merge__who">{m.role === 'user' ? 'You' : modelName(m.modelId)}</span>
      <span className="merge__line">{firstLine(m)}</span>
    </label>
  );
}

function Body({ pair, onDone }: { pair: ComparePair & { strategy?: Strategy }; onDone: () => void }) {
  const thread = useThread(pair.threadId);
  const navigate = useNavigate();
  const [strategy, setStrategy] = useState<Strategy>(pair.strategy ?? 'manual');
  const [title, setTitle] = useState('');
  const [picks, setPicks] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const paths = useQuery({
    queryKey: ['compare-paths', pair.threadId, pair.a, pair.b],
    queryFn: async () => {
      const [a, b] = await Promise.all([pathTo(pair.threadId, pair.a), pathTo(pair.threadId, pair.b)]);
      return { a, b };
    },
    staleTime: 60_000,
  });
  const parts = useMemo(() => (paths.data ? split(paths.data.a, paths.data.b) : null), [paths.data]);

  useEffect(() => {
    if (parts) setPicks(new Set(parts.a.map((m) => m.id)));
  }, [parts]);
  useEffect(() => {
    if (thread.data?.title) setTitle(`${thread.data.title} (merged)`);
  }, [thread.data?.title]);

  const toggle = (id: string, on: boolean) =>
    setPicks((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const ordered = parts ? [...parts.a, ...parts.b].filter((m) => picks.has(m.id)).map((m) => m.id) : [];
  const ready = strategy === 'synthesize' || ordered.length > 0;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    const r = await merge({
      thread_id: pair.threadId,
      a: pair.a,
      b: pair.b,
      strategy,
      ...(strategy === 'manual' && { picks: ordered }),
      ...(title.trim() && { title: title.trim() }),
    });
    setBusy(false);
    if (!r) return;
    onDone();
    notify({
      level: 'success',
      title: 'Merged into a new thread',
      body:
        strategy === 'manual'
          ? `${r.copied} messages carried over, each marked with where it came from.`
          : 'One combined answer, with each point marked A or B.',
    });
    void navigate({ to: '/t/$threadId', params: { threadId: r.thread_id } });
  };

  return (
    <form
      className="merge"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Segmented<Strategy>
        label="How to merge"
        value={strategy}
        onChange={setStrategy}
        options={[
          { value: 'manual', label: 'Pick messages', icon: 'check' },
          { value: 'synthesize', label: 'Let a model combine them', icon: 'sparkle' },
        ]}
      />
      <p className="mute merge__explain">
        {strategy === 'manual'
          ? 'The new thread gets everything before the split, then the messages you keep, in order. Nothing changes here.'
          : 'The new thread gets everything before the split, then one answer that combines both branches and marks each point [A] or [B].'}
      </p>

      <label className="field">
        <span className="field__label">Title of the new thread</span>
        <input className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </label>

      {strategy === 'manual' ? (
        paths.isPending ? (
          <Skeleton lines={4} label="Loading both branches" />
        ) : parts ? (
          <div className="merge__cols">
            <fieldset className="merge__col" data-side="A">
              <legend>
                <span className="cmp__side" data-side="A">
                  A
                </span>{' '}
                {parts.a.length} after the split
              </legend>
              {parts.a.map((m) => (
                <Pick key={m.id} m={m} checked={picks.has(m.id)} onChange={(v) => toggle(m.id, v)} />
              ))}
            </fieldset>
            <fieldset className="merge__col" data-side="B">
              <legend>
                <span className="cmp__side" data-side="B">
                  B
                </span>{' '}
                {parts.b.length} after the split
              </legend>
              {parts.b.map((m) => (
                <Pick key={m.id} m={m} checked={picks.has(m.id)} onChange={(v) => toggle(m.id, v)} />
              ))}
            </fieldset>
          </div>
        ) : null
      ) : null}

      <div className="dialog__actions">
        <span className="mute merge__count">
          {parts ? (
            <>
              <span data-num>{parts.shared.length}</span> shared
            </>
          ) : null}
          {strategy === 'manual' && parts ? (
            <>
              {' · '}
              <span data-num>{ordered.length}</span> picked
            </>
          ) : null}
        </span>
        <Dialog.Close className="btn btn--ghost" type="button">
          Cancel
        </Dialog.Close>
        <button type="submit" className="btn btn--primary" disabled={!ready} data-busy={busy || undefined}>
          <Icon name="merge" size={14} />
          {busy ? (strategy === 'synthesize' ? 'Combining' : 'Merging') : 'Create merged thread'}
        </button>
      </div>
    </form>
  );
}

export function MergeDialog() {
  const pair = useBranchLayer((s) => s.merge);
  const setMerge = useBranchLayer((s) => s.setMerge);
  useLayer(!!pair);
  return (
    <Dialog.Root open={!!pair} onOpenChange={(o) => !o && setMerge(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog dialog--wide" aria-describedby={undefined}>
          <Dialog.Title className="dialog__title">
            <Icon name="merge" size={18} /> Merge into a new thread
          </Dialog.Title>
          {pair ? <Body pair={pair} onDone={() => setMerge(null)} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
