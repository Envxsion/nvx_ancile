/**
 * What a live re-test of fact-check found (21 Oct), each as a test:
 *  - a source passage on another subject is not evidence, so "Grass is green." takes the
 *    common-knowledge path instead of being judged against a handbook about invoices;
 *  - the verdict follows the checker's stance, the confidence is shown beside it;
 *  - the claims found in an answer are kept and reused by the next check, and sentences about
 *    other sentences are not claims;
 *  - a kept verdict carries how it was reached (the tier it started at), and a re-run asks no model
 *    and no search for what it already knows.
 */

import type { EvidenceResponse, Factcheck, StartFactcheckResponse } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryVerdictCacheStore, VerdictCache } from '../../src/factcheck/cache';
import { type ClaimOutcome, scoreOutcome } from '../../src/factcheck/pipeline';
import { DEFAULT_RELEVANT, scoreClaim } from '../../src/factcheck/score';
import {
  cachedCheck,
  checkClaim,
  EXTRACTOR_VERSION,
  gatherEvidence,
  isMetaSentence,
  validateClaims,
} from '../../src/factcheck/steps';
import { setTriageProvider } from '../../src/factcheck/triage';
import { factcheckReply } from '../../src/gateway/fake-factcheck';
import type { Gateway } from '../../src/gateway/gateway';
import { type Harness, harness } from '../support/harness';

const signal = new AbortController().signal;

/* ---- 1. relevance ---------------------------------------------------------- */

const hit = (relevance: number, text = 'The Fernway handbook covers invoices.') => ({
  kind: 'chunk' as const,
  chunk_id: `chk_${relevance}`,
  source_id: 'src_h',
  source_title: 'Fernway handbook',
  page: null,
  heading_path: [],
  text,
  quote: text,
  quote_start: 0,
  quote_end: text.length,
  rerank_score: relevance,
  relevance,
});
const knWith = (hits: ReturnType<typeof hit>[], coverage = 0.4) => ({
  async post<T>(): Promise<T> {
    const res: EvidenceResponse = {
      mode: 'hybrid',
      embedder: null,
      ms: 1,
      results: [{ claim: 'Grass is green.', hits, coverage }],
    };
    return res as T;
  },
});
const gather = (hits: ReturnType<typeof hit>[], minRelevance?: number) =>
  gatherEvidence({ kn: knWith(hits) } as never, {
    workspaceId: 'w',
    notebookId: 'n',
    claims: ['Grass is green.'],
    ...(minRelevance !== undefined && { minRelevance }),
  });

describe('a source passage on another subject is not evidence', () => {
  it('drops passages under the relevance cut, and the coverage with them', async () => {
    const [g] = await gather([hit(0)]);
    expect(g?.evidence).toEqual([]);
    expect(g?.coverage).toBe(0);
  });

  it('keeps the ones over it, whatever else was dropped', async () => {
    const [g] = await gather([hit(0.9), hit(0.02), hit(DEFAULT_RELEVANT)]);
    expect(g?.evidence.map((e) => e.score)).toEqual([0.9, DEFAULT_RELEVANT]);
    expect(g?.coverage).toBe(0.4);
  });

  it('takes the cut from the config when it has one', async () => {
    const [g] = await gather([hit(0.3), hit(0.6)], 0.5);
    expect(g?.evidence.map((e) => e.score)).toEqual([0.6]);
  });
});

/** A gateway that answers each call with a stance, and remembers the prompts. */
function answering(stance: 'supported' | 'contradicted' | 'insufficient', confidence = 0.9) {
  const prompts: string[] = [];
  const gateway = {
    async *stream(chain: { id: string }[], req: { messages: { content: string }[] }) {
      prompts.push(req.messages[0]?.content ?? '');
      yield { type: 'model', modelId: chain[0]?.id };
      yield {
        type: 'chunk',
        chunk: {
          type: 'text',
          delta: JSON.stringify({ stance, evidence: [], rationale: 'Common knowledge.', confidence }),
        },
      };
      yield {
        type: 'chunk',
        chunk: { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } },
      };
    },
  } as unknown as Gateway;
  return { gateway, prompts };
}
const tiny = {
  id: 'm/tiny',
  provider: 'openai',
  provider_model: 'tiny',
  display_name: 'tiny',
  via: 'direct',
  family: 'openai',
  context_window: 100_000,
  max_output: 8_000,
  capabilities: [],
  price: { input_per_mtok: 0, output_per_mtok: 0 },
  enabled: true,
};
const registry = {
  get: () => tiny,
  tierOf: () => 'tiny' as const,
  resolveWant: () => ({ chain: [tiny], degraded: [], unmet: null, refused: [] }),
};
const ask = (claim: string, obvious: boolean, gateway: Gateway) =>
  checkClaim(
    { gateway, registry, promptsDir: '/none' } as never,
    {
      claim,
      evidence: [],
      triage: { tier: obvious ? 'tiny' : 'fast', floor: 'tiny', obvious, critical: false } as never,
      critical: false,
      generatorFamily: null,
      notebookId: null,
      sharing: false,
    },
    signal,
  );

