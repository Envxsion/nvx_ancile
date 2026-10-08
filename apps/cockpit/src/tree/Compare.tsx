/**
 * ------------------------------------------------------------------
 *  Title    |  Compare branches
 *  Ref      |  DESIGN.md §8.3
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Two answers to the same moment, side by side, with a
 *           |  plain account of how they differ on top, so choosing
 *           |  (or merging the best of both) is quick.
 *  How      |  Core finds where the paths split and writes the account;
 *           |  the two sides are loaded as exact paths and shown from
 *           |  the split, turn by turn: a question and its answer on
 *           |  one row, so the eye compares like with like. The two
 *           |  columns scroll together.
 * ------------------------------------------------------------------
 */

import type { CompareResult } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { type CSSProperties, useMemo } from 'react';
import { useLayer } from '../keys/dispatch';
import { compare, jumpTo, pathTo } from '../lib/branching';
import { hueVar, modelById, modelName, percent, usd } from '../lib/format';
import type { MessageView } from '../lib/types';
import { CiteProvider, plainQuote } from '../thread/Citations';
import { Parts } from '../thread/Parts';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../ui/primitives';
import { type ComparePair, useBranchLayer } from './store';

type Side = CompareResult['a'];

/** Group a side into turns: a question with what answered it. */
function turns(msgs: MessageView[]): MessageView[][] {
  const out: MessageView[][] = [];
  for (const m of msgs) {
    if (m.role === 'user' || out.length === 0) out.push([m]);
    else out[out.length - 1]?.push(m);
  }
  return out;
}

function Metrics({ side, label }: { side: Side; label: 'A' | 'B' }) {
  const m = side.metrics;
  return (
    <div className="cmp__metrics">
      <span className="cmp__side" data-side={label}>
        {label}
      </span>
      <span>
        <span data-num>{m.messages}</span> {m.messages === 1 ? 'message' : 'messages'}
      </span>
      {m.models.map((id) => {
        const model = modelById(id);
        return (
          <span
            key={id}
            className="msg-model"
            style={{ '--hue': hueVar(model?.hue ?? 'chalk') } as CSSProperties}
          >
            {model?.name ?? modelName(id)}
          </span>
        );
      })}
      <span className="mute" data-num>
        {(m.input_tokens + m.output_tokens).toLocaleString('en-GB')} tok · {usd(m.cost_usd, 3)}
      </span>
      {m.confidence !== null ? (
        <span className="mute" data-num>
          {percent(m.confidence)} confidence
        </span>
      ) : null}
    </div>
  );
}

function Bubble({ m }: { m: MessageView }) {
  return (
    <div className="cmp__msg" data-role={m.role}>
      <span className="cmp__who">{m.role === 'user' ? 'You' : modelName(m.modelId)}</span>
      <div className="cmp__text prose">
        {m.parts ? (
          <CiteProvider parts={m.parts} trace={m.provenance?.retrieval}>
            <Parts parts={m.parts} streaming={false} waiting={false} />
          </CiteProvider>
        ) : null}
      </div>
    </div>
  );
}

