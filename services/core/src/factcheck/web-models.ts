/**
 * ------------------------------------------------------------------
 *  Title    |  Fact-check web search through a model
 *  Ref      |  DESIGN.md §10, roadmap FC4 · docs/factcheck.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Let fact-check look claims up on the web without a
 *           |  SearXNG of your own, using a key you already have, and
 *           |  never run up a bill doing it.
 *  How      |  webSearchChain is the WebSearch the app uses. SearXNG
 *           |  first when SEARXNG_URL is set. Otherwise one small call
 *           |  to the cheapest ready model that can search, cheapest
 *           |  route first: Gemini Flash-Lite with Google Search
 *           |  grounding, then a small OpenRouter model with the web
 *           |  plugin (Exa), then Claude Haiku with Anthropic's web
 *           |  search tool. Each returns titles, links and snippets as
 *           |  WebHit[], exactly like SearXNG, and a route that fails
 *           |  hands over to the next. What each lookup costs is added
 *           |  to the check's tally and to a daily ledger; at the cap
 *           |  (factcheck.yaml web_daily_cap_usd, default 0.25) the
 *           |  lookups stop and the check says so.
 *  Note     |  Prices and request shapes were read from each provider's
 *           |  docs on 2026-10-20 (docs/factcheck.md lists the URLs).
 *           |  Replies are data from a stranger: only http(s) links,
 *           |  trimmed text, nothing is ever opened or run. Calls pass
 *           |  the e2e guard, so a test profile never reaches a real API.
 * ------------------------------------------------------------------
 */

import { AncileError, type FactcheckWebStatus, type ModelConfig, type WebVia } from '@nvx/contracts';
import { ClassifiedError, classifyStatus, retry } from '@nvx/resilience';
import { assertSendAllowed } from '../gateway/e2e-guard';
import { ANTHROPIC_WORKSPACE_SECRET, DEFAULT_SECRET, profileFor } from '../gateway/profiles';
import { type CallUsage, priceOf } from '../gateway/usage';
import { logFor } from '../obs/logger';
import { startSpan } from '../obs/spans';
import type { SettingsStore } from '../settings';
import type { CallLedger } from '../usage/ledger';
import { hostName, type WebHit, type WebSearch, type WebStatus, type WebTally } from './web';

const log = logFor('factcheck');

/** core.settings key for the daily ledger of what model lookups cost. */
export const WEB_SPEND_SETTING = 'factcheck.web_spend';
export const DEFAULT_WEB_CAP_USD = 0.25;

/** Docs checked 2026-10-20. Per search, on top of tokens. */
const ANTHROPIC_PER_SEARCH = 0.01; // $10 per 1,000 searches
const OPENROUTER_EXA_PER_SEARCH = 0.007; // Exa, up to 10 results
const GEMINI_3_PER_SEARCH = 0.014; // $14 per 1,000 after 5,000 free a month
const GEMINI_2_PER_SEARCH = 0.035; // $35 per 1,000 grounded prompts after 1,500 free a day
const GEMINI_3_FREE_MONTH = 5_000;
const GEMINI_2_FREE_DAY = 1_500;
/** A small call's tokens, for deciding before the call whether the budget allows it. */
const TOKEN_ESTIMATE = 0.002;

interface Ledger {
  day: string;
  usd: number;
  month: string;
  /** Gemini searches this month (Gemini 3 and newer) and today (Gemini 2.x), against the free allowance. */
  g3: number;
  g2: number;
}

const dayOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fresh = (now: Date, old?: Ledger): Ledger => {
  const day = dayOf(now);
  const month = day.slice(0, 7);
  return {
    day,
    usd: old && old.day === day ? old.usd : 0,
    month,
    g3: old && old.month === month ? old.g3 : 0,
    g2: old && old.day === day ? old.g2 : 0,
  };
};

export interface RouteResult {
  hits: WebHit[];
  costUsd: number;
  /** Counts toward a Gemini free allowance. */
  gemini?: '2' | '3';
}