describe('with no relevant source', () => {
  it('an obvious claim is judged from common knowledge and shown verified at 70%', async () => {
    const { gateway, prompts } = answering('supported');
    const out = await ask('Grass is green.', true, gateway);
    expect(prompts).toHaveLength(1);
    expect(out.general).toBe(true);
    const scored = scoreOutcome({
      claim: { text: 'Grass is green.', charStart: 0, charEnd: 15, importance: 1, checkable: true },
      evidence: out.evidence,
      coverage: 0,
      verdict: out.verdict,
      rationale: out.rationale,
      general: out.general,
    });
    expect(scored.score).toMatchObject({ verdict: 'verified', confidence: 0.7 });
  });

  it('any other claim is left unverified without asking a model: no source covers it', async () => {
    const { gateway, prompts } = answering('supported');
    const out = await ask('The Eiffel Tower is 330 metres tall.', false, gateway);
    expect(prompts).toHaveLength(0);
    expect(out.verdict).toBe('insufficient');
    expect(out.rationale).toBe('Nothing in your sources mentions this.');
  });
});

/* ---- 2. the verdict follows the stance -------------------------------------- */

describe('the verdict follows the checker, the confidence sits beside it', () => {
  const passage = (score: number) => [{ stance: 'supports' as const, score }];

  it('a passage that states the claim, backed by a checker that supports it, is verified at any retrieval score', () => {
    // Seen live: rerank 0.72 and 0.68, rationale "the source states this explicitly", came back unverified.
    for (const score of [0.68, 0.72, 0.83, 0.95]) {
      const s = scoreClaim({
        checkable: true,
        evidence: passage(score),
        verifier: 'supported',
        coverage: 1,
        checkerConfidence: 0.9,
      });
      expect(s.verdict).toBe('verified');
      expect(s.confidence).toBeGreaterThan(0.5);
    }
  });

  it('a checker that supports it but is under half sure leaves it unverified', () => {
    expect(
      scoreClaim({
        checkable: true,
        evidence: passage(0.95),
        verifier: 'supported',
        coverage: 1,
        checkerConfidence: 0.3,
      }).verdict,
    ).toBe('unverified');
  });

  it('a checker that gave no confidence is not second-guessed', () => {
    expect(
      scoreClaim({ checkable: true, evidence: passage(0.7), verifier: 'supported', coverage: 1 }).verdict,
    ).toBe('verified');
  });

  it('"insufficient" stays unverified however good the passages look', () => {
    expect(
      scoreClaim({
        checkable: true,
        evidence: passage(0.99),
        verifier: 'insufficient',
        coverage: 1,
        checkerConfidence: 0.95,
      }).verdict,
    ).toBe('unverified');
  });

  it('a "supported" that leaned on nothing, with only a loose passage, is not verified', () => {
    expect(
      scoreClaim({
        checkable: true,
        evidence: [{ stance: 'neutral', score: 0.2 }],
        verifier: 'supported',
        coverage: 1,
        checkerConfidence: 0.9,
      }).verdict,
    ).toBe('unverified');
  });

  it('two checkers must both support it, and the less sure one counts', () => {
    const base = { checkable: true, evidence: passage(0.9), coverage: 1 };
    expect(
      scoreClaim({ ...base, verifier: ['supported', 'supported'], checkerConfidence: 0.9 }).verdict,
    ).toBe('verified');
    expect(scoreClaim({ ...base, verifier: ['supported', 'insufficient'] }).verdict).toBe('unverified');
    expect(
      scoreClaim({ ...base, verifier: ['supported', 'supported'], checkerConfidence: 0.2 }).verdict,
    ).toBe('unverified');
  });

  it("the checker's confidence reaches the score through the outcome", () => {
    const o = (confidence: number): ClaimOutcome => ({
      claim: { text: 'x', charStart: 0, charEnd: 1, importance: 1, checkable: true },
      evidence: [
        {
          kind: 'chunk',
          ref: 'c',
          source_id: 's',
          source_title: 't',
          page: null,
          char_start: 0,
          char_end: 1,
          quote: 'x',
          stance: 'supports',
          score: 0.72,
          origin: 'source',
        },
      ],
      coverage: 1,
      verdict: 'supported',
      rationale: 'The source states it explicitly.',
      confidence,
    });
    expect(scoreOutcome(o(0.9)).score.verdict).toBe('verified');
    expect(scoreOutcome(o(0.2)).score.verdict).toBe('unverified');
  });
});

