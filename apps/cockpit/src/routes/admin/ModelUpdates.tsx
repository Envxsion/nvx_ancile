/**
 * ------------------------------------------------------------------
 *  Title    |  Admin → Models: Model updates
 *  Ref      |  roadmap MD4, MD5 · guard rail GR16 · packages/contracts/src/modelwatch.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Once a day Core reads each provider's live model list.
 *           |  This block says how each check went, lists what changed
 *           |  since you last looked (new models, a line moving to a
 *           |  newer model, prices, limits, abilities, retirements),
 *           |  and lets you choose per line whether answers follow the
 *           |  newest model.
 *  How      |  Everything comes from useModelWatch (models/watch.ts).
 *           |  Changes are grouped by kind and each row has its own
 *           |  action. Once the changes have been on screen for three
 *           |  seconds they are marked read; the rows stay until you
 *           |  leave, so a Go back is never snatched away.
 *  Note     |  Following moves a line only after a short test call
 *           |  passes, never to a preview, and keeps a way back.
 * ------------------------------------------------------------------
 */

import type { ModelChange, ModelLine, ModelTier, ModelWatchReport, ProviderCheck } from '@nvx/contracts';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { windowText } from '../../flows/models';
import { usd } from '../../lib/format';
import { PROVIDER_NAME } from '../../lib/mappers';
import {
  addModel,
  checkNow,
  goBack,
  idOf,
  lineOf,
  markSeen,
  moveLineTo,
  nameOf,
  setFollow,
  setOpenRouterPrices,
  useModelWatch,
  watchedOf,
} from '../../models/watch';
import { Switch } from '../../ui/controls';
import { Icon } from '../../ui/Icon';
import '../../styles/models.css';

/* ---- Words ------------------------------------------------------------------ */

const providerName = (p: string) =>
  PROVIDER_NAME[p] ?? (p === 'zai' ? 'Z.ai' : p.charAt(0).toUpperCase() + p.slice(1));

const ABILITY_NOW: Record<string, string> = {
  vision: 'reads images',
  tools: 'uses tools',
  reasoning: 'thinks before answering',
  json: 'gives structured output',
  audio: 'hears audio',
};

const abilityWords = (c: string) => ABILITY_NOW[c] ?? c.replace(/_/g, ' ');
/** "pdf_input" to "pdf input". */
const pretty = (c: string) => c.replace(/[_-]+/g, ' ').trim();

const TIER_LABEL: Record<ModelTier, string> = {
  best: 'Best',
  balanced: 'Balanced',
  fast: 'Fast',
  tiny: 'Tiny',
};
const TIERS: ModelTier[] = ['best', 'balanced', 'fast'];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 hours ago", "yesterday". */
export function agoWords(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${plural(Math.floor(s / 60), 'minute', 'minutes')} ago`;
  if (s < 86_400) return `${plural(Math.floor(s / 3600), 'hour', 'hours')} ago`;
  const d = Math.floor(s / 86_400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

const dateWords = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

const perM = (n: number) => usd(n, Number.isInteger(n) ? 0 : 2);

interface Price {
  input_per_mtok: number;
  output_per_mtok: number;
}
const asPrice = (v: unknown): Price | null => {
  if (!v || typeof v !== 'object') return null;
  const p = v as Partial<Price>;
  return typeof p.input_per_mtok === 'number' && typeof p.output_per_mtok === 'number'
    ? { input_per_mtok: p.input_per_mtok, output_per_mtok: p.output_per_mtok }
    : null;
};

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

interface Limits {
  context?: number;
  output?: number;
}
const asLimits = (v: unknown): Limits => {
  if (typeof v === 'number') return { context: v };
  if (!v || typeof v !== 'object') return {};
  const o = v as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === 'number' ? x : undefined);
  const context = num(o.context_window);
  const output = num(o.max_output);
  return { ...(context !== undefined && { context }), ...(output !== undefined && { output }) };
};

const tokens = (n: number) => n.toLocaleString('en-GB');

/** Where a price came from, in words. */
function sourceWords(report: ModelWatchReport, modelId: string, providerId: string): string | null {
  const m = watchedOf(report, modelId);
  if (!m?.price_source) return null;
  const date = m.price_checked_at ? ` on ${dateWords(m.price_checked_at)}` : '';
  if (m.price_source === 'provider') return `from ${providerName(providerId)}${date}`;
  if (m.price_source === 'openrouter') return `from OpenRouter's list${date}`;
  return `as shipped${date}`;
}

