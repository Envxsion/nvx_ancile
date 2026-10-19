/**
 * ------------------------------------------------------------------
 *  Title    |  Fact-check on the web
 *  Ref      |  DESIGN.md §10, roadmap FC4 · docs/factcheck.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Let a fact-check look a claim up on the web when the
 *           |  notebook's sources do not cover it, and say plainly when
 *           |  it may not: a private or keep-local notebook never uses
 *           |  the web.
 *  How      |  webPolicy decides from the notebook's "Check on the web"
 *           |  setting, the one-click allow on this check and the
 *           |  scope (private, nothing leaves this machine, network off,
 *           |  web.search not allowed). searxngSearch asks SearXNG
 *           |  (SEARXNG_URL) over HTTP through @nvx/resilience and keeps
 *           |  only titles, links and snippets: pages are never opened,
 *           |  so a dead link costs nothing. Each search goes through
 *           |  the permission gate on its real query before it leaves.
 *  Note     |  Results are data from a stranger. They reach a model
 *           |  only inside the untrusted wrapper (steps.ts), and can
 *           |  only add evidence, never instructions.
 * ------------------------------------------------------------------
 */

import { AncileError, type EffectiveScope } from '@nvx/contracts';
import { retry } from '@nvx/resilience';
import type { Gate } from '../permissions/gate';
import { checkToolCall, keepsLocal } from '../scopes';

export interface WebHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearch {
  search(query: string, signal: AbortSignal): Promise<WebHit[]>;
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
}

/**
 * May this check use the web? Wanted when the notebook allows it or this
 * check asked for it. Forbidden (and said so) when the notebook is private,
 * keeps data on this machine, has the network off or does not allow web.search;
 * those are the scope's own rules, followed exactly (docs/scopes.md).
 */
export function webPolicy(a: {
  scope: EffectiveScope | null;
  notebookWeb: boolean;
  requested: boolean | undefined;
  configured: boolean;
}): WebDecision {
  const wanted = a.notebookWeb || a.requested === true;
  if (!wanted) return { use: false, note: null };
  if (a.scope) {
    if (keepsLocal(a.scope))
      return {
        use: false,
        note: 'This notebook keeps everything on this machine, so nothing was looked up on the web.',
      };
    const check = checkToolCall(a.scope, { action: 'web.search', resource: 'web:search/claim' });
    if (!check.ok) return { use: false, note: `Not looked up on the web: ${check.reason}.` };
  }
  if (!a.configured)
    return {
      use: false,
      note: 'Web search is not set up. Add a SearXNG address (SEARXNG_URL) to check claims on the web.',
    };
  return { use: true, note: null };
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
}): ((query: string, signal: AbortSignal) => Promise<WebHit[] | null>) | undefined {
  const { web, gate, userId, ctx } = a;
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
      tool: 'factcheck.web',
      args: { query },
    });
    return d.outcome === 'allow' ? web.search(query, signal) : null;
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
    if (!snippet && !clean(r?.title, 10)) continue;
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
            return parseSearx(await res.json(), opts.max ?? 5);
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