/* ---- 3. extraction ---------------------------------------------------------- */

describe('sentences about other sentences are not claims', () => {
  it.each([
    'The first sentence contradicts the others.',
    'The previous statement is wrong.',
    'This answer mixes true and false claims.',
    'The second claim above is not supported by the sources.',
  ])('%s', (text) => {
    expect(isMetaSentence(text)).toBe(true);
  });

  it.each([
    'The second law of thermodynamics says entropy rises.',
    'Mount Everest is 8,849 metres tall.',
    'The last train leaves at nine.',
  ])('%s is', (text) => {
    expect(isMetaSentence(text)).toBe(false);
  });

  it('are dropped by validateClaims, the others kept at their offsets', () => {
    const answer = 'The sky is blue. The first sentence contradicts the others. Sydney is in Australia.';
    const claims = validateClaims(answer, [
      { text: 'The sky is blue.', char_start: 0, char_end: 16, importance: 1, checkable: true },
      {
        text: 'The first sentence contradicts the others.',
        char_start: 17,
        char_end: 59,
        importance: 1,
        checkable: true,
      },
      { text: 'Sydney is in Australia.', char_start: 60, char_end: 83, importance: 1, checkable: true },
    ]);
    expect(claims.map((c) => c.text)).toEqual(['The sky is blue.', 'Sydney is in Australia.']);
  });
});

/** A fact-check gateway that answers the offline way and counts what it is asked. */
function counting() {
  const calls = { extract: 0, verify: 0, extra: [] as string[] };
  const gateway = {
    async *stream(chain: { id: string }[], req: { messages: { content: string }[] }) {
      const prompt = req.messages[0]?.content ?? '';
      yield { type: 'model', modelId: chain[0]?.id };
      if (prompt.includes('Return JSON matching ClaimList')) {
        calls.extract += 1;
        // The first time the model also "finds" a sentence about the others, and a different set on a re-extraction.
        const reply = JSON.parse(factcheckReply(prompt) as string) as { claims: { text: string }[] };
        if (calls.extract > 1) reply.claims = reply.claims.slice(0, 2);
        yield { type: 'chunk', chunk: { type: 'text', delta: JSON.stringify(reply) } };
      } else {
        calls.verify += 1;
        yield { type: 'chunk', chunk: { type: 'text', delta: factcheckReply(prompt) ?? '{}' } };
      }
      yield {
        type: 'chunk',
        chunk: { type: 'finish', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 5 } },
      };
    },
  } as unknown as Gateway;
  return { gateway, calls };
}

const ANSWER =
  'The ZX-4410 pump must be primed before first use. Error code E-19 means the impeller is blocked. The housing is made of cast aluminium alloy. Output pressure peaks at four bar.';
const SOURCE =
  'The ZX-4410 pump must be primed before first use. Error code E-19 means the impeller is blocked. The housing is made of cast aluminium alloy. Output pressure peaks at four bar.';
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
            chunk_id: 'chk_0',
            source_id: 'src_manual',
            source_title: 'Pump manual',
            page: 2,
            heading_path: ['Pump manual'],
            text: SOURCE,
            quote: claim,
            quote_start: 0,
            quote_end: claim.length,
            rerank_score: 0.9,
            relevance: 0.9,
          },
        ],
      })),
    };
    return res as T;
  },
};

let h: Harness;
afterEach(async () => {
  setTriageProvider(null);
  await h?.close();
});

async function answered(text: string) {
  const thread = await h.newThread();
  const sent = await h.send(thread, `/say ${text}`);
  await h.settle(sent.run_id);
  return sent.assistant_message_id;
}
async function check(message: string, body: Record<string, unknown> = {}) {
  const start = await h.call<StartFactcheckResponse>('POST', `/messages/${message}/factcheck`, body);
  expect(start.status).toBe(202);
  await h.settle(start.body.run_id, 20_000);
  return (await h.call<Factcheck>('GET', `/messages/${message}/factcheck`)).body;
}

describe('the claims found in an answer are kept', () => {
  it('a check run again judges the same sentences without finding them again', async () => {
    const c = counting();
    h = await harness({ kn, factcheck: { gateway: c.gateway } });
    const message = await answered(ANSWER);
    const first = await check(message);
    expect(c.calls.extract).toBe(1);
    const again = await check(message, { again: true });
    expect(c.calls.extract).toBe(1);
    expect(again.claims.map((x) => x.text)).toEqual(first.claims.map((x) => x.text));
    expect(again.claims.length).toBeGreaterThan(2);
  });

  it('finds them again when asked to, and when the extraction is newer', async () => {
    const c = counting();
    h = await harness({ kn, factcheck: { gateway: c.gateway } });
    const message = await answered(ANSWER);
    await check(message);
    const redone = await check(message, { reextract: true });
    expect(c.calls.extract).toBe(2);
    expect(redone.claims).toHaveLength(2);
    // The new set is the one kept now.
    await check(message);
    expect(c.calls.extract).toBe(2);
    // A kept set from an older extraction is not trusted.
    const kept = h.factchecks.extractions.get(message);
    if (kept) h.factchecks.extractions.set(message, { ...kept, version: EXTRACTOR_VERSION - 1 });
    await check(message);
    expect(c.calls.extract).toBe(3);
  });
});

