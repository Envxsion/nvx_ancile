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

import { AncileError, type ModelConfig } from '@nvx/contracts';
import { retry } from '@nvx/resilience';
import { assertSendAllowed } from '../gateway/e2e-guard';
import { ANTHROPIC_WORKSPACE_SECRET, DEFAULT_SECRET, profileFor } from '../gateway/profiles';
import { type CallUsage, priceOf } from '../gateway/usage';
import type { SettingsStore } from '../settings';
import type { CallLedger } from '../usage/ledger';
import type { WebHit, WebSearch, WebStatus, WebTally } from './web';

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

/** Hits from a model's JSON reply: an array of {title, url, snippet}, public http(s) links only. */
export function parseHitList(text: string, max = 5): WebHit[] {
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
    const snippet = clean(r?.snippet, 400);
    const title = clean(r?.title, 140);
    if (!snippet && !title) continue;
    out.push({ title, url, snippet });
    if (out.length >= max) break;
  }
  return out;
}

/** Links the provider itself attached, used when the model's own list is missing or unusable. */
function dedupe(hits: WebHit[], max = 5): WebHit[] {
  const seen = new Set<string>();
  const out: WebHit[] = [];
  for (const h of hits) {
    if (!/^https?:\/\//i.test(h.url) || seen.has(h.url)) continue;
    seen.add(h.url);
    out.push(h);
    if (out.length >= max) break;
  }
  return out;
}

const promptFor = (query: string) =>
  `Search the web for the claim below. List up to 5 of the most relevant pages. Reply with only a JSON array of objects {"title", "url", "snippet"}. The snippet is one or two sentences from the page that bear on the claim. No other text.\n\nClaim to look up: ${query.slice(0, 400)}`;

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
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      });
      if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
      return res.json();
    },
    { maxAttempts: 2, baseMs: 300, signal },
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
    let hits = parseHitList(text);
    if (!hits.length) {
      // The model's own list was unusable: fall back to the sources Google attached, with the sentence each supports.
      const chunks = c?.groundingMetadata?.groundingChunks ?? [];
      const found: WebHit[] = [];
      for (const s of c?.groundingMetadata?.groundingSupports ?? [])
        for (const i of s.groundingChunkIndices ?? []) {
          const w = chunks[i]?.web;
          if (w?.uri)
            found.push({
              title: clean(w.title, 140),
              url: clean(w.uri, 500),
              snippet: clean(s.segment?.text, 400),
            });
        }
      hits = dedupe(found);
    }
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
    let hits = parseHitList(msg?.content ?? '');
    if (!hits.length)
      hits = dedupe(
        (msg?.annotations ?? []).flatMap((a) =>
          a.type === 'url_citation' && a.url_citation?.url
            ? [
                {
                  title: clean(a.url_citation.title, 140),
                  url: clean(a.url_citation.url, 500),
                  snippet: clean(a.url_citation.content, 400),
                },
              ]
            : [],
        ),
      );
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
    let hits = parseHitList(blocks.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join(''));
    if (!hits.length) {
      const said = new Map<string, string>();
      for (const b of blocks)
        for (const c of b.citations ?? []) if (c.url && c.cited_text) said.set(c.url, c.cited_text);
      const found: WebHit[] = [];
      for (const b of blocks)
        if (b.type === 'web_search_tool_result' && Array.isArray(b.content))
          for (const r of b.content as { url?: string; title?: string }[])
            if (r?.url)
              found.push({
                title: clean(r.title, 140),
                url: clean(r.url, 500),
                snippet: clean(said.get(r.url), 400),
              });
      hits = dedupe(found);
    }
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

    async search(query, signal, tally?: WebTally) {
      if (deps.searxng) return deps.searxng.search(query, signal, tally);
      const routes = ready();
      if (!routes.length) throw unavailableError();
      let overBudget = false;
      let last: unknown;
      for (const { route, model } of routes) {
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
        try {
          assertSendAllowed(model);
          const workspace =
            route.id === 'anthropic' ? await deps.secret(ANTHROPIC_WORKSPACE_SECRET) : undefined;
          const r = await route.run(model, key, query, { fetch: deps.fetch ?? fetch, signal, workspace });
          await locked(async () => {
            reserved -= est;
            const ledger = await read();
            // Google's grounding fee is not in the reply: it follows from how many free searches are left.
            if (r.gemini) r.costUsd += geminiFee(model, ledger);
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
          return r.hits;
        } catch (err) {
          reserved -= est;
          if (signal.aborted) throw err;
          last = err;
        }
      }
      throw overBudget && !last ? budgetError() : unavailableError(last);
    },

    async spentToday() {
      return (await read()).usd;
    },
  };
}