/* ---- One check, in words ---------------------------------------------------- */

export function providerStatus(
  p: ProviderCheck,
  bundledDate: string | null,
): { text: string; tone: 'ok' | 'warn' | 'idle' } {
  if (p.unsupported)
    return {
      text: `No live list from ${providerName(p.provider)}: prices as shipped${bundledDate ? ` on ${dateWords(bundledDate)}` : ''}`,
      tone: 'idle',
    };
  if (!p.ok && p.error_title) return { text: `${p.error_title}. Tries again later`, tone: 'warn' };
  if (!p.checked_at) return { text: 'Not checked yet', tone: 'idle' };
  return { text: `Checked ${agoWords(p.checked_at)}`, tone: 'ok' };
}

/* ---- Busy keys: one thing at a time per row ---------------------------------- */

function useBusy() {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy((s) => new Set(s).add(key));
    try {
      await fn();
    } finally {
      setBusy((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  };
  return { busy, run };
}

type Run = ReturnType<typeof useBusy>['run'];

/* ---- Changes ---------------------------------------------------------------- */

type Group = { kind: ModelChange['kind']; title: string };
const GROUPS: Group[] = [
  { kind: 'new_model', title: 'New models' },
  { kind: 'line_moved', title: 'Moved to latest' },
  { kind: 'price', title: 'Prices' },
  { kind: 'context', title: 'Context and output limits' },
  { kind: 'capability', title: 'Abilities changed' },
  { kind: 'unsupported_capability', title: 'Abilities NVX Ancile does not use yet' },
  { kind: 'retired', title: 'Retired' },
];

function ChangeRow({
  report,
  c,
  busy,
  run,
}: {
  report: ModelWatchReport;
  c: ModelChange;
  busy: ReadonlySet<string>;
  run: Run;
}) {
  const model = watchedOf(report, c.model_id);
  const name = nameOf(report, c.model_id);
  const line = lineOf(report, c);
  const providerId = model?.provider ?? c.model_id.split('/')[0] ?? '';
  const key = `change:${c.id}`;
  let body: ReactNode = null;
  let action: ReactNode = null;

  switch (c.kind) {
    case 'new_model': {
      const price = model?.price;
      body = (
        <>
          <span className="mu-row__name">{name}</span>
          <span className="mu-row__meta">
            {providerName(providerId)}
            {model?.context_window ? ` · ${windowText(model.context_window)} context` : ''}
            {price
              ? ` · ${perM(price.input_per_mtok)} in, ${perM(price.output_per_mtok)} out per million`
              : ''}
          </span>
          {model?.preview ? (
            <span className="tag" title="Offered, never followed automatically">
              Preview
            </span>
          ) : null}
        </>
      );
      action = model?.in_catalogue ? (
        <span className="mute mu-row__done">In your models</span>
      ) : (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={busy.has(key)}
          aria-label={`Add ${name} to your models`}
          onClick={() => void run(key, () => addModel(c.model_id))}
        >
          <Icon name="plus" size={13} />
          Add
        </button>
      );
      break;
    }
    case 'line_moved': {
      const lineName = line?.name ?? 'this line';
      const now = nameOf(report, idOf(c.after) ?? line?.current_id);
      const before = nameOf(report, idOf(c.before) ?? line?.previous_id);
      body = (
        <span className="mu-row__name">
          {c.reason === 'followed' && `${now} now answers where you chose ${lineName}.`}
          {c.reason === 'chosen' && `You moved ${lineName} to ${now}.`}
          {c.reason === 'back' && `${lineName} went back to ${now}.`}
          {c.reason === 'retired' &&
            `${before} was retired, so ${now} now answers where you chose ${lineName}.`}
          {!c.reason && `${lineName} now answers with ${now}.`}
        </span>
      );
      if (line?.previous_id && c.reason !== 'back')
        action = (
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            disabled={busy.has(key)}
            aria-label={`Go back to ${nameOf(report, line.previous_id)} for ${lineName}`}
            onClick={() => void run(key, () => goBack(line.id))}
          >
            <Icon name="undo" size={13} />
            Go back
          </button>
        );
      break;
    }
    case 'price': {
      const was = asPrice(c.before);
      const is = asPrice(c.after);
      const src = sourceWords(report, c.model_id, providerId);
      const amount = (a: number | undefined, b: number | undefined) =>
        a !== undefined && b !== undefined && a !== b ? `${perM(a)} → ${perM(b)}` : perM(b ?? a ?? 0);
      body = (
        <>
          <span className="mu-row__name">
            {name}: {amount(was?.input_per_mtok, is?.input_per_mtok)} in,{' '}
            {amount(was?.output_per_mtok, is?.output_per_mtok)} out per million
          </span>
          {src ? <span className="mu-row__meta">{src}</span> : null}
        </>
      );
      break;
    }
    case 'context': {
      const was = asLimits(c.before);
      const is = asLimits(c.after);
      const parts: string[] = [];
      if (is.context !== undefined && is.context !== was.context)
        parts.push(
          `context ${was.context !== undefined ? `${tokens(was.context)} → ` : ''}${tokens(is.context)} tokens`,
        );
      if (is.output !== undefined && is.output !== was.output)
        parts.push(
          `output ${was.output !== undefined ? `${tokens(was.output)} → ` : ''}${tokens(is.output)} tokens`,
        );
      body = (
        <span className="mu-row__name">
          {name}: {parts.length ? parts.join(', ') : 'limits changed'}
        </span>
      );
      break;
    }
    case 'capability': {
      const was = asList(c.before);
      const is = asList(c.after);
      const gained = is.filter((x) => !was.includes(x)).map(abilityWords);
      const lost = was.filter((x) => !is.includes(x)).map((x) => `no longer ${abilityWords(x)}`);
      const words = [...gained.map((g) => `now ${g}`), ...lost];
      body = (
        <span className="mu-row__name">
          {name} {words.length ? words.join(', ') : 'has changed what it can do'}
        </span>
      );
      break;
    }
    case 'unsupported_capability': {
      const was = asList(c.before);
      const raw = Array.isArray(c.after) ? asList(c.after) : idOf(c.after) ? [idOf(c.after) as string] : [];
      const added = raw.filter((x) => !was.includes(x)).map(pretty);
      body = (
        <>
          <span className="mu-row__name">
            {name}: {added.length ? added.join(', ') : 'new abilities'}
          </span>
          <span className="tag">Not used by NVX Ancile yet</span>
        </>
      );
      break;
    }
    case 'retired': {
      const instead =
        line?.current_id && line.current_id !== c.model_id ? nameOf(report, line.current_id) : null;
      body = (
        <span className="mu-row__name">
          {name} is retired.{instead ? ` ${instead} answers instead.` : ''}
        </span>
      );
      break;
    }
  }

  return (
    <li className="mu-row" data-read={c.seen || undefined}>
      <span className="mu-row__text">{body}</span>
      {action}
    </li>
  );
}

function Changes({
  report,
  busy,
  run,
  onRead,
}: {
  report: ModelWatchReport;
  busy: ReadonlySet<string>;
  run: Run;
  onRead: (ids: string[]) => void;
}) {
  // Rows that were unread when they appeared stay until you leave: reading must not take an action away.
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const unseen = report.changes.filter((c) => !c.seen).map((c) => c.id);
  const unseenKey = unseen.join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: unseenKey stands for unseen
  useEffect(() => {
    if (unseen.length) setShown((s) => new Set([...s, ...unseen]));
  }, [unseenKey]);
  const rows = report.changes.filter((c) => !c.seen || shown.has(c.id));

  // Marked read after three seconds on screen.
  const ref = useRef<HTMLDivElement>(null);
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;
  // biome-ignore lint/correctness/useExhaustiveDependencies: unseenKey stands for unseen
  useEffect(() => {
    const el = ref.current;
    if (!el || unseen.length === 0 || typeof IntersectionObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ids = unseen;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        if (visible && timer === undefined) timer = setTimeout(() => onReadRef.current(ids), 3000);
        if (!visible && timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [unseenKey]);

  if (rows.length === 0)
    return (
      <p className="mute mu-empty" ref={ref as never}>
        Nothing new since the last check.
      </p>
    );
  return (
    <div ref={ref} className="mu-changes">
      {GROUPS.map((g) => {
        const items = rows.filter((c) => c.kind === g.kind);
        if (items.length === 0) return null;
        return (
          <section key={g.kind} className="mu-group" aria-label={g.title}>
            <h4 className="mu-group__title">{g.title}</h4>
            <ul className="mu-list">
              {items.map((c) => (
                <ChangeRow key={c.id} report={report} c={c} busy={busy} run={run} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/* ---- Follow latest ----------------------------------------------------------- */

function LineRow({
  report,
  line,
  busy,
  run,
}: {
  report: ModelWatchReport;
  line: ModelLine;
  busy: ReadonlySet<string>;
  run: Run;
}) {
  const key = `line:${line.id}`;
  const hintId = useId();
  const switchId = useId();
  const p = line.pending;
  const pendingName = p ? nameOf(report, p.model_id) : '';
  const hasHint = p?.state === 'offered' && !line.follow;
  return (
    <li className="mu-line" data-pending={p?.state}>
      <div className="mu-line__main">
        <span className="mu-line__name">{line.name}</span>
        <span className="mu-line__now mute">
          {line.current_id ? nameOf(report, line.current_id) : 'No model yet'}
        </span>
        <span className="mu-line__follow">
          <label htmlFor={switchId} className="mu-line__label">
            Follow latest
          </label>
          <Switch
            id={switchId}
            checked={line.follow}
            label={`Follow latest for ${line.name}`}
            disabled={busy.has(key)}
            {...(hasHint && { describedBy: hintId })}
            onChange={(next) => void run(key, () => setFollow(line.id, next))}
          />
        </span>
      </div>
      {line.previous_id ? (
        <div className="mu-line__sub">
          <button
            type="button"
            className="link-btn link-btn--quiet"
            disabled={busy.has(`${key}:back`)}
            onClick={() => void run(`${key}:back`, () => goBack(line.id))}
          >
            Go back to {nameOf(report, line.previous_id)}
          </button>
        </div>
      ) : null}
      {p?.state === 'offered' ? (
        <div className="mu-line__sub">
          <span>{pendingName} is out.</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy.has(`${key}:use`)}
            aria-label={`Use ${pendingName} for ${line.name}`}
            onClick={() => void run(`${key}:use`, () => moveLineTo(line.id, p.model_id))}
          >
            Use it
          </button>
          {hasHint ? (
            <span id={hintId} className="mute mu-line__hint">
              Turn on Follow latest to move automatically after a test call
            </span>
          ) : null}
        </div>
      ) : null}
      {p?.state === 'testing' ? (
        <div className="mu-line__sub" role="status">
          <span className="live-dot" aria-hidden="true" />
          <span>Testing {pendingName}</span>
        </div>
      ) : null}
      {p?.state === 'failed' ? (
        <div className="mu-line__sub" data-failed>
          <span>{p.detail ?? `${pendingName} did not pass its test call.`}</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy.has(`${key}:retry`)}
            onClick={() => void run(`${key}:retry`, () => checkNow(line.provider))}
          >
            Try again
          </button>
        </div>
      ) : null}
    </li>
  );
}

function FollowTable({
  report,
  busy,
  run,
}: {
  report: ModelWatchReport;
  busy: ReadonlySet<string>;
  run: Run;
}) {
  const providers = [...new Set(report.lines.map((l) => l.provider))];
  if (providers.length === 0) return null;
  return (
    <div className="mu-follow">
      <h4 className="mu-group__title">Follow latest</h4>
      <p className="mute mu-lede">
        Where you choose a line (like Claude Opus), answers use its newest model. Following moves it only
        after a short test call passes, never to a preview, and you can always go back.
      </p>
      {providers.map((prov) => (
        <section key={prov} className="mu-provider" aria-label={`${providerName(prov)} lines`}>
          <h5 className="mu-provider__name">{providerName(prov)}</h5>
          {TIERS.map((tier) => {
            const lines = report.lines.filter((l) => l.provider === prov && l.tier === tier);
            if (lines.length === 0) return null;
            return (
              <div key={tier} className="mu-tier">
                <span className="mu-tier__label">{TIER_LABEL[tier]}</span>
                <ul className="mu-lines">
                  {lines.map((l) => (
                    <LineRow key={l.id} report={report} line={l} busy={busy} run={run} />
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

/* ---- The block --------------------------------------------------------------- */

export function ModelUpdates() {
  const watch = useModelWatch();
  const { busy, run } = useBusy();
  const report = watch.data;
  if (!report) return null;

  const unseen = report.changes.filter((c) => !c.seen);
  const checking = busy.has('check');
  const actions = (
    <span className="mu-actions">
      {unseen.length > 0 ? (
        <button
          type="button"
          className="link-btn link-btn--quiet"
          onClick={() => void markSeen(unseen.map((c) => c.id))}
        >
          Mark all as read
        </button>
      ) : null}
      {report.providers.length > 0 ? (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={checking}
          aria-busy={checking}
          onClick={() => void run('check', () => checkNow())}
        >
          <Icon name="regenerate" size={13} />
          {checking ? 'Checking' : 'Check now'}
        </button>
      ) : null}
    </span>
  );
  return (
    <section className="model-block mu" aria-labelledby="models-updates">
      <header className="model-block__head">
        <h3 id="models-updates" className="admin__h model-block__title">
          Model updates
        </h3>
        {actions}
      </header>
      <p className="sr-only" role="status">
        {checking ? 'Checking for new models' : ''}
      </p>
      {report.providers.length === 0 ? (
        <p className="mute mu-empty">Add an API key to check its models daily.</p>
      ) : (
        <>
          <ul className="mu-providers">
            {report.providers.map((p) => {
              const s = providerStatus(p, report.bundled_prices_date);
              return (
                <li key={p.provider} className="mu-provider-status" data-tone={s.tone}>
                  <span
                    className="dot"
                    data-status={s.tone === 'ok' ? 'ok' : s.tone === 'warn' ? 'degraded' : 'idle'}
                    aria-hidden="true"
                  />
                  <span className="mu-provider-status__name">{providerName(p.provider)}</span>
                  <span className="mute">{s.text}</span>
                </li>
              );
            })}
          </ul>
          <Changes report={report} busy={busy} run={run} onRead={(ids) => void markSeen(ids)} />
          <FollowTable report={report} busy={busy} run={run} />
        </>
      )}
      <div className="mu-setting">
        <div className="mu-setting__text">
          <span id="mu-or-label" className="mu-setting__name">
            Check prices against OpenRouter's public list
          </span>
          <span id="mu-or-hint" className="mute">
            No key or data is sent, only the request for the list.
          </span>
        </div>
        <Switch
          checked={report.openrouter_prices}
          label="Check prices against OpenRouter's public list"
          describedBy="mu-or-hint"
          disabled={busy.has('openrouter')}
          onChange={(next) => void run('openrouter', () => setOpenRouterPrices(next))}
        />
      </div>
    </section>
  );
}