function Body({ pair }: { pair: ComparePair }) {
  const res = useQuery({
    queryKey: ['compare', pair.threadId, pair.a, pair.b],
    queryFn: () => compare(pair.threadId, pair.a, pair.b),
    staleTime: 60_000,
    retry: false,
  });
  const sides = useQuery({
    queryKey: ['compare-paths', pair.threadId, pair.a, pair.b],
    queryFn: async () => {
      const [a, b] = await Promise.all([pathTo(pair.threadId, pair.a), pathTo(pair.threadId, pair.b)]);
      return { a, b };
    },
    staleTime: 60_000,
  });
  const setMerge = useBranchLayer((s) => s.setMerge);
  const setCompare = useBranchLayer((s) => s.setCompare);

  const rows = useMemo(() => {
    if (!res.data || !sides.data) return [];
    const ida = new Set(res.data.a.message_ids);
    const idb = new Set(res.data.b.message_ids);
    const ta = turns(sides.data.a.filter((m) => ida.has(m.id)));
    const tb = turns(sides.data.b.filter((m) => idb.has(m.id)));
    return Array.from({ length: Math.max(ta.length, tb.length) }, (_, i) => ({
      a: ta[i] ?? [],
      b: tb[i] ?? [],
    }));
  }, [res.data, sides.data]);

  if (res.isPending)
    return (
      <div className="cmp__loading">
        <Skeleton lines={4} label="Reading both branches" />
        <p className="mute">Reading both branches and writing how they differ.</p>
      </div>
    );
  if (res.isError || !res.data)
    return (
      <p className="cmp__error" role="alert">
        <Icon name="warn" size={14} /> The comparison did not load. Close this and try again.
      </p>
    );
  const r = res.data;
  const c = r.comparison;

  return (
    <>
      <section className="cmp__summary" aria-label="How they differ">
        {c ? (
          <>
            <p className="cmp__lede">{plainQuote(c.summary)}</p>
            {c.differences.length ? (
              <table className="cmp__table">
                <thead>
                  <tr>
                    <th scope="col">Aspect</th>
                    <th scope="col">
                      <span className="cmp__side" data-side="A">
                        A
                      </span>
                    </th>
                    <th scope="col">
                      <span className="cmp__side" data-side="B">
                        B
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {c.differences.map((d) => (
                    <tr key={d.aspect}>
                      <th scope="row">{d.aspect}</th>
                      <td>{plainQuote(d.a)}</td>
                      <td>{plainQuote(d.b)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            <dl className="cmp__better">
              <div>
                <dt>A is better for</dt>
                <dd>{c.better_for.a}</dd>
              </div>
              <div>
                <dt>B is better for</dt>
                <dd>{c.better_for.b}</dd>
              </div>
            </dl>
            <p className="cmp__by mute">
              {r.comparison_model
                ? `Written by ${modelName(r.comparison_model)}.`
                : 'Counted, not read: no model was free to compare them.'}{' '}
              {r.shared} {r.shared === 1 ? 'message' : 'messages'} in common before the split.
            </p>
          </>
        ) : (
          <p className="cmp__lede">These are the same path: there is nothing to compare.</p>
        )}
      </section>

      <div className="cmp__heads">
        <Metrics side={r.a} label="A" />
        <Metrics side={r.b} label="B" />
      </div>

      <div className="cmp__rows" data-scrollable>
        {sides.isPending ? <Skeleton lines={6} label="Loading the messages" /> : null}
        {rows.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: turns are positional by definition
          <div key={i} className="cmp__row">
            <div className="cmp__col" data-side="A">
              {row.a.length ? (
                row.a.map((m) => <Bubble key={m.id} m={m} />)
              ) : (
                <p className="cmp__gap mute">Nothing here on A.</p>
              )}
            </div>
            <div className="cmp__col" data-side="B">
              {row.b.length ? (
                row.b.map((m) => <Bubble key={m.id} m={m} />)
              ) : (
                <p className="cmp__gap mute">Nothing here on B.</p>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="dialog__actions cmp__actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => {
            setCompare(null);
            void jumpTo(pair.threadId, pair.a);
          }}
        >
          Continue on A
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => {
            setCompare(null);
            void jumpTo(pair.threadId, pair.b);
          }}
        >
          Continue on B
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!c}
          onClick={() => {
            setCompare(null);
            setMerge({ ...pair });
          }}
        >
          <Icon name="merge" size={14} />
          Merge into a new thread
        </button>
      </div>
    </>
  );
}

export function CompareDialog() {
  const pair = useBranchLayer((s) => s.compare);
  const setCompare = useBranchLayer((s) => s.setCompare);
  useLayer(!!pair);
  return (
    <Dialog.Root open={!!pair} onOpenChange={(o) => !o && setCompare(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog dialog--wide cmp" aria-describedby={undefined}>
          <header className="cmp__head">
            <Dialog.Title className="dialog__title">
              <Icon name="compare" size={18} /> Compare branches
            </Dialog.Title>
            <Dialog.Close className="icon-btn" aria-label="Close">
              <Icon name="close" size={14} />
            </Dialog.Close>
          </header>
          {pair ? <Body pair={pair} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
