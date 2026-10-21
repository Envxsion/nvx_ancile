/**
 * ------------------------------------------------------------------
 *  Title    |  Settings → Decisions: the panel
 *  Ref      |  docs/decisions.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Show and change how decision models are used.
 *  How      |  GET /decisions gives routes, meters and settings; every
 *           |  change is a PUT /decisions/settings with just that
 *           |  field. The local server address is saved when the field
 *           |  loses focus.
 *  Note     |  Times are the browser's own; the allowance resets at
 *           |  00:00 UTC. Keys are never shown: they live in Settings
 *           |  → API keys.
 * ------------------------------------------------------------------
 */

import type {
  AllowanceMeter,
  DecisionRouteId,
  DecisionRouteInfo,
  DecisionStatus,
  PutDecisionSettingsRequest,
} from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useContext, useId, useState } from 'react';
import { Hint } from '../help/Hint';
import { api } from '../lib/api';
import { queryClient } from '../lib/query';
import { Block, matches, SearchContext } from '../routes/settings/rows';
import { notify } from '../state/notify';
import { Switch } from '../ui/controls';
import { LoadFailed } from '../ui/LoadFailed';
import { Skeleton } from '../ui/primitives';

import '../styles/decisions.css';

const KEY = ['decisions'] as const;
const KEYWORDS = 'decisions decision models clef jev cloudflare free allowance perplexity cap local';

const STATE_WORDS: Record<DecisionRouteInfo['state'], string> = {
  ready: 'Ready',
  not_connected: 'Not set up',
  disabled: 'Off',
  spent: 'Used up for today',
  refused: 'Refused',
  private_blocked: 'Off in private notebooks',
};

const num = (n: number) => n.toLocaleString('en-GB');
const when = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' });

function useStatus() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<DecisionStatus>('/decisions'),
    staleTime: 15_000,
  });
}

function useSave() {
  return useMutation({
    mutationFn: (patch: PutDecisionSettingsRequest) => api.put<DecisionStatus>('/decisions/settings', patch),
    onSuccess: (s) => queryClient.setQueryData(KEY, s),
    onError: (err) =>
      notify({
        level: 'error',
        title: 'Not saved',
        body: err instanceof Error ? err.message : 'Check that NVX Ancile is running, then try again.',
      }),
  });
}

function routeDetail(r: DecisionRouteInfo): string {
  const price =
    r.input_per_mtok_usd === null
      ? 'Priced by the provider per answer.'
      : r.input_per_mtok_usd === 0
        ? 'Runs on your hardware.'
        : `$${r.input_per_mtok_usd} per million input tokens; output is free.`;
  const unverified = r.verified ? '' : ' Not yet documented by the provider; it may refuse your key.';
  return `Model ${r.model}. ${price}${unverified} Source: ${r.source}`;
}