/* ---- 4. kept verdicts and the re-run ----------------------------------------- */

describe('a verdict that is kept carries how it was reached', () => {
  const claim = 'Output pressure peaks at four bar.';
  const evidence = [
    {
      kind: 'chunk' as const,
      ref: 'chk_0',
      source_id: 's',
      source_title: 'Manual',
      page: null,
      char_start: 0,
      char_end: 10,
      quote: claim,
      stance: 'supports' as const,
      score: 0.8,
      origin: 'source' as const,
      text: claim,
    },
  ];

  it('returns the tier it started at and what routing settled for, with the model and the date', async () => {
    const cache = new VerdictCache(new MemoryVerdictCacheStore());
    const args = { notebookId: 'n', shared: false, claim, evidence, critical: false };
    await cache.record({
      ...args,
      verdict: {
        stance: 'supported',
        rationale: 'It says so.',
        evidence,
        confidence: 0.9,
        general: false,
        escalated_from: 'fast',
        degraded: ["Only the writer's family was ready."],
      },
      tier: 'best',
      modelId: 'm/big',
    });
    const got = await cachedCheck({ cache }, args);
    expect(got).toMatchObject({
      verdict: 'supported',
      tier: 'best',
      modelId: 'm/big',
      escalatedFrom: 'fast',
      degraded: ["Only the writer's family was ready."],
      cached: { model_id: 'm/big', scope: 'notebook' },
    });
  });

  it('an older entry without them reads as not escalated', async () => {
    const cache = new VerdictCache(new MemoryVerdictCacheStore());
    const args = { notebookId: 'n', shared: false, claim, evidence, critical: false };
    await cache.record({
      ...args,
      verdict: { stance: 'supported', rationale: '', evidence, confidence: 0.9, general: false },
      tier: 'fast',
      modelId: 'm/a',
    });
    expect(await cachedCheck({ cache }, args)).toMatchObject({ escalatedFrom: null, degraded: [] });
  });

  it('a verdict made with web evidence is also found from the sources alone, for a week', async () => {
    const store = new MemoryVerdictCacheStore();
    const cache = new VerdictCache(store);
    const web = {
      ...(evidence[0] as (typeof evidence)[number]),
      kind: 'url' as const,
      ref: 'https://example.org/a',
      origin: 'web' as const,
      score: 0.5,
    };
    const { gateway } = answering('supported');
    const asked = await checkClaim(
      { gateway, registry, promptsDir: '/none', cache } as never,
      {
        claim,
        evidence: [...evidence, web],
        triage: { tier: 'fast', floor: 'tiny', obvious: false, critical: false } as never,
        critical: false,
        generatorFamily: null,
        notebookId: 'n',
        sharing: false,
      },
      signal,
    );
    expect(asked.cached).toBeNull();
    // The web is not searched again to find it.
    const found = await cachedCheck(
      { cache },
      { notebookId: 'n', shared: false, claim, evidence, critical: false },
    );
    expect(found?.verdict).toBe('supported');
    const entry = [...store.rows.values()].find((r) => r.ttl_kind === 'web' && !r.source_backed);
    expect(entry?.expires_at).not.toBeNull();
  });
});

describe('a re-run asks no model and no search for what it already knows', () => {
  it('answers from the kept verdicts before triage, with the same verdicts and how they were reached', async () => {
    let triaged = 0;
    setTriageProvider({
      async triage(claims) {
        triaged += claims.length;
        return claims.map(() => null);
      },
    });
    const c = counting();
    const cache = new VerdictCache(new MemoryVerdictCacheStore());
    h = await harness({ kn, factcheck: { gateway: c.gateway, cache } });
    const message = await answered(ANSWER);
    const first = await check(message);
    const asked = triaged;
    const verifies = c.calls.verify;
    expect(asked).toBeGreaterThan(0);
    expect(verifies).toBeGreaterThan(0);

    const second = await check(message);
    // Nothing was asked: not the extraction, not the decision layer, not a model.
    expect(c.calls.extract).toBe(1);
    expect(c.calls.verify).toBe(verifies);
    expect(triaged).toBe(asked);
    expect(second.claims.map((x) => x.verdict)).toEqual(first.claims.map((x) => x.verdict));
    for (const claim of second.claims) expect(claim.check?.cached).not.toBeNull();
  });
});
