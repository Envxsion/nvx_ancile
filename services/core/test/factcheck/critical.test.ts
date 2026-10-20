/**
 * Mission-critical fact-checks and the shared verdict cache, through the routes (TR3, SI1): a critical
 * check that cannot find two independent checkers stops and asks, then runs on the models you pick, the
 * writer's provider included; and sharing a notebook's checks is one step each way.
 */
import type { EvidenceResponse, Factcheck, FactcheckNeedsChoice, VerdictCacheState } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryVerdictCacheStore, VerdictCache } from '../../src/factcheck/cache';
import { MemoryNotebookRepo } from '../../src/notebooks/repo';
import { fakeModel } from '../gateway/fake-provider';
import { type Harness, harness, WORKSPACE_ID } from '../support/harness';

const PASSAGE = 'The ZX-4410 pump must be primed before first use.';
const kn = {
  async post<T>(_path: string, body: unknown): Promise<T> {
    const req = body as { claims: string[] };
    const res: EvidenceResponse = {
      mode: 'hybrid',
      embedder: null,
      ms: 1,
      results: req.claims.map((claim) => ({
        claim,
        coverage: 1,
        hits: [
          {
            kind: 'chunk' as const,
            chunk_id: 'chk_1',
            source_id: 'src_manual',
            source_title: 'Pump manual',
            page: 2,
            heading_path: ['Pump manual'],
            text: PASSAGE,
            quote: PASSAGE,
            quote_start: 0,
            quote_end: PASSAGE.length,
            rerank_score: 0.95,
            relevance: 0.95,
          },
        ],
      })),
    };
    return res as T;
  },
};

const at = (id: string, family: string, tier: 'tiny' | 'fast' | 'balanced' | 'best') => ({
  ...fakeModel(id, 'script', family),
  tier,
});

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function answered() {
  const thread = await h.newThread({ notebook_id: 'nbk_1' });
  const sent = await h.send(thread, `/say ${PASSAGE}`);
  await h.settle(sent.run_id);
  return sent.assistant_message_id;
}

