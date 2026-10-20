/**
 * ------------------------------------------------------------------
 *  Title    |  Decision models: the router
 *  Ref      |  docs/decisions.md (How a route is chosen) · DESIGN.md D30
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Answer "decide this" for every caller (Auto review, flow
 *           |  routers, fact-check triage, Keystone intent, automations)
 *           |  with one call, picking the route that costs least and
 *           |  respects the notebook's privacy, and never blocking a
 *           |  turn: when nothing can answer, say so and let the caller
 *           |  carry on its usual way.
 *  How      |  1. Privacy: a private notebook may use a decision server
 *           |  on this machine or your GPU node first; hosted routes
 *           |  only with Settings → Private notebooks → hosted decision
 *           |  models. 2. Rank what is connected: a free allowance that
 *           |  still fits the request (counted, never past the ceiling)
 *           |  and suits the task first, then the cheapest paid route
 *           |  that suits, then routes that suit less. 3. Try them in
 *           |  turn: 402 or a spent allowance leaves that route, a
 *           |  provider that refuses leaves for a while, an outage goes
 *           |  to the next. Caps per provider, route and model hold the
 *           |  paid ones to a daily spend.
 *  Note     |  Billing is input tokens only and there is no provider-
 *           |  side caching, so a receipt carries no cache field. A
 *           |  Cloudflare route is used only inside its free allowance:
 *           |  past it Workers AI bills, and this layer never takes
 *           |  that step for you. Pro may replace the tie order per
 *           |  task through `taskOrder` (per-task model choice).
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  DEFAULT_PROVIDER_CAP_USD,
  type DecisionAnswer,
  type DecisionReceipt,
  type DecisionRequest,
  type DecisionRouteId,
  type DecisionRouteInfo,
  DecisionSettings,
  type DecisionStatus,
  type DecisionTaskId,
  type PrivacyCapability,
  type PutDecisionSettingsRequest,
} from '@nvx/contracts';
import { CircuitBreaker, ClassifiedError } from '@nvx/resilience';
import { type Allowances, type Counters, nextUtcMidnight } from '../free/allowances';
import { liveGuardActive } from '../gateway/e2e-guard';
import { logFor } from '../obs/logger';
import type { PrivacyAnswer, PrivacyContext } from '../privacy/policy';
import type { SettingsStore } from '../settings';
import { ALLOWANCE_GONE, approxTokens, callRoute, NO_CREDIT, NOT_ENABLED, probeLocal } from './adapters';
import { ROUTES, type RouteDef, SECRETS, TASK_PROFILES } from './catalogue';

export const DECISIONS_SETTING = 'decisions.settings';

const log = logFor('decisions');

export interface DecisionContext extends PrivacyContext {
  /** Only routes on this machine ('local') or only hosted ones ('hosted'); absent: any the policy allows. */
  only?: 'local' | 'hosted';
  signal?: AbortSignal;
  traceId?: string;
}

export type DecisionResult =
  | {
      ok: true;
      answers: Record<string, DecisionAnswer>;
      receipt: DecisionReceipt;
      /** Routes tried before the one that answered, and why each could not. */
      tried: { route: DecisionRouteId; reason: string }[];
    }
  | {
      ok: false;
      /** One quiet sentence for the caller to show or log: nothing was lost, the usual way was used. */
      note: string;
      tried: { route: DecisionRouteId; reason: string }[];
    };

export interface DecisionRouterDeps {
  settings: SettingsStore;
  counters: Counters;
  allowances: Allowances;
  secrets: { get(name: string): Promise<string | undefined> };
  privacy: { resolve(capability: PrivacyCapability, ctx?: PrivacyContext): Promise<PrivacyAnswer> };
  fetch?: typeof fetch;
  now?: () => number;
  breaker?: CircuitBreaker;
  /** Pro: a per-task route order that replaces the saved one. Absent in the free build. */
  taskOrder?: (task: DecisionTaskId) => DecisionRouteId[] | null | undefined;
}

