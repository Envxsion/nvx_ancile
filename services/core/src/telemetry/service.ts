/**
 * ------------------------------------------------------------------
 *  Title    |  Telemetry
 *  Ref      |  docs/telemetry.md · packages/contracts/src/telemetry.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Anonymous usage statistics, so NVX Ancile can keep
 *           |  getting better, and only if you say yes.
 *  How      |  Off until consent. Saying yes makes a random install
 *           |  id; saying no erases it with the queue and every
 *           |  counter. Hot paths only add to in-memory counters,
 *           |  written to the per-day table every 30 s; once a day is
 *           |  over it is rolled up into daily_counts, perf, error and
 *           |  exception envelopes and deleted. A batch is at most 50
 *           |  envelopes and under 7,600 bytes, carries a daily proof
 *           |  of work (stamp.ts), and is tried twice, then dropped.
 *  Note     |  Every failure is swallowed: statistics can never break
 *           |  the product. Nothing here reads text you wrote, names,
 *           |  paths, URLs or answers; the contract refuses any key it
 *           |  does not list, and envelopes are checked against it
 *           |  before they are queued.
 * ------------------------------------------------------------------
 */

import { randomUUID } from 'node:crypto';
import { telemetry as T } from '@nvx/contracts';
import { logFor } from '../obs/logger';
import type { SettingsStore } from '../settings';
import * as B from './buckets';
import { makeStamp, stampDay } from './stamp';
import type { TelemetryStore } from './store';

const log = logFor('telemetry');

export const BATCH_MAX = 50;
export const BATCH_BYTES = 7_600;
export const MAX_TRIES = 2;
/** Statistics that never fail the product: a bad send is retried once, then dropped. */
const PERMANENT = new Set([400, 413, 415, 422]);

const K = {
  consent: 'telemetry.consent',
  id: 'telemetry.install_id',
  seq: 'telemetry.seq',
  installedAt: 'telemetry.installed_at',
  version: 'telemetry.version',
  firstUse: 'telemetry.first_use',
  funnel: 'telemetry.funnel',
  lastActive: 'telemetry.last_active_day',
  lastSent: 'telemetry.last_sent_at',
  clientEnv: 'telemetry.client_env',
} as const;

type Data = Record<string, string | number | boolean>;
type Via = 'click' | 'shortcut' | 'palette' | 'api';

const COUNTERS = new Set<string>(T.DAILY_COUNTERS);
/** Counters that run large are sent in WIDE_BUCKETS. */
const WIDE = new Set(['messages', 'answers', 'grounded_answers', 'tool_calls', 'flow_nodes', 'f_send']);
const CODE = /^[a-z_]+\.[a-z_.]+$/;
const KIND = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

export interface TelemetryDeps {
  store: TelemetryStore;
  settings: SettingsStore;
  version: string;
  channel: 'release' | 'dev';
  endpoint?: string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  tier: () => 'free' | 'pro' | 'max_access';
  /** Server-side environment (os, arch, ram, cores). */
  env?: () => Data;
  /** Counts of what is in the workspace, bucketed by the caller. */
  usage?: () => Promise<Data>;
  /** Timers off in tests. */
  timers?: boolean;
}

export class Telemetry {
  private granted = false;
  private pending = new Map<string, number>();
  private pendingDay = '';
  private stamp: { day: string; value: string } | null = null;
  private firstUse = new Set<string>();
  private funnelDone = new Set<string>();
  private clientEnv: Data = {};
  private timers: ReturnType<typeof setInterval>[] = [];
  private usage: TelemetryDeps['usage'];