function Meter({ m }: { m: AllowanceMeter }) {
  const pct = Math.min(100, Math.round((m.used / m.limit) * 100));
  return (
    <div className="setting" data-stack>
      <div className="setting__words">
        <div className="setting__label">
          <span>{m.label}</span>
          <Hint id={`decisions-${m.id}`} title={m.label} article="spend-less-on-decisions">
            {`This is the provider's free allowance. It is counted here, and a route is left at ${num(m.ceiling)} so it never goes past ${num(m.limit)}. It resets at 00:00 UTC (${when(m.resets_at)} your time).`}
          </Hint>
        </div>
        <p className="setting__desc">
          {num(m.used)} of {num(m.ceiling)} {m.unit} used today. Resets at {when(m.resets_at)}.
        </p>
      </div>
      <div
        className="decision-meter"
        role="progressbar"
        aria-label={`${m.label} used today`}
        aria-valuemin={0}
        aria-valuemax={m.limit}
        aria-valuenow={m.used}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Settings → Decisions. */
export default function DecisionsPanel() {
  const q = useContext(SearchContext);
  const status = useStatus();
  const save = useSave();
  const urlId = useId();
  const urlHintId = useId();
  const [url, setUrl] = useState<string | null>(null);
  const s = status.data;
  if (s && q && !matches(q, 'Decisions', KEYWORDS)) return null;

  const move = (id: DecisionRouteId, by: -1 | 1) => {
    if (!s) return;
    const order = [...s.settings.order];
    const i = order.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j] as DecisionRouteId, order[i] as DecisionRouteId];
    save.mutate({ order });
  };
  const toggle = (id: DecisionRouteId, on: boolean) => {
    if (!s) return;
    const disabled = on ? s.settings.disabled.filter((x) => x !== id) : [...s.settings.disabled, id];
    save.mutate({ disabled });
  };
  const paid = ['typesafe', 'openrouter', 'perplexity', 'openai'] as const;
  const capOf = (provider: string) =>
    s?.settings.caps.find((c) => c.scope === 'provider' && c.key === provider)?.usd_per_day;
  const setCap = (provider: string, value: string) => {
    if (!s) return;
    const usd = Number(value);
    const rest = s.settings.caps.filter((c) => !(c.scope === 'provider' && c.key === provider));
    if (value.trim() === '' || !Number.isFinite(usd) || usd < 0) return save.mutate({ caps: rest });
    save.mutate({ caps: [...rest, { scope: 'provider', key: provider, usd_per_day: usd }] });
  };

  return (
    <>
      <Block
        tour="decisions-free"
        title="Decision models"
        lede="Small models that pick a route or judge a check with a probability, not prose. Free allowances are used first, then the cheapest that suits the task."
      >
        {status.isPending ? (
          <div className="setting" data-stack>
            <Skeleton lines={4} label="Loading decision settings" />
          </div>
        ) : status.isError && !s ? (
          <div className="setting" data-stack>
            <LoadFailed
              compact
              error={status.error}
              what="Decision settings"
              onRetry={() => status.refetch()}
            />
          </div>
        ) : s ? (
          <>
            <div className="setting">
              <div className="setting__words">
                <div className="setting__label">
                  <span>Use free allowances first</span>
                  <Hint id="decisions-free-first" title="Free first" article="spend-less-on-decisions">
                    On, a route with free allowance left is tried before any paid one. Off, the cheapest route
                    that suits the task is used.
                  </Hint>
                </div>
              </div>
              <div className="setting__control">
                <Switch
                  label="Use free allowances first"
                  checked={s.settings.free_first}
                  onChange={(on) => save.mutate({ free_first: on })}
                />
              </div>
            </div>
            {s.meters.map((m) => (
              <Meter key={m.id} m={m} />
            ))}
          </>
        ) : null}
      </Block>

      {s ? (
        <>
          <Block
            tour="decisions-routes"
            title="Routes"
            lede="The first ready route that suits the task is used. Move one up to prefer it when prices tie."
          >
            {s.settings.order.map((id, i) => {
              const r = s.routes.find((x) => x.id === id);
              if (!r) return null;
              return (
                <div className="setting" key={id}>
                  <div className="setting__words">
                    <div className="setting__label">
                      <span>{r.label}</span>
                      <Hint id={`decisions-${id}`} title={r.label} article="spend-less-on-decisions">
                        {routeDetail(r)}
                      </Hint>
                    </div>
                    <p className="setting__desc">
                      {STATE_WORDS[r.state]}
                      {r.reason ? `. ${r.reason}` : ''}
                    </p>
                  </div>
                  <div className="setting__control decision-route__controls">
                    <button
                      type="button"
                      className="btn btn--quiet btn--sm"
                      aria-label={`Move ${r.label} up`}
                      disabled={i === 0}
                      onClick={() => move(id, -1)}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      className="btn btn--quiet btn--sm"
                      aria-label={`Move ${r.label} down`}
                      disabled={i === s.settings.order.length - 1}
                      onClick={() => move(id, 1)}
                    >
                      Down
                    </button>
                    <Switch
                      label={r.label}
                      checked={r.state !== 'disabled'}
                      onChange={(on) => toggle(id, on)}
                    />
                  </div>
                </div>
              );
            })}
          </Block>

          <Block
            tour="decisions-local"
            title="On this computer"
            lede="A decision server on this computer or your own GPU node counts as private, and is used first in private notebooks."
          >
            <div className="setting" data-stack>
              <div className="setting__words">
                <label htmlFor={urlId} className="setting__label">
                  Server address
                </label>
                <p id={urlHintId} className="setting__desc">
                  {s.local_available
                    ? 'It answers.'
                    : 'Serve Clef-flash with vLLM or SGLang, or Laya with laya-serve, then paste the address, such as http://localhost:30000.'}
                </p>
              </div>
              <input
                id={urlId}
                className="input input--mono"
                type="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="http://localhost:30000"
                aria-describedby={urlHintId}
                value={url ?? s.settings.local.url ?? ''}
                onChange={(e) => setUrl(e.target.value)}
                onBlur={() => {
                  if (url === null) return;
                  const next = url.trim();
                  if (next !== (s.settings.local.url ?? ''))
                    save.mutate({ local: { url: next || null, model: s.settings.local.model } });
                  setUrl(null);
                }}
              />
            </div>
          </Block>

          <Block
            tour="decisions-caps"
            title="Daily spend caps"
            lede="The most each paid provider may cost in a day (UTC). Blank uses $1."
          >
            {paid.map((p) => (
              <div className="setting" key={p}>
                <div className="setting__words">
                  <label htmlFor={`cap-${p}`} className="setting__label">
                    {p === 'typesafe' ? 'TypeSafe' : p[0]?.toUpperCase() + p.slice(1)}
                  </label>
                </div>
                <div className="setting__control">
                  <input
                    id={`cap-${p}`}
                    className="input input--mono"
                    type="number"
                    min={0}
                    step={0.1}
                    placeholder="1"
                    defaultValue={capOf(p) ?? ''}
                    aria-label={`${p} daily cap in US dollars`}
                    onBlur={(e) => setCap(p, e.currentTarget.value)}
                  />
                </div>
              </div>
            ))}
          </Block>
        </>
      ) : null}
    </>
  );
}
