/**
 * ------------------------------------------------------------------
 *  Title    |  The answer's receipt
 *  Ref      |  roadmap WY1 · DESIGN.md §11.4
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What one answer was, under the answer itself: which
 *           |  model and who paid, what it cost to the cent and the
 *           |  cache, what went in, and anything worth knowing. It
 *           |  replaces the drawer's Why tab.
 *  How      |  Opens from the strip (ReceiptStrip), or from anything
 *           |  that used to open Why: the W key, the Grounding chip,
 *           |  the flow chip. Sections that need only the message
 *           |  show at once; the rest fill in from
 *           |  GET /messages/:id/explain. A section with nothing to
 *           |  say is left out. Escape closes it and puts focus back
 *           |  on the strip. Figures come from figures.ts.
 *  Note     |  Older answers lack rates, cache writes and per-call
 *           |  records: the receipt says "not recorded for older
 *           |  answers" for those and never shows a made-up 0.
 * ------------------------------------------------------------------
 */

import type { Explain, Recovered } from '@nvx/contracts';
import { ClaudeCodeSetupReport, claudeCodeSetupLine } from '@nvx/contracts/claudecode';
import { isLineAlias } from '@nvx/contracts/modelwatch';
import { AnimatePresence, m as motion } from 'motion/react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { ShadowAnswerLink } from '../flows/ShadowAnswer';
import { useThread } from '../lib/data';
import { useDemoData } from '../lib/demoData';
import { startFactcheck, useExplain } from '../lib/factcheck';
import { modelById, modelName, percent } from '../lib/format';
import { shortResource } from '../lib/mappers';
import { useReducedMotion } from '../lib/motion';
import { VERDICT_WORDS } from '../lib/selectionWords';
import type { MessageView } from '../lib/types';
import { billingWords } from '../models/billing';
import { ServedBy } from '../openrouter/ServedBy';
import { scopeChip, scopeSummary } from '../scopes/api';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../ui/primitives';
import { claudeCodeCostWords } from '../usage/planCost';
import { type ReceiptFacts, receiptFacts } from './facts';
import {
  askedWords,
  buildSteps,
  costTable,
  type Known,
  money,
  payKind,
  planEstimateWords,
  ratePerMillion,
  recoveredWords,
  savingWords,
  searchFactsOf,
  secondsWords,
  toolPartsOf,
  turnSummary,
  whyThisModel,
} from './figures';
import { ReceiptPro } from './ReceiptPro';
import { receiptId, stripId } from './ReceiptStrip';
import { LinksUsed, MemoryFiles, Retrieval } from './Sections';
import { Timeline } from './Timeline';

const n = (v: number) => v.toLocaleString('en-GB');
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rc__section">
      <h4 className="rc__h">{title}</h4>
      {children}
    </section>
  );
}

