/**
 * ------------------------------------------------------------------
 *  Title    |  Fact-check on the web
 *  Ref      |  DESIGN.md §10, roadmap FC4 · docs/factcheck.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Let a fact-check look a claim up on the web when the
 *           |  notebook's sources do not cover it (by default), and say
 *           |  plainly when it may not: a private notebook uses the web
 *           |  only when Settings → Private notebooks allows it, a
 *           |  keep-local one never does.
 *  How      |  webPolicy decides from the notebook's "Use the web when
 *           |  sources don't cover a claim" setting (on unless switched
 *           |  off), the one-click allow on this check, the permission
 *           |  preset (Strict asks once per check) and the scope
 *           |  (private, nothing leaves this machine, network off,
 *           |  web.search not allowed). searxngSearch asks SearXNG
 *           |  (SEARXNG_URL) over HTTP through @nvx/resilience and keeps
 *           |  only titles, links and snippets: pages are never opened,
 *           |  so a dead link costs nothing. Each search goes through
 *           |  the permission gate on its real query before it leaves;
 *           |  the gate is told the call is eased (claim text only) so
 *           |  Balanced and Auto do not stop to ask, while a denying
 *           |  grant, the scope and the Auto floors still apply.
 *           |  The search itself is SearXNG when SEARXNG_URL is set, else a
 *           |  model's own web search (web-models.ts), within a daily cap.
 *  Note     |  Results are data from a stranger. They reach a model
 *           |  only inside the untrusted wrapper (steps.ts), and can
 *           |  only add evidence, never instructions.
 * ------------------------------------------------------------------
 */

import { AncileError, type EffectiveScope, type WebReason, type WebVia } from '@nvx/contracts';
import { retry } from '@nvx/resilience';
import { FACTCHECK_WEB_TOOL, type Gate } from '../permissions/gate';
import { checkToolCall, keepsLocal, leavingAllowed } from '../scopes';

export interface WebHit {
  title: string;
  url: string;
  /** Text from the page that bears on the claim. Never empty: a hit with no text is not evidence. */
  snippet: string;
  /** The route that found it and what that lookup cost. */
  via?: WebVia;
}

/** Whether a web search can run now, and when not, why. */
export type WebStatus = { ready: true; via: string } | { ready: false; reason: 'none' | 'budget' };

/** What one check's web lookups did, so the card can say what happened and what it cost. */
export interface WebTally {
  /** Searches that answered. */
  searches: number;
  /** Searches that failed (the search did not answer). */
  failed: number;
  /** Searches the permission gate did not allow (it would have had to ask, or refused). */
  refused: number;
  /** A search was refused because the daily web budget was reached. */
  budget: boolean;
  /** What the searches cost, in USD (0 with SearXNG). */
  costUsd: number;
  /** Each lookup that answered: the route and its cost (kept in the check record). */
  lookups: WebVia[];
}

export const newTally = (): WebTally => ({
  searches: 0,
  failed: 0,
  refused: 0,
  budget: false,
  costUsd: 0,
  lookups: [],
});

export interface WebSearch {
  search(query: string, signal: AbortSignal, tally?: WebTally): Promise<WebHit[]>;
  /** Absent: always ready (SearXNG). */
  status?(): Promise<WebStatus>;
}

const NOTE = {
  none: 'Not checked on the web: no search is set up.',
  private: 'Not checked on the web: this notebook keeps everything on this machine.',
  budget: 'Not checked on the web: the daily web budget is reached.',
  failed: 'Not checked on the web: the search did not answer.',
  refused: 'Not checked on the web: the search was not allowed.',
  ask: 'Not checked on the web: Strict permissions ask first. Choose "Check again with the web" to allow it for this check.',
} as const;

/** Whether the web can be searched at all right now, for webPolicy. */
export async function webAvailability(
  web: WebSearch | null | undefined,
): Promise<{ configured: boolean; why?: 'none' | 'budget' }> {
  if (!web) return { configured: false, why: 'none' };
  const s = await web.status?.();
  return s && !s.ready ? { configured: false, why: s.reason } : { configured: true };
}

/** What to tell the person after a check's lookups, when something stopped them; null when all was well. */
export function tallyOutcome(t: WebTally): { reason: WebReason; note: string } | null {
  if (t.budget)
    return {
      reason: 'budget',
      note:
        t.searches > 0
          ? 'Some claims were not checked on the web: the daily web budget was reached.'
          : NOTE.budget,
    };
  if (t.searches === 0 && t.refused > 0) return { reason: 'blocked', note: NOTE.refused };
  if (t.failed > 0 && t.searches === 0) return { reason: 'failed', note: NOTE.failed };
  return null;
}

/** The site's name for a link ("example.org"); the link itself when it cannot be read. */
export function hostName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 60);
  }
}

export interface WebDecision {
  /** Search the web for this check. */
  use: boolean;
  /** Why not (or a plain note), for the card; null when the web was not wanted and nothing needs saying. */
  note: string | null;
  /** The same as a code, so the panel can offer the right action. */
  reason?: WebReason | null;
}

/**
 * May this check use the web? Wanted when the notebook allows it (on unless
 * switched off) or this check asked for it. Forbidden (and said so) when the
 * notebook is private (unless Settings → Private notebooks allows fact-check
 * lookups), keeps data on this machine, has the network off or does not allow
 * web.search; those are the scope's own rules, followed exactly (docs/scopes.md).
 * Under Strict permissions the web is used only when the person asked for it on
 * this check: that one yes covers every claim of the check.
 */