interface Route {
  id: 'google' | 'openrouter' | 'anthropic';
  label: string;
  /** The name in a tooltip: "Searched with Gemini". */
  short: string;
  /** The model that serves this route, when one is ready. */
  pick(models: ModelConfig[]): ModelConfig | undefined;
  /** What a search is expected to cost now, before it runs. */
  estimate(model: ModelConfig, ledger: Ledger): number;
  run(
    model: ModelConfig,
    key: string,
    query: string,
    ctx: { fetch: typeof fetch; signal: AbortSignal; workspace: string | undefined },
  ): Promise<RouteResult>;
}

/* ---- Reading what comes back ---------------------------------------------- */

const clean = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/**
 * Text the provider itself attached to pages (its citations), by link and by site, for pages the
 * model's list left bare. A site key is "site:example.org".
 */
export type Cited = Map<string, string>;

const siteKey = (urlOrSite: string) => `site:${hostName(urlOrSite).toLowerCase()}`;

/** Remember what a provider cited for a page, under its link and its site (the longest text wins). */
function remember(cited: Cited, url: string | undefined, text: unknown, site?: string): void {
  const t = clean(text, 400);
  if (!t) return;
  const keys = [
    ...(url && /^https?:\/\//i.test(url) ? [url, siteKey(url)] : []),
    ...(site ? [`site:${site.toLowerCase().replace(/^www\./, '')}`] : []),
  ];
  for (const k of keys) if ((cited.get(k)?.length ?? 0) < t.length) cited.set(k, t);
}

/** The model's list as it wrote it: a link and a title, with or without text. Public http(s) links only. */
function rawHits(text: string): WebHit[] {
  const a = text.indexOf('[');
  const b = text.lastIndexOf(']');
  if (a < 0 || b <= a) return [];
  let list: unknown;
  try {
    list = JSON.parse(text.slice(a, b + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: WebHit[] = [];
  for (const r of list as Record<string, unknown>[]) {
    const url = clean(r?.url, 500);
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({ title: clean(r?.title, 140), url, snippet: clean(r?.snippet ?? r?.quote ?? r?.text, 400) });
  }
  return out;
}

/**
 * Hits that carry text. A page with no snippet is filled from what the provider cited for it (by link,
 * then by site) and dropped when there is none: a title and a link say nothing about the claim, and
 * handed to a checker they only produce "the evidence has no information".
 */
export function withText(hits: WebHit[], cited: Cited = new Map(), max = 5): WebHit[] {
  const out: WebHit[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (!/^https?:\/\//i.test(h.url) || seen.has(h.url)) continue;
    const snippet = h.snippet || cited.get(h.url) || cited.get(siteKey(h.url)) || '';
    if (!snippet) continue;
    seen.add(h.url);
    out.push({ ...h, snippet });
    if (out.length >= max) break;
  }
  return out;
}

/** Hits from a model's JSON reply: an array of {title, url, snippet}. Only pages with text are kept. */
export function parseHitList(text: string, max = 5): WebHit[] {
  return withText(rawHits(text), new Map(), max);
}

const promptFor = (query: string) =>
  `Search the web for the claim below. List up to 5 of the most relevant pages. Reply with only a JSON array of objects {"title", "url", "snippet"}. The snippet is required: one to three sentences copied from that page, including the figure, date or name that settles the claim. Leave out any page you cannot quote. No other text.\n\nClaim to look up: ${query.slice(0, 400)}`;

/** One route's call may take this long; the chain moves on rather than waiting twice as long. */
const CALL_TIMEOUT_MS = 15_000;

async function post(
  fetcher: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  return retry(
    async () => {
      const res = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
      });
      if (!res.ok) {
        // The provider's own words say why (a key not allowed to ground, a model that cannot search).
        const said = clean(await res.text().catch(() => ''), 200);
        throw new ClassifiedError(
          classifyStatus(res.status, said),
          `${new URL(url).hostname} answered ${res.status}${said ? `: ${said}` : ''}`,
          { status: res.status },
        );
      }
      return res.json();
    },
    {
      maxAttempts: 2,
      baseMs: 300,
      signal,
      // A server error may clear in a moment; a call that hung will hang again, so the next route gets its turn.
      shouldRetry: (err, cls) => cls === 'transient' && (err as { name?: string })?.name !== 'TimeoutError',
    },
  );
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/* ---- The three routes ----------------------------------------------------- */

const cheapest = (ms: ModelConfig[]): ModelConfig | undefined =>
  [...ms].sort(
    (a, b) =>
      a.price.input_per_mtok + a.price.output_per_mtok - (b.price.input_per_mtok + b.price.output_per_mtok),
  )[0];

const gemini3 = (m: ModelConfig) => !/gemini-2/.test(m.provider_model);

/** Google's charge for one grounded search: nothing inside the free allowance, then per search. */
function geminiFee(m: ModelConfig, l: Ledger): number {
  const three = gemini3(m);
  const free = three ? l.g3 < GEMINI_3_FREE_MONTH : l.g2 < GEMINI_2_FREE_DAY;
  return free ? 0 : three ? GEMINI_3_PER_SEARCH : GEMINI_2_PER_SEARCH;
}

const google: Route = {
  id: 'google',
  label: 'Gemini with Google Search',
  short: 'Gemini',
  pick: (ms) =>
    cheapest(
      ms.filter(
        (m) => m.provider === 'google' && m.via !== 'controller' && /flash-lite/i.test(m.provider_model),
      ),
    ),
  estimate: (m, l) => TOKEN_ESTIMATE + geminiFee(m, l),
  async run(m, key, query, { fetch: f, signal }) {
    const json = (await post(
      f,
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m.provider_model)}:generateContent`,
      { 'x-goog-api-key': key },
      {
        contents: [{ role: 'user', parts: [{ text: promptFor(query) }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 1_500, temperature: 0 },
      },
      signal,
    )) as {
      candidates?: {
        content?: { parts?: { text?: string }[] };
        groundingMetadata?: {
          groundingChunks?: { web?: { uri?: string; title?: string } }[];
          groundingSupports?: { segment?: { text?: string }; groundingChunkIndices?: number[] }[];
        };
      }[];
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
      };
    };
    const c = json.candidates?.[0];
    const text = (c?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    // The sentences Google says each source supports (groundingSupports), by the source's site: Google's
    // chunk links are redirects and its titles are site names, so the site is what matches the model's list.
    const chunks = c?.groundingMetadata?.groundingChunks ?? [];
    const cited: Cited = new Map();
    const found: WebHit[] = [];
    for (const s of c?.groundingMetadata?.groundingSupports ?? [])
      for (const i of s.groundingChunkIndices ?? []) {
        const w = chunks[i]?.web;
        if (!w?.uri) continue;
        remember(cited, undefined, s.segment?.text, w.title);
        found.push({
          title: clean(w.title, 140),
          url: clean(w.uri, 500),
          snippet: clean(s.segment?.text, 400),
        });
      }
    // The model's own list first (it quotes the page); Google's attached sources when that gave no text.
    let hits = withText(rawHits(text), cited);
    if (!hits.length) hits = withText(found);
    const usage: CallUsage = {
      inputTokens: num(json.usageMetadata?.promptTokenCount),
      outputTokens:
        num(json.usageMetadata?.candidatesTokenCount) + num(json.usageMetadata?.thoughtsTokenCount),
    };
    return { hits, costUsd: priceOf(m, usage), gemini: gemini3(m) ? '3' : '2' };
  },
};

const openrouter: Route = {
  id: 'openrouter',
  label: 'OpenRouter web search',
  short: 'OpenRouter (Exa)',
  pick: (ms) => cheapest(ms.filter((m) => m.provider === 'openrouter' && m.via !== 'controller')),
  estimate: () => TOKEN_ESTIMATE + OPENROUTER_EXA_PER_SEARCH,
  async run(m, key, query, { fetch: f, signal }) {
    const json = (await post(
      f,
      'https://openrouter.ai/api/v1/chat/completions',
      { authorization: `Bearer ${key}` },
      {
        model: m.provider_model,
        messages: [{ role: 'user', content: promptFor(query) }],
        // Exa is the engine whose price is known (docs/factcheck.md); the model only reads and lists.
        plugins: [{ id: 'web', engine: 'exa', max_results: 5 }],
        max_tokens: 1_200,
        temperature: 0,
        usage: { include: true },
      },
      signal,
    )) as {
      choices?: {
        message?: {
          content?: string;
          annotations?: {
            type?: string;
            url_citation?: { url?: string; title?: string; content?: string };
          }[];
        };
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const msg = json.choices?.[0]?.message;
    // What Exa returned for each page (the annotation's content) stands in for a snippet the model left out.
    const cited: Cited = new Map();
    const found: WebHit[] = [];
    for (const a of msg?.annotations ?? []) {
      const u = a.type === 'url_citation' ? a.url_citation : undefined;
      if (!u?.url) continue;
      remember(cited, u.url, u.content);
      found.push({ title: clean(u.title, 140), url: clean(u.url, 500), snippet: clean(u.content, 400) });
    }
    let hits = withText(rawHits(msg?.content ?? ''), cited);
    if (!hits.length) hits = withText(found);
    const billed = json.usage?.cost;
    const costUsd =
      typeof billed === 'number' && billed > 0
        ? billed
        : OPENROUTER_EXA_PER_SEARCH +
          priceOf(m, {
            inputTokens: num(json.usage?.prompt_tokens),
            outputTokens: num(json.usage?.completion_tokens),
          });
    return { hits, costUsd };
  },
};

const anthropic: Route = {
  id: 'anthropic',
  label: 'Claude Haiku with web search',
  short: 'Claude Haiku',
  pick: (ms) =>
    cheapest(
      ms.filter(
        (m) => m.provider === 'anthropic' && m.via !== 'controller' && /haiku/i.test(m.provider_model),
      ),
    ),
  estimate: () => TOKEN_ESTIMATE + ANTHROPIC_PER_SEARCH,
  async run(m, key, query, { fetch: f, signal, workspace }) {
    const json = (await post(
      f,
      'https://api.anthropic.com/v1/messages',
      {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        ...profileFor('anthropic').headers({ workspaceId: workspace }),
      },
      {
        model: m.provider_model,
        max_tokens: 1_500,
        messages: [{ role: 'user', content: promptFor(query) }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
      },
      signal,
    )) as {
      content?: {
        type?: string;
        text?: string;
        citations?: { url?: string; title?: string; cited_text?: string }[];
        content?: unknown;
      }[];
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        server_tool_use?: { web_search_requests?: number };
      };
    };
    const blocks = json.content ?? [];
    // The passages Claude cited (cited_text) are the page's own words; they fill in for a page the list left bare.
    const cited: Cited = new Map();
    for (const b of blocks) for (const c of b.citations ?? []) remember(cited, c.url, c.cited_text);
    const found: WebHit[] = [];
    for (const b of blocks)
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content))
        for (const r of b.content as { url?: string; title?: string }[])
          if (r?.url)
            found.push({
              title: clean(r.title, 140),
              url: clean(r.url, 500),
              snippet: cited.get(r.url) ?? '',
            });
    let hits = withText(
      rawHits(blocks.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('')),
      cited,
    );
    if (!hits.length) hits = withText(found, cited);
    const searches = num(json.usage?.server_tool_use?.web_search_requests);
    const costUsd =
      searches * ANTHROPIC_PER_SEARCH +
      priceOf(m, {
        inputTokens: num(json.usage?.input_tokens) + num(json.usage?.cache_read_input_tokens),
        outputTokens: num(json.usage?.output_tokens),
        cachedTokens: num(json.usage?.cache_read_input_tokens),
      });
    return { hits, costUsd };
  },
};

/** Cheapest first: Google has a free allowance, Exa through OpenRouter is $0.007, Anthropic's is $0.01. */
export const ROUTES: readonly Route[] = [google, openrouter, anthropic];

/* ---- The chain ------------------------------------------------------------ */

export interface WebChainDeps {
  /** The chat models that are ready now (keys in place). */
  models: () => ModelConfig[];
  secret: (name: string) => Promise<string | undefined>;
  settings: SettingsStore;
  /** The daily cap in USD; 0 turns model lookups off. */
  capUsd: () => number;
  /** Each search is counted in Usage as 'web' (usage/ledger.ts). */
  ledger?: CallLedger | undefined;
  /** SearXNG, when SEARXNG_URL is set: used alone, free, never capped. */
  searxng?: WebSearch | null | undefined;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface WebChain extends WebSearch {
  /** Today's spend on model lookups, for Settings and tests. */
  spentToday(): Promise<number>;
  /** The chain in the order it is tried, each route ready or not and why (GET /factcheck/web). */
  describe(): Promise<FactcheckWebStatus>;
}

const budgetError = () =>
  new AncileError({
    code: 'factcheck.web_budget',
    title: 'The daily web budget is reached',
    hint: 'The check went on without the web. Raise web_daily_cap_usd in config/factcheck.yaml, or try again tomorrow.',
    status: 429,
    errorClass: 'capacity',
  });

const unavailableError = (cause?: unknown) =>
  new AncileError({
    code: 'factcheck.web_unavailable',
    title: 'The web search did not answer',
    hint: 'The check went on with your sources only. Check the key you use for web search in Settings → Models, or SearXNG (SEARXNG_URL).',
    status: 503,
    errorClass: 'transient',
    cause,
  });

/** A route that failed is left alone this long: a key that is refused stays refused, a hang is not tried again at once. */
const REST_PERMANENT_MS = 30 * 60_000;
const REST_TRANSIENT_MS = 5 * 60_000;

/** Why a route failed, in a line (the provider's own words when it gave them). */
const reasonOf = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 240) || 'it failed';

export function webSearchChain(deps: WebChainDeps): WebChain {
  const now = () => (deps.now ?? (() => new Date()))();
  let reserved = 0;
  let lock: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => undefined);
    return run;
  };
  const read = async () => fresh(now(), await deps.settings.get<Ledger>(WEB_SPEND_SETTING));
  /** Routes that failed lately, and why: skipped until `until`. */
  const rested = new Map<Route['id'], { until: number; reason: string }>();
  const restOf = (id: Route['id']) => {
    const r = rested.get(id);
    if (!r) return undefined;
    if (r.until <= now().getTime()) {
      rested.delete(id);
      return undefined;
    }
    return r;
  };
  const ready = () => {
    const ms = deps.models();
    return ROUTES.flatMap((route) => {
      const model = route.pick(ms);
      return model ? [{ route, model }] : [];
    });
  };

  return {
    async status(): Promise<WebStatus> {
      if (deps.searxng) return { ready: true, via: 'searxng' };
      const routes = ready();
      if (!routes.length) return { ready: false, reason: 'none' };
      const cap = deps.capUsd();
      if (cap <= 0 || (await read()).usd >= cap) return { ready: false, reason: 'budget' };
      return { ready: true, via: (routes[0] as (typeof routes)[number]).route.id };
    },

    async describe(): Promise<FactcheckWebStatus> {
      const cap = deps.capUsd();
      const ledger = await read();
      const ms = deps.models();
      const routes: FactcheckWebStatus['routes'] = [];
      if (deps.searxng)
        routes.push({
          id: 'searxng',
          label: 'SearXNG',
          state: 'ready',
          model_id: null,
          reason: null,
          rested_until: null,
          free_left: null,
        });
      for (const route of ROUTES) {
        const model = route.pick(ms);
        const key = model
          ? await deps.secret(model.secret ?? DEFAULT_SECRET[model.provider] ?? '')
          : undefined;
        const rest = restOf(route.id);
        const free =
          route.id === 'google' && model
            ? gemini3(model)
              ? Math.max(0, GEMINI_3_FREE_MONTH - ledger.g3)
              : Math.max(0, GEMINI_2_FREE_DAY - ledger.g2)
            : null;
        routes.push({
          id: route.id,
          label: route.label,
          state: !model ? 'no_model' : !key ? 'no_key' : rest ? 'rested' : 'ready',
          model_id: model?.id ?? null,
          reason: !model
            ? route.id === 'google'
              ? 'No Google Flash-Lite model is ready.'
              : route.id === 'anthropic'
                ? 'No Claude Haiku model is ready.'
                : 'No OpenRouter model is ready.'
            : !key
              ? 'The key for this model is not set.'
              : (rest?.reason ?? null),
          rested_until: rest ? new Date(rest.until).toISOString() : null,
          free_left: free,
        });
      }
      const first = routes.find((r) => r.state === 'ready');
      const overCap = !deps.searxng && (cap <= 0 || ledger.usd >= cap);
      return {
        ready: !!first && !overCap,
        via: first?.id ?? null,
        reason: overCap ? 'budget' : first ? null : 'none',
        spent_today_usd: ledger.usd,
        cap_usd: cap,
        routes,
      };
    },

    async search(query, signal, tally?: WebTally) {
      if (deps.searxng) return deps.searxng.search(query, signal, tally);
      const routes = ready();
      if (!routes.length) throw unavailableError();
      let overBudget = false;
      let last: unknown;
      let answered = false;
      for (const { route, model } of routes) {
        const rest = restOf(route.id);
        if (rest) {
          last ??= new Error(`${route.short} is resting after: ${rest.reason}`);
          continue;
        }
        const key = await deps.secret(model.secret ?? DEFAULT_SECRET[model.provider] ?? '');
        if (!key) continue;
        // Reserve what this search is expected to cost, so searches running side by side cannot overshoot the cap.
        const est = await locked(async () => {
          const ledger = await read();
          const e = route.estimate(model, ledger);
          if (ledger.usd + reserved + e > deps.capUsd()) return null;
          reserved += e;
          return e;
        });
        if (est === null) {
          overBudget = true;
          continue;
        }
        const span = startSpan(`web search ${route.id}`, 'client', { route: route.id, model: model.id });
        try {
          assertSendAllowed(model);
          const workspace =
            route.id === 'anthropic' ? await deps.secret(ANTHROPIC_WORKSPACE_SECRET) : undefined;
          const r = await route.run(model, key, query, { fetch: deps.fetch ?? fetch, signal, workspace });
          let free = false;
          await locked(async () => {
            reserved -= est;
            const ledger = await read();
            // Google's grounding fee is not in the reply: it follows from how many free searches are left.
            if (r.gemini) {
              const fee = geminiFee(model, ledger);
              free = fee === 0;
              r.costUsd += fee;
            }
            ledger.usd += r.costUsd;
            if (r.gemini === '3') ledger.g3 += 1;
            if (r.gemini === '2') ledger.g2 += 1;
            await deps.settings.set(WEB_SPEND_SETTING, ledger);
          });
          if (tally) tally.costUsd += r.costUsd;
          void deps.ledger
            ?.record({
              purpose: 'web',
              engine: 'gateway',
              modelId: model.id,
              provider: model.provider,
              inputTokens: 0,
              outputTokens: 0,
              cachedTokens: 0,
              costUsd: r.costUsd,
              at: new Date(),
            })
            .catch(() => undefined);
          span.end('ok', { hits: r.hits.length, cost_usd: r.costUsd, free_allowance: free });
          answered = true;
          if (!r.hits.length) {
            // It answered but quoted nothing from any page: no evidence. The next route may do better.
            last = new Error(`${route.short} found pages but quoted none of them`);
            log.info({ route: route.id, model: model.id }, 'web search gave no text to check against');
            continue;
          }
          const via: WebVia = {
            route: route.id,
            label: route.short,
            model_id: model.id,
            cost_usd: r.costUsd,
            free,
          };
          return r.hits.map((h) => ({ ...h, via }));
        } catch (err) {
          reserved -= est;
          if (signal.aborted) {
            span.end('error', { error: 'stopped' });
            throw err;
          }
          last = err;
          const reason = reasonOf(err);
          const permanent = (err as { errorClass?: string })?.errorClass === 'permanent';
          rested.set(route.id, {
            until: now().getTime() + (permanent ? REST_PERMANENT_MS : REST_TRANSIENT_MS),
            reason,
          });
          span.end('error', { error: reason, rested: true });
          log.warn(
            { route: route.id, model: model.id, reason, rested_minutes: permanent ? 30 : 5 },
            'web search route failed and is rested',
          );
        }
      }
      // Answered, but nothing quotable anywhere: an empty result, not a failure.
      if (answered) return [];
      throw overBudget && !last ? budgetError() : unavailableError(last);
    },

    async spentToday() {
      return (await read()).usd;
    },
  };
}