/** A line that opens a detail under it. */
function Fold({ label, children }: { label: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="rc-fold">
      <button
        type="button"
        className="rc-fold__btn"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="chevronRight" size={12} className="rc-fold__chev" />
        {label}
      </button>
      {open ? (
        <div className="rc-fold__body" id={id}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

const knownCell = (k: Known): ReactNode =>
  k.state === 'known' ? (
    <span data-num>{n(k.tokens)}</span>
  ) : (
    <span className="mute">{k.state === 'not_reported' ? 'not reported' : 'not recorded'}</span>
  );

/* ---- 1. Answered by -------------------------------------------------------------- */

function AnsweredBy({
  m,
  facts,
  x,
  threadId,
}: {
  m: MessageView;
  facts: ReceiptFacts | null;
  x: Explain | undefined;
  threadId: string;
}) {
  const name = x?.model.name ?? facts?.name ?? modelName(m.modelId);
  const prov = m.provenance;
  const attempts = (x?.attempts ?? prov?.attempts ?? []).map((a) => ({
    name: modelName(a.model),
    reason: a.reason,
  }));
  const requested = x?.model.requested ?? null;
  // A "latest" alias that answered through its own current model.
  const aliasName =
    requested && isLineAlias(requested) && modelById(requested)?.aliasOf === m.modelId && !attempts.length
      ? modelName(requested).replace(/\s*\((latest)\)\s*$/i, '')
      : null;
  const flow = prov?.flow;
  const why = whyThisModel({
    name,
    route: prov?.route,
    attempts,
    aliasName,
    claudeCodeSession: !!prov?.claude_code,
    flowName: flow?.name ?? null,
    learned: flow?.decisions.find((d) => d.learned)?.learned ?? null,
    effort: prov?.effort ?? null,
    unreadyName: prov?.route?.thread_model_unready ? modelName(prov.route.thread_model_unready) : null,
  });
  const billing = facts?.billing;
  return (
    <Section title="Answered by">
      <p className="rc__who">
        <strong>{name}</strong>
        {facts?.badge ? (
          <span className="rc-badge" data-kind={billing?.kind}>
            {facts.badge}
          </span>
        ) : null}
      </p>
      {billing ? (
        <p className="mute">
          {billing.kind === 'credit' ? 'Paid from your included monthly credit' : billingWords(billing)}
          {billing.kind === 'plan'
            ? ', counted against its limits'
            : billing.kind === 'local'
              ? ', no cost'
              : ''}
        </p>
      ) : null}
      <p>{why}</p>
      {flow ? (
        <p>
          <button type="button" className="link-btn" onClick={() => useUi.getState().showTeamwork(m.id)}>
            Show the flow's steps
          </button>
          <ShadowAnswerLink messageId={m.id} />
        </p>
      ) : null}
      {facts ? <ServedBy usage={facts.usage} threadId={threadId} messageId={m.id} /> : null}
    </Section>
  );
}

/* ---- 2. What it cost ------------------------------------------------------------- */

function WhatItCost({ m, facts, x }: { m: MessageView; facts: ReceiptFacts; x: Explain | undefined }) {
  const u = facts.usage;
  const kind = payKind(facts.billing);
  const table = costTable(u, { billing: facts.billing, cacheApart: facts.cacheApart });
  const sameModel = !u.calls || u.calls.every((c) => c.model_id === m.modelId);
  const showRates = table.priced && sameModel;
  const recovered: Recovered[] = x?.recovered ?? m.provenance?.recovered ?? [];
  const hasTools = !!m.parts?.some((p) => p.type === 'tool_call');
  const steps = buildSteps({
    calls: u.calls,
    parts: hasTools || !x ? m.parts : toolPartsOf(x.tools),
    recovered,
    priced: kind === 'key',
    contextDetail: null,
    search: searchFactsOf(x?.retrieval ?? m.provenance?.retrieval ?? null),
  });
  const provider = u.billing?.payer === 'openrouter' ? 'OpenRouter' : 'The provider';

  let total: ReactNode;
  if (kind === 'plan') total = <span>{facts.strip.cost}</span>;
  else if (kind === 'free') total = <span>No cost</span>;
  else if (facts.claudeBilledTo) total = <span>{claudeCodeCostWords(u.cost_usd, facts.claudeBilledTo)}</span>;
  else total = <span data-num>{money(u.cost_usd)}</span>;

  const estimate = kind === 'plan' ? planEstimateWords(u) : null;
  const saved = savingWords(table.saving);
  const plain = kind !== 'key' || !showRates;
  return (
    <Section title="What it cost">
      <table className="rc-table">
        <caption className="sr-only">Tokens{showRates ? ', rates and cost' : ''} for this answer</caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className="rc-table__n">
              Tokens
            </th>
            {showRates ? (
              <>
                <th scope="col" className="rc-table__n">
                  Per million
                </th>
                <th scope="col" className="rc-table__n">
                  Cost
                </th>
              </>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r) => (
            <tr key={r.id}>
              <th scope="row">{r.label}</th>
              <td className="rc-table__n">{knownCell(r.tokens)}</td>
              {showRates ? (
                <>
                  <td className="rc-table__n" data-num>
                    {r.rate !== null ? ratePerMillion(r.rate) : ''}
                  </td>
                  <td className="rc-table__n" data-num>
                    {r.usd !== null ? money(r.usd) : ''}
                  </td>
                </>
              ) : null}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td className="rc-table__n" data-num>
              {n(table.rows.reduce((t, r) => t + (r.tokens.state === 'known' ? r.tokens.tokens : 0), 0))}
            </td>
            {showRates ? <td /> : null}
            {showRates ? <td className="rc-table__n">{total}</td> : null}
          </tr>
        </tfoot>
      </table>
      {plain ? <p className="rc__total">{total}</p> : null}
      {table.billed ? (
        <p>
          {provider} billed <span data-num>{money(table.billed.billedUsd)}</span> (list price{' '}
          <span data-num>{money(table.billed.listUsd)}</span>).
        </p>
      ) : null}
      {saved ? <p>{saved}</p> : null}
      {estimate ? <p className="mute">{estimate}</p> : null}
      {kind === 'key' && !u.rates ? <p className="mute">Rates were not recorded for older answers.</p> : null}
      {u.calls && u.calls.length > 1 ? (
        <Fold label={`${u.calls.length} model calls`}>
          <ol className="rc-calls">
            {u.calls.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: calls are ordered and a model can repeat
              <li key={i}>
                <span>
                  {i + 1}.{' '}
                  {c.stop === 'tool_calls'
                    ? 'Asked for a tool'
                    : c.stop === 'length'
                      ? 'Stopped at the length limit'
                      : c.stop === 'error'
                        ? 'Failed'
                        : 'Answered'}
                </span>
                <span className="mute" data-num>
                  {n(c.input_tokens)} in, {n(c.output_tokens)} out
                </span>
                <span data-num>
                  {kind === 'key' ? money(c.billed_usd ?? c.cost_usd) : secondsWords(c.ms)}
                </span>
              </li>
            ))}
          </ol>
        </Fold>
      ) : null}
      <Timeline
        steps={steps}
        messageId={m.id}
        summary={turnSummary(steps, {
          parts: hasTools || !x ? m.parts : toolPartsOf(x.tools),
          ...(m.usage?.ms ? { totalMs: m.usage.ms } : {}),
        })}
      />
    </Section>
  );
}

/* ---- 3. What went in -------------------------------------------------------------- */

function earlierTurns(m: MessageView, x: Explain | undefined): string | null {
  const ec = m.provenance?.engine_context;
  const comp = x?.compaction ?? m.provenance?.compaction ?? null;
  const bits: string[] = [];
  if (ec) {
    if (ec.verbatim) bits.push(`${n(ec.verbatim)} word for word`);
    if (ec.digested) bits.push(`${plural(ec.digested, 'tool step')} cut to one line`);
    if (ec.recalled.length) bits.push(`${n(ec.recalled.length)} recalled`);
    if (ec.dropped) bits.push(`${n(ec.dropped)} left out to fit`);
  }
  if (comp || ec?.summary_id)
    bits.push(
      comp
        ? `older turns summarised (${n(comp.tokens_before)} tokens became ${n(comp.tokens_after)})`
        : 'older turns summarised',
    );
  return bits.length ? bits.join(', ') : null;
}

function WentIn({
  m,
  facts,
  x,
  threadId,
}: {
  m: MessageView;
  facts: ReceiptFacts | null;
  x: Explain | undefined;
  threadId: string;
}) {
  const thread = useThread(threadId);
  const parent = thread.data?.messages.find((p) => p.id === m.parentId);
  const attached = (parent?.parts ?? []).filter((p) => p.type === 'file' || p.type === 'image').length;
  const cc = !!m.provenance?.claude_code;
  const memory = x?.memory?.files.length ? x.memory : null;
  const r = x?.retrieval ?? m.provenance?.retrieval ?? null;
  const cited = r?.hits.filter((h) => h.cited) ?? [];
  const sourceCount = new Set(r?.hits.map((h) => h.source_id)).size;
  const earlier = earlierTurns(m, x);
  const ec = m.provenance?.engine_context;
  const links = x?.links ?? [];
  const setup = ClaudeCodeSetupReport.safeParse(m.provenance?.claude_code?.setup);
  const lean = setup.success
    ? claudeCodeSetupLine(
        setup.data,
        facts ? facts.usage.input_tokens + (facts.cacheApart ? facts.usage.cached_tokens : 0) : null,
      )
    : null;
  const scope = x?.scope && scopeChip(x.scope) ? scopeSummary(x.scope) : null;
  const sources = x && (r || x.retrieval_error || x.origin === 'claude_code_import');

  const rows: { key: string; node: ReactNode }[] = [];
  if (memory)
    rows.push({
      key: 'memory',
      node: (
        <Fold label={`Memory: ${plural(memory.files.length, 'file')}, ${n(memory.tokens)} tokens`}>
          <MemoryFiles memory={memory} />
        </Fold>
      ),
    });
  if (x && sources && !cc)
    rows.push({
      key: 'sources',
      node: r?.hits.length ? (
        <Fold
          label={`Sources: ${plural(r.hits.length, 'passage')} from ${plural(sourceCount, 'file')}, ${n(cited.length)} cited`}
        >
          <Retrieval x={x} />
        </Fold>
      ) : (
        <div className="rc-line">
          <Retrieval x={x} />
        </div>
      ),
    });
  if (earlier)
    rows.push({
      key: 'earlier',
      node: (
        <p className="rc-line">
          Earlier turns: {earlier}.
          {ec?.recalled.length && threadId ? (
            <span className="mute">
              {' '}
              Recalled:{' '}
              {ec.recalled.slice(0, 6).map((id, i) => (
                <span key={id}>
                  {i ? ', ' : ''}
                  <a href={`/t/${threadId}#${id}`} className="link-btn link-btn--quiet">
                    message {i + 1}
                  </a>
                </span>
              ))}
            </span>
          ) : null}
        </p>
      ),
    });
  if (links.length)
    rows.push({
      key: 'links',
      node: (
        <Fold
          label={`Context links: ${plural(links.filter((l) => l.state === 'used').length, 'link')} used of ${n(links.length)}`}
        >
          <LinksUsed links={links} />
        </Fold>
      ),
    });
  if (scope) rows.push({ key: 'scope', node: <p className="rc-line">Limits on this thread: {scope}.</p> });
  if (cc) {
    rows.push({
      key: 'cc',
      node: <p className="rc-line">Claude Code used its own tools and CLAUDE.md.</p>,
    });
    rows.push({
      key: 'sent',
      node: (
        <p className="rc-line">
          Sent from NVX Ancile: your message
          {attached ? ` and ${plural(attached, 'attached file')}` : ''}.
        </p>
      ),
    });
    if (lean) rows.push({ key: 'lean', node: <p className="rc-line mute">{lean}</p> });
  }
  if (!rows.length) return null;
  return (
    <Section title="What went in">
      {rows.map((row) => (
        <div key={row.key}>{row.node}</div>
      ))}
    </Section>
  );
}

/* ---- 4. Worth knowing ------------------------------------------------------------- */

function WorthKnowing({ m, x }: { m: MessageView; x: Explain | undefined }) {
  const recovered: Recovered[] = x?.recovered ?? m.provenance?.recovered ?? [];
  const error = x?.error ?? m.provenance?.error ?? null;
  const asked = x ? askedWords(x.tools, shortResource) : null;
  const f = x?.factcheck ?? null;
  const items: ReactNode[] = [];
  for (const r of recovered)
    items.push(
      <p key={`${r.what}-${r.name}-${r.attempts}`} className="rc-line">
        <Icon name="warn" size={12} /> {recoveredWords(r)}
      </p>,
    );
  if (error)
    items.push(
      <p key="error" className="rc-line rc-line--error">
        <Icon name="warn" size={12} /> {error.title}. {error.hint}
      </p>,
    );
  if (asked)
    items.push(
      <p key="asked" className="rc-line">
        {asked}.
      </p>,
    );
  if (x)
    items.push(
      <p key="fc" className="rc-line">
        {!f ? (
          <>
            Not fact-checked.{' '}
            <button type="button" className="link-btn" onClick={() => void startFactcheck(x.message_id)}>
              Fact-check this answer
            </button>
          </>
        ) : f.status === 'done' ? (
          <>
            Fact-check: {f.confidence !== null ? <strong data-num>{percent(f.confidence)} </strong> : null}
            {f.summary}{' '}
            <button
              type="button"
              className="link-btn"
              onClick={() => useUi.getState().showEvidence(x.message_id)}
            >
              Show the evidence
            </button>
          </>
        ) : f.status === 'running' ? (
          'Fact-check running.'
        ) : (
          (f.error?.title ?? 'The fact-check did not finish.')
        )}
      </p>,
    );
  // Claims highlighted in this answer and checked (FC3): the verdict, and the way to the evidence.
  const highlighted = x?.selection_checks ?? m.provenance?.selection_checks ?? [];
  for (const c of highlighted.slice(0, 3))
    items.push(
      <p key={c.id} className="rc-line">
        Highlighted claim checked: “{c.text.length > 80 ? `${c.text.slice(0, 80)}…` : c.text}”.{' '}
        <strong>{VERDICT_WORDS[c.verdict].label}.</strong> {c.headline}{' '}
        <button type="button" className="link-btn" onClick={() => useUi.getState().showEvidence(m.id, c.id)}>
          Show the evidence
        </button>
      </p>,
    );
  if (highlighted.length > 3)
    items.push(
      <p key="more-checks" className="rc-line">
        {highlighted.length - 3} more highlighted claims were checked.{' '}
        <button type="button" className="link-btn" onClick={() => useUi.getState().showEvidence(m.id)}>
          Show them all
        </button>
      </p>,
    );
  if (!items.length) return null;
  return <Section title="Worth knowing">{items}</Section>;
}

/* ---- the receipt ------------------------------------------------------------------- */

function Body({ m, threadId }: { m: MessageView; threadId: string }) {
  const demo = useUi((s) => s.demo);
  const q = useExplain(demo ? null : m.id);
  const sample = useDemoData(demo);
  const x = demo ? sample?.demoExplain(m) : q.data;
  const facts = receiptFacts(m);
  return (
    <>
      <h3 className="sr-only">Receipt for this answer</h3>
      <AnsweredBy m={m} facts={facts} x={x} threadId={threadId} />
      {facts ? (
        <WhatItCost m={m} facts={facts} x={x} />
      ) : (
        <Section title="What it cost">
          <p className="mute">Usage was not recorded for this answer.</p>
        </Section>
      )}
      {x ? (
        <>
          <WentIn m={m} facts={facts} x={x} threadId={threadId} />
          <WorthKnowing m={m} x={x} />
        </>
      ) : !demo && q.isPending ? (
        <Skeleton lines={3} label="Gathering the rest of the receipt" />
      ) : (
        <>
          <WentIn m={m} facts={facts} x={undefined} threadId={threadId} />
          <WorthKnowing m={m} x={undefined} />
          {!demo && q.isError ? (
            <p className="mute rc__note">
              The rest of this answer's record could not be read. Check that Core is running, then{' '}
              <button type="button" className="link-btn" onClick={() => void q.refetch()}>
                try again
              </button>
              .
            </p>
          ) : null}
        </>
      )}
      {facts ? <ReceiptPro m={m} threadId={threadId} /> : null}
      {x ? (
        <footer className="rc__foot">
          <a className="btn btn--ghost btn--sm" href={x.trace_url} title={`Trace ${x.trace_id}`}>
            <Icon name="logs" size={13} />
            Open the trace
          </a>
        </footer>
      ) : null}
    </>
  );
}

/** Close this receipt and put focus back on its strip (or the answer, when it has none). */
export function closeReceipt(messageId: string) {
  useUi.getState().setReceipt(null);
  const el = document.getElementById(stripId(messageId));
  (el ?? document.getElementById(`msg-${messageId}`))?.focus();
}

export function Receipt({ m, threadId }: { m: MessageView; threadId: string }) {
  const open = useUi((s) => s.receiptOpen === m.id);
  const asked = useUi((s) => s.receiptScroll);
  const reduce = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const askedAt = asked?.id === m.id ? asked.at : 0;

  // Asked for by W, the Grounding chip or a link: bring it into view and read it out.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a fresh request (askedAt) or opening runs this
  useEffect(() => {
    if (!open || !askedAt) return;
    const t = requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.scrollIntoView?.({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
      el.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(t);
  }, [open, askedAt]);

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.section
          key="receipt"
          ref={ref}
          id={receiptId(m.id)}
          className="rc"
          aria-label="Receipt"
          tabIndex={-1}
          initial={reduce ? false : { height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0 }}
          transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 36 }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              closeReceipt(m.id);
            }
          }}
        >
          <div className="rc__inner">
            <Body m={m} threadId={threadId} />
          </div>
        </motion.section>
      ) : null}
    </AnimatePresence>
  );
}