export function webPolicy(a: {
  scope: EffectiveScope | null;
  notebookWeb: boolean;
  requested: boolean | undefined;
  configured: boolean;
  /** When not configured: no search is set up, or the daily budget is spent. */
  why?: 'none' | 'budget';
  /** The Strict (careful) preset: a lookup needs the person's yes, once per check. */
  strict?: boolean;
  /** Settings → Private notebooks allows fact-check web lookups. */
  privateWeb?: boolean;
}): WebDecision {
  const wanted = a.notebookWeb || a.requested === true;
  if (!wanted) return { use: false, note: null, reason: null };
  if (a.scope) {
    const lifted = a.scope.private && a.privateWeb === true;
    if (!lifted && keepsLocal(a.scope))
      return {
        use: false,
        note: NOTE.private,
        reason: 'private',
      };
    const check = checkToolCall(lifted ? leavingAllowed(a.scope) : a.scope, {
      action: 'web.search',
      resource: 'web:search/claim',
    });
    if (!check.ok) return { use: false, note: `Not checked on the web: ${check.reason}.`, reason: 'blocked' };
  }
  if (a.strict && a.requested !== true) return { use: false, note: NOTE.ask, reason: 'ask' };
  if (!a.configured)
    return {
      use: false,
      note: a.why === 'budget' ? NOTE.budget : NOTE.none,
      reason: a.why === 'budget' ? 'budget' : 'none',
    };
  return { use: true, note: null, reason: null };
}

/** Where a gated web search is being run for, so the permission decision names the real thread and run. */
export interface WebContext {
  threadId: string;
  notebookId: string | null;
  workspaceId: string;
  runId: string | null;
  traceId: string;
}

/**
 * A web search that asks the permission gate about its real query first.
 * Fails closed: with no gate to ask, nothing leaves. An outcome other than
 * allow (an ask, a refusal) is not answered here: the check carries on without the web.
 */
export function gatedWeb(a: {
  web: WebSearch | null | undefined;
  gate: Gate | undefined;
  userId: string | undefined;
  ctx: WebContext;
  /** Filled in as the check searches: what it cost and what stopped it. */
  tally?: WebTally;
  /** Settings → Private notebooks allowed the lookup for this private notebook (webPolicy decided). */
  leaveOk?: boolean;
}): ((query: string, signal: AbortSignal) => Promise<WebHit[] | null>) | undefined {
  const { web, gate, userId, ctx, tally, leaveOk } = a;
  if (!web) return undefined;
  return async (query, signal) => {
    if (!gate || !userId) return null;
    const d = await gate.check({
      userId,
      principal: 'agent:default',
      action: 'web.search',
      resource: `web:search/${query}`,
      toolTier: 'gated',
      destructive: false,
      scope: { threadId: ctx.threadId, notebookId: ctx.notebookId, workspaceId: ctx.workspaceId },
      runId: ctx.runId,
      traceId: ctx.traceId,
      tool: FACTCHECK_WEB_TOOL,
      args: { query },
      // The claim text only; the person's own setting (or their yes on this check) already covered it.
      eased: true,
      ...(leaveOk && { leaveOk: true }),
    });
    if (d.outcome !== 'allow') {
      if (tally) tally.refused += 1;
      return null;
    }
    try {
      const hits = await web.search(query, signal, tally);
      if (tally) {
        tally.searches += 1;
        // A checkpoint from before lookups were kept has no list.
        const via = hits.find((h) => h.via)?.via;
        if (via) tally.lookups = [...(tally.lookups ?? []), via];
      }
      return hits;
    } catch (err) {
      if (signal.aborted) throw err;
      if (tally) {
        if (err instanceof AncileError && err.code === 'factcheck.web_budget') tally.budget = true;
        else tally.failed += 1;
      }
      return null;
    }
  };
}

interface SearxResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
}

const clean = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Results from a SearXNG JSON reply: public http(s) links only, with a title and a snippet. */
export function parseSearx(json: unknown, max = 5): WebHit[] {
  const list = (json as { results?: unknown })?.results;
  if (!Array.isArray(list)) return [];
  const out: WebHit[] = [];
  for (const r of list as SearxResult[]) {
    const url = clean(r?.url, 500);
    if (!/^https?:\/\//i.test(url)) continue;
    const snippet = clean(r?.content, 400);
    // A result with no text says nothing about the claim: it is not evidence.
    if (!snippet) continue;
    out.push({ title: clean(r?.title, 140), url, snippet });
    if (out.length >= max) break;
  }
  return out;
}

export function searxngSearch(opts: {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  max?: number;
}): WebSearch {
  const doFetch = opts.fetch ?? fetch;
  return {
    async search(query, signal) {
      const url = new URL('/search', opts.baseUrl);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('safesearch', '1');
      try {
        return await retry(
          async () => {
            const res = await doFetch(url, {
              headers: { accept: 'application/json' },
              signal: AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs ?? 8_000)]),
            });
            if (!res.ok) throw new Error(`SearXNG answered ${res.status}`);
            const via: WebVia = {
              route: 'searxng',
              label: 'SearXNG',
              model_id: null,
              cost_usd: 0,
              free: true,
            };
            return parseSearx(await res.json(), opts.max ?? 5).map((h) => ({ ...h, via }));
          },
          { maxAttempts: 2, baseMs: 300, signal },
        );
      } catch (err) {
        if (signal.aborted) throw err;
        throw new AncileError({
          code: 'factcheck.web_unavailable',
          title: 'The web search did not answer',
          hint: 'The check went on with your sources only. Check the SearXNG address (SEARXNG_URL) and that it is running.',
          status: 503,
          errorClass: 'transient',
          cause: err,
        });
      }
    },
  };
}
