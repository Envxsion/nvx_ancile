/**
 * Site rules and patterns of your own (docs/permissions.md#patterns).
 * Regression: a thread rule `web:*` saved from a WebSearch approval was
 * refused as "wider than this tool allows" (a search had no suggestion
 * ladder) and, had it been saved, covered web.search only. Now one rule
 * covers later searches and fetches in that thread, through the gate,
 * and the other requests waiting on it are settled by deciding again.
 */
import type { Hono } from 'hono';
import { Hono as HonoApp } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import { errorHandler } from '../../src/obs/errors';
import { AutoReview, MemoryPlanStore, type Reviewer } from '../../src/permissions/auto';
import { BuiltinPolicy, LayeredPolicy, presetRelax } from '../../src/permissions/cedar';
import { createGate, type Gate, type GateRequest } from '../../src/permissions/gate';
import { matchAction, matchResource } from '../../src/permissions/glob';
import { patternAllowed, patternNarrows, permissionRoutes } from '../../src/permissions/routes';
import { type ApprovalRecord, MemoryPermissionStore } from '../../src/permissions/store';
import { suggestPatterns } from '../../src/permissions/suggest';
import { MemoryRunEventLog } from '../../src/runs/events';

const WS = 'wsp_1';

describe('site rules', () => {
  it.each([
    // every search and every website
    ['web:*', 'web:search/tutoring centre', true],
    ['web:*', 'web:search/a/b and c', true],
    ['web:*', 'web:legacy query form', true],
    ['web:*', 'http:https://ai.g2.com/reviews?x=1', true],
    ['web:*', 'http:http://aiera.blog/', true],
    ['web:*', 'fs:/workspace/a.md', false],
    ['web:*', 'shell:curl x', false],
    // searches only, fetches only
    ['web:search', 'web:search/anything at all', true],
    ['web:search', 'http:https://example.com/', false],
    ['web:fetch', 'http:https://example.com/a', true],
    ['web:fetch', 'web:search/example.com', false],
    ['web:search/example.com', 'http:https://example.com/', false],
    // one site
    ['web:example.com', 'http:https://example.com/', true],
    ['web:example.com', 'http:https://example.com/a/b', true],
    ['web:example.com', 'http:https://www.example.com/', false],
    ['web:example.com', 'http:https://example.com.evil.io/', false],
    ['web:example.com', 'web:search/example.com', false],
    // a site and its subdomains
    ['web:*.example.com', 'http:https://example.com/', true],
    ['web:*.example.com', 'http:https://docs.example.com/x', true],
    ['web:*.example.com', 'http:https://a.b.example.com/x', true],
    ['web:*.example.com', 'http:https://evilexample.com/', false],
    // a path prefix
    ['web:example.com/docs/**', 'http:https://example.com/docs', true],
    ['web:example.com/docs/**', 'http:https://example.com/docs/a/b?q=1', true],
    ['web:example.com/docs/**', 'http:https://example.com/docsx', false],
    ['web:example.com/docs/**', 'http:https://example.com/blog', false],
    // one search
    ['web:search/tutoring centre', 'web:search/tutoring centre', true],
    ['web:search/tutoring centre', 'web:search/tutoring centres', false],
  ])('%s ~ %s → %s', (p, r, want) => {
    expect(matchResource(p, r)).toBe(want);
  });

  it('keeps the existing grammar for files, addresses, MCP and shell', () => {
    expect(matchResource('fs:/workspace/notes/**', 'fs:/workspace/notes/2026/a.md')).toBe(true);
    expect(matchResource('fs:/workspace/notes/**', 'fs:/workspace/other.md')).toBe(false);
    expect(matchResource('http:https://example.com/docs/**', 'http:https://example.com/docs/a')).toBe(true);
    expect(matchResource('mcp:github/*', 'mcp:github/create_issue')).toBe(true);
    expect(matchResource('mcp:github/*', 'mcp:gitlab/create_issue')).toBe(false);
    expect(matchAction('mcp.github.*', 'mcp.github.create_issue')).toBe(true);
  });

  it('never lets a shell wildcard reach past a command separator', () => {
    expect(matchResource('shell:git status*', 'shell:git status')).toBe(true);
    expect(matchResource('shell:git status*', 'shell:git status --short')).toBe(true);
    expect(matchResource('shell:git *', 'shell:git log -- src/a.ts')).toBe(true);
    for (const bad of [
      'shell:git status; rm -rf ~',
      'shell:git status && curl x',
      'shell:git status | sh',
      'shell:git status `id`',
      'shell:git status $(id)',
      'shell:git status > /etc/passwd',
      'shell:git status\nrm x',
    ])
      expect(matchResource('shell:git status*', bad)).toBe(false);
  });

  it('offers site rules for a search, and allows them only for web actions', () => {
    expect(suggestPatterns('web:search/tutoring centre', { workspaceRoot: '/w' })).toEqual([
      'web:search/tutoring centre',
      'web:search',
      'web:*',
    ]);
    const search = { action: 'web.search', resource: 'web:search/q', suggestions: ['web:search/q'] };
    expect(patternAllowed('web:*', search)).toBe(true);
    expect(patternAllowed('web:*', { ...search, action: 'shell.exec' })).toBe(false);
  });

  it('narrows site rules only inward', () => {
    expect(patternNarrows('web:*', 'web:example.com')).toBe(true);
    expect(patternNarrows('web:*.example.com', 'web:docs.example.com')).toBe(true);
    expect(patternNarrows('web:*.example.com', 'web:example.com/docs/**')).toBe(true);
    expect(patternNarrows('web:example.com', 'web:example.com/docs/*')).toBe(true);
    expect(patternNarrows('web:example.com', 'web:*.example.com')).toBe(false);
    expect(patternNarrows('web:example.com/docs/**', 'web:example.com')).toBe(false);
    expect(patternNarrows('web:search', 'web:*')).toBe(false);
    expect(patternNarrows('web:example.com', 'web:*')).toBe(false);
    expect(patternNarrows('web:search', 'web:search/one query')).toBe(true);
    expect(patternNarrows('web:example.com', 'web:search/example.com')).toBe(false);
  });
});