describe('mission-critical mode', () => {
  const lineup = (models: ReturnType<typeof at>[]) => ({
    offline: false,
    kn,
    models,
    taskClasses: { 'chat.default': ['fake/writer'] },
  });

  it('stops and asks when two independent checkers are not ready, listing every model', async () => {
    h = await harness(
      lineup([at('writer', 'famA', 'balanced'), at('other', 'famA', 'best'), at('small', 'famC', 'tiny')]),
    );
    const message = await answered();
    const res = await h.call<FactcheckNeedsChoice>('POST', `/messages/${message}/factcheck`, {
      critical: true,
    });
    expect(res.status).toBe(200);
    const choice = res.body.needs_choice;
    expect(choice.code).toBe('factcheck.needs_choice');
    expect(choice.floor).toBe('balanced');
    // Every ready chat model is offered; the same provider as the writer is allowed.
    expect(choice.models.map((m) => m.id).sort()).toEqual(['fake/other', 'fake/small', 'fake/writer']);
    expect(choice.models.find((m) => m.id === 'fake/other')).toMatchObject({
      same_family_as_writer: true,
      suitable: true,
    });
    expect(choice.models.find((m) => m.id === 'fake/small')?.suitable).toBe(false);
    expect(choice.suggested).toEqual(['fake/other']);
    // Nothing was started.
    expect(await h.factchecks.latestFor(message)).toBeUndefined();
  });

  it('runs on the models you pick, same provider included, and records that it was critical', async () => {
    h = await harness(lineup([at('writer', 'famA', 'balanced'), at('other', 'famA', 'best')]));
    const message = await answered();
    const res = await h.call<{ run_id: string }>('POST', `/messages/${message}/factcheck`, {
      critical: true,
      models: ['fake/other'],
    });
    expect(res.status).toBe(202);
    await h.settle(res.body.run_id);
    const f = (await h.call<Factcheck>('GET', `/messages/${message}/factcheck`)).body;
    expect(f.status).toBe('done');
    expect(f.critical).toBe(true);
    expect(f.verifier_model_id).toBe('fake/other');
    expect(f.claims.find((c) => c.check)?.check).toMatchObject({ tier_used: 'best', model_id: 'fake/other' });
  });

  it('refuses a pick that is not a ready chat model', async () => {
    h = await harness(lineup([at('writer', 'famA', 'balanced')]));
    const message = await answered();
    const res = await h.call<{ error: { code: string } }>('POST', `/messages/${message}/factcheck`, {
      critical: true,
      models: ['fake/nope'],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('factcheck.model_not_ready');
  });

  it('picks two checkers itself when two families at standard tier or better are ready', async () => {
    h = await harness(
      lineup([at('writer', 'famA', 'balanced'), at('b1', 'famB', 'balanced'), at('c1', 'famC', 'best')]),
    );
    const message = await answered();
    const res = await h.call<{ run_id: string }>('POST', `/messages/${message}/factcheck`, {
      critical: true,
    });
    expect(res.status).toBe(202);
    await h.settle(res.body.run_id);
    const f = (await h.call<Factcheck>('GET', `/messages/${message}/factcheck`)).body;
    expect(f.status).toBe('done');
    expect(f.critical).toBe(true);
  });

  it('follows the notebook setting when the request says nothing', async () => {
    h = await harness({
      ...lineup([at('writer', 'famA', 'balanced'), at('other', 'famA', 'best')]),
      trust: { notebookFlags: async () => ({ critical: true, sharing: false }) },
    });
    const message = await answered();
    const res = await h.call<FactcheckNeedsChoice>('POST', `/messages/${message}/factcheck`);
    expect(res.status).toBe(200);
    expect(res.body.needs_choice.code).toBe('factcheck.needs_choice');
  });
});

describe('sharing a notebook’s checks', () => {
  async function setup(privateOk: boolean) {
    const notebooks = new MemoryNotebookRepo();
    await notebooks.create({ id: 'nbk_1', workspace_id: WORKSPACE_ID, title: 'Pumps' });
    const store = new MemoryVerdictCacheStore();
    const cache = new VerdictCache(store, { allows: async () => privateOk });
    h = await harness({
      offline: false,
      kn,
      models: [at('writer', 'famA', 'balanced')],
      taskClasses: { 'chat.default': ['fake/writer'] },
      trust: { cache, notebooks },
    });
    return { cache, store, notebooks };
  }

  it('shares in one step and stops in one step', async () => {
    const { cache, notebooks } = await setup(true);
    await cache.record({
      notebookId: 'nbk_1',
      shared: false,
      claim: 'The sky is blue.',
      evidence: [],
      critical: false,
      verdict: { stance: 'supported', rationale: '', evidence: [], confidence: 0.9, general: true },
      tier: 'tiny',
      modelId: 'fake/small',
    });
    const before = await h.call<VerdictCacheState>('GET', '/notebooks/nbk_1/verdict-cache');
    expect(before.body).toMatchObject({ scope: 'notebook', entries: 1, can_share: true });
    const on = await h.call<VerdictCacheState>('POST', '/notebooks/nbk_1/verdict-cache', { shared: true });
    expect(on.body).toMatchObject({ scope: 'global', entries: 1 });
    expect((await notebooks.get('nbk_1'))?.share_checks).toBe(true);
    const off = await h.call<VerdictCacheState>('POST', '/notebooks/nbk_1/verdict-cache', { shared: false });
    expect(off.body.scope).toBe('notebook');
    expect((await notebooks.get('nbk_1'))?.share_checks).toBe(false);
  });

  it('will not share from a private notebook until the setting allows it', async () => {
    const { notebooks } = await setup(false);
    const state = await h.call<VerdictCacheState>('GET', '/notebooks/nbk_1/verdict-cache');
    expect(state.body).toMatchObject({ can_share: false });
    expect(state.body.share_note).toMatch(/Private notebooks/);
    const res = await h.call<{ error: { code: string } }>('POST', '/notebooks/nbk_1/verdict-cache', {
      shared: true,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('privacy.denied');
    expect((await notebooks.get('nbk_1'))?.share_checks).toBe(false);
  });

  it('answers 404 for a notebook that is not there', async () => {
    await setup(true);
    const res = await h.call('GET', '/notebooks/nbk_missing/verdict-cache');
    expect(res.status).toBe(404);
  });
});