interface Cooldown {
  until: number;
  reason: string;
}

const REFUSE_MS = { credit: 15 * 60_000, key: 10 * 60_000, notEnabled: 60 * 60_000 } as const;
const PROBE_TTL_MS = 30_000;
const RECENT = 50;

export class DecisionRouter {
  private readonly cooldowns = new Map<string, Cooldown>();
  private readonly recent: DecisionReceipt[] = [];
  private readonly breaker: CircuitBreaker;
  private probe: { at: number; url: string; ok: boolean } | null = null;
  private cached: DecisionSettings | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: DecisionRouterDeps) {
    this.breaker = deps.breaker ?? new CircuitBreaker();
    this.now = deps.now ?? Date.now;
  }

  /* ---- settings ---------------------------------------------------------------- */

  async settings(): Promise<DecisionSettings> {
    if (!this.cached)
      this.cached = DecisionSettings.parse((await this.deps.settings.get(DECISIONS_SETTING)) ?? {});
    return this.cached;
  }

  async update(patch: PutDecisionSettingsRequest): Promise<DecisionSettings> {
    const cur = await this.settings();
    const next = DecisionSettings.parse({ ...cur, ...patch, local: { ...cur.local, ...patch.local } });
    if (next.local.url && !/^https?:\/\//i.test(next.local.url)) throw badLocalUrl(next.local.url);
    await this.deps.settings.set(DECISIONS_SETTING, next);
    this.cached = next;
    this.probe = null;
    return next;
  }

  /* ---- what is connected ------------------------------------------------------- */

  /** A decision server on this machine (or your node) answers. Cached for 30 seconds. */
  async localAvailable(): Promise<boolean> {
    const url = (await this.settings()).local.url;
    if (!url) return false;
    if (this.probe && this.probe.url === url && this.now() - this.probe.at < PROBE_TTL_MS)
      return this.probe.ok;
    const key = await this.deps.secrets.get(SECRETS.local);
    const ok = await probeLocal(url, key?.trim() || undefined, {
      ...(this.deps.fetch && { fetch: this.deps.fetch }),
      breaker: this.breaker,
    });
    this.probe = { at: this.now(), url, ok };
    return ok;
  }

  /** Is any hosted route switched on and connected? Cheap: no call is made. */
  async hasHosted(): Promise<boolean> {
    if (liveGuardActive()) return false;
    const s = await this.settings();
    for (const def of ROUTES) {
      if (def.local || s.disabled.includes(def.id)) continue;
      if ((await this.credentials(def)).connected) return true;
    }
    return false;
  }

  private async credentials(def: RouteDef) {
    if (def.local)
      return { key: (await this.deps.secrets.get(SECRETS.local))?.trim() || undefined, connected: true };
    const key = def.secret ? (await this.deps.secrets.get(def.secret))?.trim() || undefined : undefined;
    if (def.shape === 'cloudflare') {
      const accountId = (await this.deps.secrets.get(SECRETS.cloudflareAccount))?.trim() || undefined;
      return { key, accountId, connected: !!key && !!accountId };
    }
    return { key, connected: !!key };
  }

  private cooling(def: RouteDef): Cooldown | null {
    const c = this.cooldowns.get(def.provider);
    if (!c) return null;
    if (c.until <= this.now()) {
      this.cooldowns.delete(def.provider);
      return null;
    }
    return c;
  }

  /* ---- spend ------------------------------------------------------------------- */

  private capFor(s: DecisionSettings, def: RouteDef, model: string): { key: string; usd: number }[] {
    const keyOf = (scope: 'provider' | 'route' | 'model', key: string) => `spend:${scope}:${key}`;
    const set = (scope: 'provider' | 'route' | 'model', key: string, fallback: number | null) => {
      const own = s.caps.find((c) => c.scope === scope && c.key === key);
      const usd = own?.usd_per_day ?? fallback;
      return usd === null ? [] : [{ key: keyOf(scope, key), usd }];
    };
    return [
      ...set('provider', def.provider, def.local ? null : DEFAULT_PROVIDER_CAP_USD),
      ...set('route', def.id, null),
      ...set('model', model, null),
    ];
  }

  private async withinCaps(
    s: DecisionSettings,
    def: RouteDef,
    model: string,
    costUsd: number,
  ): Promise<boolean> {
    for (const cap of this.capFor(s, def, model)) {
      if ((await this.deps.counters.get(cap.key)) + costUsd > cap.usd) return false;
    }
    return true;
  }

  /* ---- choosing ---------------------------------------------------------------- */

  /**
   * Decide `request` for `task`. Never throws for a provider problem: a failed or absent decision
   * model gives `{ ok: false, note }` and the caller does what it did before.
   */
  async decide(
    task: DecisionTaskId,
    request: DecisionRequest,
    ctx: DecisionContext = {},
  ): Promise<DecisionResult> {
    const tried: { route: DecisionRouteId; reason: string }[] = [];
    const s = await this.settings();
    const profile = TASK_PROFILES[task];
    const priv = await this.deps.privacy.resolve('decisions_off_machine', ctx);
    const isPrivate = priv.via !== 'not_private';
    const hostedAllowed = priv.allowed && !priv.must_run_local && !liveGuardActive();
    const localOk = s.local.url ? await this.localAvailable() : false;
    const estTokens = approxTokens(JSON.stringify(request));
    const order = this.deps.taskOrder?.(task) ?? s.order;

    type Cand = {
      def: RouteDef;
      model: string;
      group: number;
      rank: number;
      fraction: number;
      price: number;
      idx: number;
    };
    const cands: Cand[] = [];
    for (const def of ROUTES) {
      if (s.disabled.includes(def.id)) continue;
      if (ctx.only === 'local' && !def.local) continue;
      if (ctx.only === 'hosted' && def.local) continue;
      if (def.local) {
        if (!localOk) continue;
      } else {
        if (!(await this.credentials(def)).connected) continue;
        if (!hostedAllowed) {
          tried.push({ route: def.id, reason: 'This notebook is private: hosted decision models are off.' });
          continue;
        }
        const cool = this.cooling(def);
        if (cool) {
          tried.push({ route: def.id, reason: cool.reason });
          continue;
        }
      }
      const model = def.local ? s.local.model : (def.models[0] as string);
      if (def.context && estTokens > def.context) {
        tried.push({
          route: def.id,
          reason: `Too long for ${def.label} (${def.context.toLocaleString('en-AU')} tokens).`,
        });
        continue;
      }
      const estNeurons = def.allowance ? (estTokens * def.allowance.per_mtok) / 1_000_000 : 0;
      // A Cloudflare route is only ever used inside its free allowance (the margin is the ceiling).
      if (def.allowance && !(await this.deps.allowances.canSpend(def.allowance.id, estNeurons, s.ceilings))) {
        tried.push({ route: def.id, reason: 'Free allowance for today is used up; it resets at 00:00 UTC.' });
        continue;
      }
      const estCost = def.allowance || def.local ? 0 : (estTokens * (def.input_per_mtok ?? 0)) / 1_000_000;
      if (!(await this.withinCaps(s, def, model, estCost))) {
        tried.push({ route: def.id, reason: 'Daily spend cap reached.' });
        continue;
      }
      const free = def.local || !!def.allowance;
      const suitable = def.tier === profile.tier;
      // 0: free and suits, 1: paid and suits, 2: free and suits less, 3: paid and suits less.
      const group = s.free_first ? (suitable ? (free ? 0 : 1) : free ? 2 : 3) : suitable ? 0 : 1;
      const idxIn = order.indexOf(def.id);
      cands.push({
        def,
        model,
        // In a private notebook, a decision server on this machine always goes first.
        rank: isPrivate && def.local ? 0 : 1,
        group,
        fraction: def.allowance
          ? await this.deps.allowances.remainingFraction(def.allowance.id, s.ceilings)
          : 1,
        price: def.local || (free && s.free_first) ? 0 : (def.input_per_mtok ?? Number.MAX_SAFE_INTEGER),
        idx: idxIn === -1 ? 999 : idxIn,
      });
    }
    cands.sort(
      (a, b) =>
        a.rank - b.rank ||
        a.group - b.group ||
        // Free routes: the one with most of its allowance left. Paid: the cheapest.
        (s.free_first && (a.group === 0 || a.group === 2) ? b.fraction - a.fraction : a.price - b.price) ||
        a.idx - b.idx,
    );

    for (const c of cands) {
      const result = await this.tryRoute(c.def, c.model, request, task, profile.timeoutMs, estTokens, s, ctx);
      if (result.ok) return { ok: true, answers: result.answers, receipt: result.receipt, tried };
      tried.push({ route: c.def.id, reason: result.reason });
    }
    const note = noteFor(isPrivate, hostedAllowed, localOk);
    log.info(
      { task, tried: tried.map((t) => t.route), trace_id: ctx.traceId },
      'decisions: none could answer',
    );
    return { ok: false, note, tried };
  }

  private async tryRoute(
    def: RouteDef,
    firstModel: string,
    request: DecisionRequest,
    task: DecisionTaskId,
    timeoutMs: number,
    estTokens: number,
    s: DecisionSettings,
    ctx: DecisionContext,
  ): Promise<
    | { ok: true; answers: Record<string, DecisionAnswer>; receipt: DecisionReceipt }
    | { ok: false; reason: string }
  > {
    const creds = await this.credentials(def);
    const models = def.local ? [firstModel] : def.models;
    let last: unknown;
    for (const model of models) {
      try {
        const out = await callRoute({
          def,
          model,
          key: creds.key,
          accountId: creds.accountId,
          localUrl: s.local.url,
          request,
          timeoutMs,
          signal: ctx.signal,
          fetch: this.deps.fetch,
          breaker: this.breaker,
        });
        const estimated = out.input_tokens === null;
        // Tokens we count ourselves are padded a little so an undercount never walks past the free line.
        const tokens = out.input_tokens ?? Math.ceil(estTokens * 1.15);
        const free = def.local || !!def.allowance;
        const allowanceUsed = def.allowance ? (tokens * def.allowance.per_mtok) / 1_000_000 : 0;
        const cost = free ? 0 : (out.cost_usd ?? (tokens * (def.input_per_mtok ?? 0)) / 1_000_000);
        if (def.allowance) await this.deps.allowances.record(def.allowance.id, allowanceUsed);
        if (cost > 0) {
          for (const cap of [
            `spend:provider:${def.provider}`,
            `spend:route:${def.id}`,
            `spend:model:${out.model}`,
          ])
            await this.deps.counters.add(cap, cost);
        }
        const receipt: DecisionReceipt = {
          route: def.id,
          provider: def.provider,
          model: out.model,
          task,
          input_tokens: tokens,
          output_tokens: out.output_tokens ?? 0,
          cost_usd: cost,
          cost_basis: free ? 'free' : out.cost_usd !== null ? 'reported' : 'listed',
          allowance: def.allowance?.id ?? null,
          allowance_used: allowanceUsed,
          estimated,
          at: new Date(this.now()).toISOString(),
        };
        this.recent.unshift(receipt);
        this.recent.length = Math.min(this.recent.length, RECENT);
        return { ok: true, answers: out.answers, receipt };
      } catch (err) {
        last = err;
        const status = err instanceof ClassifiedError ? err.status : undefined;
        // An unknown or retired model name: the next name on this route.
        if (status === 400 || status === 404 || status === 422) continue;
        break;
      }
    }
    return { ok: false, reason: await this.leave(def, last) };
  }

  /** The route could not answer: remember why where it matters, and say it in words. */
  private async leave(def: RouteDef, err: unknown): Promise<string> {
    const e = err instanceof ClassifiedError ? err : null;
    const text = err instanceof Error ? err.message : String(err);
    if (e?.code === NO_CREDIT) {
      this.cooldowns.set(def.provider, {
        until: this.now() + REFUSE_MS.credit,
        reason: 'Out of credit; moved on.',
      });
      return 'Out of credit (402); moved to the next route.';
    }
    if (e?.code === ALLOWANCE_GONE && def.allowance) {
      await this.deps.allowances.exhaust(def.allowance.id);
      return 'The provider says the free allowance is used up.';
    }
    if (e?.code === NOT_ENABLED) {
      const words = e.title ?? 'Not enabled for this key';
      this.cooldowns.set(def.provider, { until: this.now() + REFUSE_MS.notEnabled, reason: words });
      return words;
    }
    if (e?.status === 401 || e?.status === 403) {
      this.cooldowns.set(def.provider, { until: this.now() + REFUSE_MS.key, reason: 'The key was refused.' });
      return 'The key was refused.';
    }
    return text.slice(0, 200);
  }

  /* ---- the panel --------------------------------------------------------------- */

  async status(): Promise<DecisionStatus> {
    const s = await this.settings();
    const localOk = await this.localAvailable();
    const routes: DecisionRouteInfo[] = [];
    for (const def of ROUTES) {
      const creds = await this.credentials(def);
      const cool = def.local ? null : this.cooling(def);
      let state: DecisionRouteInfo['state'] = 'ready';
      let reason: string | null = null;
      let until: string | null = null;
      if (s.disabled.includes(def.id)) state = 'disabled';
      else if (def.local && !s.local.url) {
        state = 'not_connected';
        reason = 'Set the address of a decision server below.';
      } else if (def.local && !localOk) {
        state = 'not_connected';
        reason = 'Nothing answers at that address.';
      } else if (!def.local && !creds.connected) {
        state = 'not_connected';
        reason = def.shape === 'cloudflare' ? 'Add a Cloudflare token and account ID.' : 'Add a key.';
      } else if (cool) {
        state = 'refused';
        reason = cool.reason;
        until = new Date(cool.until).toISOString();
      } else if (
        def.allowance &&
        !(await this.deps.allowances.canSpend(def.allowance.id, 0.01, s.ceilings))
      ) {
        state = 'spent';
        reason = 'Free allowance used up for today.';
        until = nextUtcMidnight(this.now());
      } else if (!(await this.withinCaps(s, def, def.models[0] as string, 0.000001))) {
        state = 'spent';
        reason = 'Daily spend cap reached.';
        until = nextUtcMidnight(this.now());
      }
      routes.push({
        id: def.id,
        provider: def.provider,
        label: def.label,
        model: def.local ? s.local.model : (def.models[0] as string),
        runs_on_this_machine: def.local,
        tier: def.tier,
        input_per_mtok_usd: def.input_per_mtok,
        state,
        reason,
        until,
        allowance: def.allowance?.id ?? null,
        spent_today_usd: await this.deps.counters.get(`spend:route:${def.id}`),
        verified: def.verified,
        source: def.source,
      });
    }
    return {
      settings: s,
      routes,
      meters: await this.deps.allowances.meters(s.ceilings),
      recent: [...this.recent],
      local_available: localOk,
    };
  }
}

function noteFor(isPrivate: boolean, hostedAllowed: boolean, localOk: boolean): string {
  if (isPrivate && !hostedAllowed && !localOk)
    return 'No decision model on this computer, so the usual way was used. Allow hosted decision models in Settings → Private notebooks to use Jev or Clef here.';
  return 'No decision model answered, so the usual way was used.';
}

export function badLocalUrl(url: string): AncileError {
  return new AncileError({
    code: 'decisions.local_url_invalid',
    title: "That isn't an address a decision server can have",
    hint: 'Use an address that starts with http:// or https://, such as http://localhost:30000. Nothing was saved.',
    status: 422,
    errorClass: 'permanent',
    context: { url: url.slice(0, 80) },
  });
}