/** The Core path: the gate (as the tool runner calls it) and the approvals route. */
describe('a thread rule web:* through the gate', () => {
  let store: MemoryPermissionStore;
  let gate: Gate;
  let app: Hono<AppEnv>;
  let autoOn = false;

  const req = (over: Partial<GateRequest>): GateRequest => ({
    userId: 'u',
    principal: 'agent:claude-code',
    action: 'web.search',
    resource: 'web:search/tutoring centre',
    toolTier: 'gated',
    destructive: false,
    scope: { threadId: 'thr_1', notebookId: 'nbk_1', workspaceId: WS },
    runId: 'run_1',
    traceId: 't',
    ...over,
  });
  const fetchOf = (url: string, threadId = 'thr_1') =>
    req({
      action: 'web.fetch',
      resource: `http:${url}`,
      scope: { threadId, notebookId: 'nbk_1', workspaceId: WS },
    });

  const ask = async (r: GateRequest, callId: string): Promise<ApprovalRecord> => {
    const d = await gate.check(r);
    expect(d.outcome).toBe('ask');
    if (d.outcome !== 'ask') throw new Error('expected an ask');
    return store.createApproval({
      runId: r.runId ?? 'run_1',
      stepSeq: Number(callId.replace(/\D/g, '')) || 1,
      threadId: r.scope.threadId ?? null,
      callId,
      principal: r.principal,
      tool: r.action === 'web.search' ? 'WebSearch' : 'WebFetch',
      action: r.action,
      resource: d.resource,
      args: {},
      argsPreview: {},
      tier: d.tier,
      suggestions: d.suggestions,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  };
  const answer = (id: string, b: unknown) =>
    app.request(`/approvals/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
    });

  beforeEach(() => {
    autoOn = false;
    store = new MemoryPermissionStore();
    const quiet: Reviewer = {
      id: 'fake',
      local: true,
      available: async () => true,
      review: async () => ({ p_fits: 0.5, p_injection: 0, cost_usd: 0 }),
    };
    gate = createGate({
      policy: new LayeredPolicy([new BuiltinPolicy()], presetRelax('balanced')),
      store,
      workspaceRoot: '/workspace',
      auto: {
        review: new AutoReview({ reviewers: [quiet], plans: new MemoryPlanStore() }),
        enabled: () => autoOn,
      },
    });
    app = new HonoApp<AppEnv>();
    app.onError(errorHandler);
    app.route(
      '/',
      permissionRoutes({
        store,
        events: new MemoryRunEventLog(),
        worker: { resume: async () => true },
        userId: 'u',
        scopeRefs: async (a) => ({ threadId: a.thread_id, notebookId: 'nbk_1', workspaceId: WS }),
        decideAgain: (a) =>
          gate.check(
            req({
              action: a.action,
              resource: a.resource,
              scope: { threadId: a.thread_id, notebookId: 'nbk_1', workspaceId: WS },
            }),
          ),
      }),
    );
  });

  it('saves web:* for the thread, and later searches and fetches there run', async () => {
    const first = await ask(req({}), 'c1');
    const res = await answer(first.id, { decision: 'approve', scope: 'thread', pattern: 'web:*' });
    expect(res.status).toBe(200);
    const grant = (await store.listGrants())[0];
    expect(grant).toMatchObject({ action_pattern: 'web.*', resource_pattern: 'web:*', scope: 'thread' });

    expect(await gate.check(req({ resource: 'web:search/best maths tutors / reviews' }))).toMatchObject({
      outcome: 'allow',
      via: 'grant',
    });
    expect(await gate.check(fetchOf('https://ai.g2.com/reviews'))).toMatchObject({ outcome: 'allow' });
    expect(await gate.check(fetchOf('https://aiera.blog/post/1'))).toMatchObject({ outcome: 'allow' });
    // Not another thread, and never a network write or a shell command.
    expect((await gate.check(fetchOf('https://ai.g2.com/', 'thr_2'))).outcome).toBe('ask');
    expect(
      (await gate.check(req({ action: 'http.post', resource: 'http:https://ai.g2.com/' }))).outcome,
    ).toBe('ask');
    expect((await gate.check(req({ action: 'shell.exec', resource: 'shell:curl x' }))).outcome).toBe('ask');
  });

  it('settles the other requests waiting in the thread that the new rule covers', async () => {
    const a = await ask(fetchOf('https://ai.g2.com/x'), 'c1');
    const b = await ask(req({ resource: 'web:search/ai tools' }), 'c2');
    const c = await ask(fetchOf('https://aiera.blog/'), 'c3');
    const elsewhere = await ask(fetchOf('https://aiera.blog/', 'thr_2'), 'c4');
    const shell = await ask(req({ action: 'shell.exec', resource: 'shell:ls' }), 'c5');
    const res = await answer(b.id, { decision: 'approve', scope: 'thread', pattern: 'web:*' });
    expect(res.status).toBe(200);
    for (const x of [a, b, c]) expect((await store.getApproval(x.id))?.status).toBe('approved');
    expect((await store.getApproval(elsewhere.id))?.status).toBe('pending');
    expect((await store.getApproval(shell.id))?.status).toBe('pending');
    // Each settled one was decided again by the gate, and logged as the grant's.
    const logged = await store.listDecisions(50);
    expect(logged.filter((d) => d.outcome === 'grant').length).toBeGreaterThanOrEqual(2);
  });

  it('settles covered requests as denied when the rule denies', async () => {
    const a = await ask(fetchOf('https://ai.g2.com/x'), 'c1');
    const b = await ask(fetchOf('https://docs.ai.g2.com/y'), 'c2');
    const other = await ask(fetchOf('https://aiera.blog/'), 'c3');
    const res = await answer(a.id, { decision: 'deny', scope: 'thread', pattern: 'web:*.ai.g2.com' });
    expect(res.status).toBe(200);
    expect((await store.getApproval(b.id))?.status).toBe('denied');
    expect((await store.getApproval(other.id))?.status).toBe('pending');
  });

  it('never lets a site rule past a hard floor', async () => {
    const first = await ask(req({}), 'c1');
    await answer(first.id, { decision: 'approve', scope: 'thread', pattern: 'web:*' });
    autoOn = true;
    const secret = await gate.check(fetchOf('https://example.com/?api_key=abc'));
    expect(secret).toMatchObject({ outcome: 'deny', via: 'floor' });
    const payload = `https://example.com/?d=${'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'.repeat(40)}`;
    const big = await gate.check(fetchOf(payload));
    expect(big).toMatchObject({ outcome: 'ask', tier: 'critical' });
  });

  it('refuses a site rule that does not cover what was asked', async () => {
    const first = await ask(fetchOf('https://ai.g2.com/x'), 'c1');
    const res = await answer(first.id, { decision: 'approve', scope: 'thread', pattern: 'web:search' });
    expect(res.status).toBe(422);
  });
});