  constructor(private readonly deps: TelemetryDeps) {
    this.usage = deps.usage;
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  private today() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /** Workspace counts are wired after the services that own them exist. */
  setUsage(fn: () => Promise<Data>) {
    this.usage = fn;
  }

  async start(): Promise<void> {
    try {
      const { settings } = this.deps;
      if (!(await settings.get<string>(K.installedAt)))
        await settings.set(K.installedAt, new Date(this.now()).toISOString());
      this.granted = (await settings.get<string>(K.consent)) === 'granted';
      if (this.granted) {
        this.firstUse = new Set((await settings.get<string[]>(K.firstUse)) ?? []);
        this.funnelDone = new Set((await settings.get<string[]>(K.funnel)) ?? []);
        this.clientEnv = (await settings.get<Data>(K.clientEnv)) ?? {};
        const was = await settings.get<string>(K.version);
        if (was && was !== this.deps.version) {
          const from = was.split('.').slice(0, 2).join('.');
          if (/^\d+\.\d+$/.test(from)) await this.enqueue('update', { from });
        }
        await settings.set(K.version, this.deps.version);
        await this.enqueue('startup', {});
        await this.tick();
      }
    } catch (err) {
      log.warn({ err }, 'statistics could not start');
    }
    if (this.deps.timers !== false) {
      this.timers.push(setInterval(() => void this.writePending(), 30_000));
      this.timers.push(setInterval(() => void this.tick(), 3_600_000));
      for (const t of this.timers) (t as { unref?: () => void }).unref?.();
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    void this.writePending();
  }

  /* ---- Consent ---------------------------------------------------------------- */

  async status(): Promise<T.TelemetryStatus> {
    const { settings, store } = this.deps;
    return {
      consent: (await settings.get<T.TelemetryConsent>(K.consent)) ?? 'unset',
      endpoint: !!this.deps.endpoint,
      queued: await store.queued().catch(() => 0),
      last_sent_at: (await settings.get<string>(K.lastSent)) ?? null,
    };
  }

  async setConsent(share: boolean): Promise<T.TelemetryStatus> {
    const { settings } = this.deps;
    if (share) {
      if (!(await settings.get<string>(K.id))) {
        await settings.set(K.id, randomUUID());
        await settings.set(K.seq, 0);
      }
      await settings.set(K.consent, 'granted');
      const fresh = !this.granted;
      this.granted = true;
      if (fresh && !(await settings.get<string>(K.version))) {
        await settings.set(K.version, this.deps.version);
        await this.enqueue('install', {});
      }
      await this.tick();
    } else {
      await settings.set(K.consent, 'declined');
      await this.purge();
    }
    return this.status();
  }

  /** Saying no: the id, the queue and every counter go. Only the install date is kept, and never sent. */
  private async purge() {
    this.granted = false;
    this.pending.clear();
    this.firstUse.clear();
    this.funnelDone.clear();
    this.clientEnv = {};
    this.stamp = null;
    const { settings, store } = this.deps;
    await store.purge();
    for (const k of [K.id, K.seq, K.version, K.firstUse, K.funnel, K.lastActive, K.lastSent, K.clientEnv])
      await settings.set(k, null);
  }

  /* ---- Recording (hot paths: memory only) -------------------------------------- */

  private bump(key: string, n = 1) {
    if (!this.granted) return;
    const day = this.today();
    if (this.pendingDay && this.pendingDay !== day) void this.writePending();
    this.pendingDay = day;
    this.pending.set(key, (this.pending.get(key) ?? 0) + n);
  }

  count(name: string, n = 1) {
    if (COUNTERS.has(name)) this.bump(`c:${name}`, n);
  }

  timing(metric: (typeof T.PERF_METRICS)[number], ms: number) {
    if (Number.isFinite(ms) && ms >= 0) this.bump(`h:${metric}:${B.msIndex(ms)}`);
  }

  error(code: string, status: '4xx' | '5xx' | 'stream') {
    if (CODE.test(code)) this.bump(`e:${code}:${status}`);
  }

  exception(where: 'core' | 'cockpit' | 'worker' | 'flow' | 'knowledge' | 'controller', kind: string) {
    if (KIND.test(kind)) this.bump(`x:${where}:${kind}`);
  }

  feature(feature: T.Feature, via: Via = 'api') {
    if (!this.granted || !(T.FEATURES as readonly string[]).includes(feature)) return;
    this.count(`f_${feature}`);
    if (this.firstUse.has(feature)) return;
    this.firstUse.add(feature);
    void this.deps.settings.set(K.firstUse, [...this.firstUse]).catch(() => undefined);
    void this.enqueue('first_use', { feature, via });
  }

  funnel(step: (typeof T.FUNNEL_STEPS)[number]) {
    if (!this.granted || this.funnelDone.has(step)) return;
    this.funnelDone.add(step);
    void this.deps.settings.set(K.funnel, [...this.funnelDone]).catch(() => undefined);
    void this.enqueue('funnel', { step });
  }

  /** A flow was published or turned on: its shape, never its words. */
  flowShape(data: Data) {
    if (this.granted) void this.enqueue('flow_shape', data);
  }

  /** Counters, first uses and timings from the Cockpit. */
  async ui(req: T.TelemetryUiRequest): Promise<void> {
    if (!this.granted) return;
    for (const [k, n] of Object.entries(req.counters ?? {})) if (n > 0) this.count(k, n);
    for (const f of req.first_use ?? []) this.feature(f.feature, f.via);
    for (const s of req.funnel ?? []) this.funnel(s);
    for (const t of req.timings ?? []) this.timing(t.metric, t.ms);
    for (const kind of req.exceptions ?? []) this.exception('cockpit', kind);
    if (req.env && Object.keys(req.env).length) {
      this.clientEnv = { ...this.clientEnv, ...(req.env as Data) };
      await this.deps.settings.set(K.clientEnv, this.clientEnv).catch(() => undefined);
    }
  }

  private async writePending() {
    if (!this.pending.size || !this.pendingDay) return;
    const deltas = Object.fromEntries(this.pending);
    const day = this.pendingDay;
    this.pending.clear();
    await this.deps.store.add(day, deltas).catch((err: unknown) => log.warn({ err }, 'counters not saved'));
  }

  /* ---- Envelopes ----------------------------------------------------------------- */

  private async enqueue(event: T.TelemetryEventName, data: Data): Promise<void> {
    if (!this.granted) return;
    const check = T.EVENT_DATA[event].safeParse(data);
    if (!check.success) {
      log.warn({ event, issue: check.error.issues[0]?.path.join('.') }, 'statistic refused by the contract');
      return;
    }
    const { settings } = this.deps;
    const id = await settings.get<string>(K.id);
    if (!id) return;
    const seq = ((await settings.get<number>(K.seq)) ?? 0) + 1;
    await settings.set(K.seq, seq);
    await this.deps.store.enqueue([
      {
        id,
        v: this.deps.version,
        channel: this.deps.channel,
        seq,
        event,
        at: this.now(),
        data: check.data as Data,
      },
    ]);
  }

  /** What `active` would say now. */
  async activeData(): Promise<Data> {
    const installed = await this.deps.settings.get<string>(K.installedAt);
    const weeks = installed ? Math.floor((this.now() - Date.parse(installed)) / (7 * 86_400_000)) : 0;
    const usage = this.usage ? await this.usage().catch(() => ({}) as Data) : {};
    return {
      ...(this.deps.env?.() ?? {}),
      ...this.clientEnv,
      ...usage,
      tier: this.deps.tier(),
      since_install: B.weeks(weeks),
    };
  }

  /** Roll finished days up, report today's activity once, then send. */
  async tick(): Promise<void> {
    if (!this.granted) return;
    try {
      await this.writePending();
      const today = this.today();
      const { settings, store } = this.deps;
      for (const day of await store.daysBefore(today)) {
        await this.rollUp(day, today);
        await store.dropDay(day);
      }
      if ((await settings.get<string>(K.lastActive)) !== today) {
        await this.enqueue('active', await this.activeData());
        await settings.set(K.lastActive, today);
      }
      await this.flush();
    } catch (err) {
      log.warn({ err }, 'statistics tick failed');
    }
  }

  private async rollUp(day: string, today: string) {
    const rows = await this.deps.store.day(day);
    const lag = B.lag(Math.round((Date.parse(today) - Date.parse(day)) / 86_400_000));
    const counts: Data = { lag };
    const hist = new Map<string, number[]>();
    const errors: { category: string; status: string }[] = [];
    const exceptions: { where: string; kind: string }[] = [];
    for (const [key, n] of Object.entries(rows)) {
      const [kind, a = '', b = ''] = key.split(':');
      if (kind === 'c' && n > 0) counts[a] = WIDE.has(a) ? B.wide(n) : B.count(n);
      else if (kind === 'h') {
        const h = hist.get(a) ?? new Array(T.MS_BUCKETS.length).fill(0);
        h[Number(b)] = (h[Number(b)] ?? 0) + n;
        hist.set(a, h);
      } else if (kind === 'e') errors.push({ category: a, status: b });
      else if (kind === 'x') exceptions.push({ where: a, kind: b });
    }
    if (Object.keys(counts).length > 1) await this.enqueue('daily_counts', counts);
    if (hist.size) {
      const perf: Data = { lag };
      for (const [metric, h] of hist) {
        const p50 = B.quantile(h, 0.5);
        const p95 = B.quantile(h, 0.95);
        if (p50) perf[`${metric}_p50`] = p50;
        if (p95) perf[`${metric}_p95`] = p95;
        perf[`${metric}_n`] = B.count(h.reduce((x, y) => x + y, 0));
      }
      await this.enqueue('perf', perf);
    }
    for (const e of errors.slice(0, 20)) await this.enqueue('error', e);
    for (const x of exceptions.slice(0, 10)) await this.enqueue('exception', x);
  }

  /** The next batch, as it would be sent (Settings → What is shared). */
  async preview(): Promise<{ batch: T.TelemetryBatch | null; today: Data; active: Data }> {
    const batch = await this.nextBatch();
    const today: Data = {};
    await this.writePending();
    const rows = this.granted ? await this.deps.store.day(this.today()) : {};
    for (const [key, n] of Object.entries(rows)) {
      const [kind, a = ''] = key.split(':');
      if (kind === 'c' && n > 0) today[a] = WIDE.has(a) ? B.wide(n) : B.count(n);
    }
    return { batch: batch?.body ?? null, today, active: await this.activeData() };
  }

  private async nextBatch(): Promise<{ ids: number[]; body: T.TelemetryBatch; bytes: string } | null> {
    const items = await this.deps.store.peek(BATCH_MAX);
    if (!items.length) return null;
    const ids: number[] = [];
    const batch: T.TelemetryEnvelope[] = [];
    for (const it of items) {
      const next = [...batch, it.envelope];
      const bytes = JSON.stringify({ schema: T.TELEMETRY_SCHEMA, product: 'ancile', batch: next });
      if (Buffer.byteLength(bytes) >= BATCH_BYTES && batch.length) break;
      batch.push(it.envelope);
      ids.push(it.id);
    }
    const body: T.TelemetryBatch = { schema: T.TELEMETRY_SCHEMA, product: 'ancile', batch };
    return { ids, body, bytes: JSON.stringify(body) };
  }

  private stampFor(subject: string): string {
    const day = stampDay(this.now());
    if (this.stamp?.day !== day) this.stamp = { day, value: makeStamp('ancile', subject, this.now()) };
    return this.stamp.value;
  }

  /** Send what is queued. Without consent or an endpoint, nothing ever leaves. */
  async flush(): Promise<void> {
    if (!this.granted || !this.deps.endpoint) return;
    const { store, settings } = this.deps;
    try {
      for (let round = 0; round < 5; round++) {
        const next = await this.nextBatch();
        if (!next) return;
        const id = await settings.get<string>(K.id);
        if (!id) return;
        let status = 0;
        try {
          const res = await (this.deps.fetch ?? fetch)(this.deps.endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-nvx-stamp': this.stampFor(id) },
            body: next.bytes,
            signal: AbortSignal.timeout(15_000),
          });
          status = res.status;
        } catch {
          status = 0;
        }
        if ((status >= 200 && status < 300) || PERMANENT.has(status)) {
          await store.remove(next.ids);
          if (status < 300) await settings.set(K.lastSent, new Date(this.now()).toISOString());
          continue;
        }
        const items = await store.peek(BATCH_MAX);
        const spent = items
          .filter((x) => next.ids.includes(x.id) && x.tries + 1 >= MAX_TRIES)
          .map((x) => x.id);
        await store.bump(next.ids);
        await store.remove(spent);
        return;
      }
    } catch (err) {
      log.warn({ err }, 'statistics not sent');
    }
  }
}
