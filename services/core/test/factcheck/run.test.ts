/**
 * Fact-check runs end to end on the offline models: extraction at exact
 * offsets, evidence from Knowledge, an independent verifier, the three
 * verdicts, the seal, grounded mode, and the explain route.
 */
import type { EvidenceResponse, Explain, Factcheck, StartFactcheckResponse } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeClaims, fakeVerdict } from '../../src/gateway/fake-structured';
import { type Harness, harness } from '../support/harness';

const PASSAGES = [
  'The ZX-4410 pump must be primed before first use.',
  'Error code E-19 means the impeller is blocked; switch off and clear it.',
  'Owls are nocturnal birds of prey.',
];

/** A Knowledge stand-in: passages sharing two or more words with the claim, strongest first. */
const kn = {
  calls: [] as unknown[],
  async post<T>(path: string, body: unknown): Promise<T> {
    kn.calls.push({ path, body });
    const req = body as { claims: string[]; notebook_id: string | null };
    const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{4,}/g) ?? []);
    const res: EvidenceResponse = {
      mode: 'hybrid',
      embedder: null,
      ms: 1,
      results: req.claims.map((claim) => {
        const cw = words(claim);
        const hits = PASSAGES.filter((p) => [...words(p)].filter((w) => cw.has(w)).length >= 2).map(
          (p, i) => ({
            kind: 'chunk' as const,
            chunk_id: `chk_${i}`,
            source_id: 'src_manual',
            source_title: 'Pump manual',
            page: 2,
            heading_path: ['Pump manual'],
            text: p,
            quote: p,
            quote_start: 100,
            quote_end: 100 + p.length,
            rerank_score: 0.95,
            relevance: 0.95,
          }),
        );
        return { claim, hits, coverage: hits.length ? 1 : 0 };
      }),
    };
    return res as T;
  },
};

let h: Harness;
afterEach(async () => {
  kn.calls = [];
  await h?.close();
});

async function answered(text: string, threadBody: Record<string, unknown> = {}) {
  const thread = await h.newThread(threadBody);
  const sent = await h.send(thread, `/say ${text}`);
  await h.settle(sent.run_id);
  return { thread, message: sent.assistant_message_id };
}

async function check(messageId: string) {
  const start = await h.call<StartFactcheckResponse>('POST', `/messages/${messageId}/factcheck`);
  expect(start.status).toBe(202);
  await h.settle(start.body.run_id);
  return (await h.call<Factcheck>('GET', `/messages/${messageId}/factcheck`)).body;
}

describe('fact-check runs', () => {
  it('finds the three verdicts, with offsets into the answer', async () => {
    h = await harness({ kn });
    const answer =
      'The ZX-4410 pump must be primed before first use. Error code E-17 means the impeller is blocked. I think you should call support afterwards.';
    const { message } = await answered(answer);
    const f = await check(message);

    expect(f.status).toBe('done');
    expect(f.claims.map((c) => c.verdict)).toEqual(['verified', 'contradicted', 'not_checkable']);
    for (const c of f.claims) expect(answer.slice(c.char_start, c.char_end)).toBe(c.text);
    expect(f.counts).toEqual({ verified: 1, unverified: 0, contradicted: 1, not_checkable: 1 });
    expect(f.sealed).toBe(false);
    expect(f.summary).toMatch(/^1 of 2 claims verified and 1 contradicted/);
    // The contradicting passage is shown with its exact quote and where it lives.
    const contradicted = f.claims[1];
    expect(contradicted?.evidence[0]).toMatchObject({
      stance: 'contradicts',
      source_title: 'Pump manual',
      page: 2,
    });
    expect(contradicted?.explanation).toMatch(/second model disagrees/);
    // The verifier is the other offline model: a different family from the writer.
    expect(f.verifier_model_id).toBe('offline/echo');
  });

  it('seals an answer whose every claim holds', async () => {
    h = await harness({ kn });
    const { message } = await answered('Owls are nocturnal birds of prey.');
    const f = await check(message);
    expect(f.counts.verified).toBe(1);
    expect(f.sealed).toBe(true);
    expect(f.confidence).toBeGreaterThan(0.6);
    // The answer itself says it was checked, so a thread needs no request per answer.
    expect((await h.repo.getMessage(message))?.provenance.factcheck).toMatchObject({
      id: f.id,
      status: 'done',
      sealed: true,
    });
  });

  it('marks claims with no evidence unverified', async () => {
    h = await harness({ kn });
    const { message } = await answered('Sourdough starters need feeding with flour every single day.');
    const f = await check(message);
    expect(f.claims.map((c) => c.verdict)).toEqual(['unverified']);
    expect(f.claims[0]?.evidence).toEqual([]);
  });

  it('streams progress and finishes the run', async () => {
    h = await harness({ kn });
    const { message } = await answered('Owls are nocturnal birds of prey.');
    const start = await h.call<StartFactcheckResponse>('POST', `/messages/${message}/factcheck`);
    await h.settle(start.body.run_id);
    const stages = (await h.eventsOf(start.body.run_id)).flatMap((e) =>
      e.type === 'factcheck.progress' ? [e.stage] : [],
    );
    expect(stages[0]).toBe('extracting');
    expect(stages).toContain('verifying');
    expect(stages.at(-1)).toBe('done');
    expect((await h.runs.get(start.body.run_id))?.status).toBe('succeeded');
  });

  it('searches the thread notebook only', async () => {
    h = await harness({ kn });
    const { message } = await answered('Owls are nocturnal birds of prey.', { notebook_id: 'nbk_1' });
    await check(message);
    expect(kn.calls[0]).toMatchObject({ path: '/evidence', body: { notebook_id: 'nbk_1' } });
  });

  it('refuses what is not a finished answer, and says when none exists', async () => {
    h = await harness({ kn });
    const thread = await h.newThread();
    const sent = await h.send(thread, '/say Owls are nocturnal birds of prey.');
    await h.settle(sent.run_id);
    const user = await h.call<{ error: { code: string } }>(
      'POST',
      `/messages/${sent.user_message_id}/factcheck`,
    );
    expect(user.status).toBe(409);
    expect(user.body.error.code).toBe('factcheck.not_answer');
    const none = await h.call<{ error: { code: string } }>(
      'GET',
      `/messages/${sent.assistant_message_id}/factcheck`,
    );
    expect(none.status).toBe(404);
    expect(none.body.error.code).toBe('factcheck.none');
  });

  it('does not hold the thread: you can keep talking while it checks', async () => {
    h = await harness({ kn });
    const { thread, message } = await answered('Owls are nocturnal birds of prey.');
    const start = await h.call<StartFactcheckResponse>('POST', `/messages/${message}/factcheck`);
    const next = await h.send(thread, 'and bats?', { parent_id: message });
    await h.settle(next.run_id);
    await h.settle(start.body.run_id);
    expect((await h.runs.get(start.body.run_id))?.threadId).toBeNull();
  });

  it('runs on its own in a grounded notebook', async () => {
    h = await harness({ kn, grounded: ['nbk_g'] });
    const { message } = await answered('Owls are nocturnal birds of prey.', { notebook_id: 'nbk_g' });
    const until = Date.now() + 3_000;
    let f: Factcheck | undefined;
    while (Date.now() < until) {
      const r = await h.call<Factcheck>('GET', `/messages/${message}/factcheck`);
      if (r.status === 200 && r.body.status !== 'running') {
        f = r.body;
        break;
      }
      await new Promise((res) => setTimeout(res, 20));
    }
    expect(f?.status).toBe('done');
    expect(f?.sealed).toBe(true);
  });

  it('fails clearly when the sources cannot be searched', async () => {
    h = await harness({
      kn: {
        post: async () => {
          throw new Error('connection refused');
        },
      },
    });
    const { message } = await answered('Owls are nocturnal birds of prey.');
    const f = await check(message);
    expect(f.status).toBe('failed');
    expect(f.error?.code).toBe('factcheck.evidence_unavailable');
  });
});

describe('explain', () => {
  it('assembles the model, tools with their decisions, usage and the fact-check', async () => {
    h = await harness({ kn });
    const thread = await h.newThread();
    const sent = await h.send(thread, '/tool fs_list {"path":"/workspace"}');
    await h.settle(sent.run_id);
    const before = await h.call<Explain>('GET', `/messages/${sent.assistant_message_id}/explain`);
    expect(before.status).toBe(200);
    const x = before.body;
    expect(x.model.id).toBe('offline/test');
    expect(x.tools).toHaveLength(1);
    expect(x.tools[0]).toMatchObject({ tool: 'fs_list', ok: true, decision: { outcome: 'auto' } });
    expect(x.retrieval).toBeNull();
    expect(x.memory).toBeNull();
    expect(x.compaction).toBeNull();
    expect(x.factcheck).toBeNull();
    expect(x.trace_url).toContain('/admin/traces?trace=');

    const { message } = await answered('Owls are nocturnal birds of prey.');
    await check(message);
    const after = await h.call<Explain>('GET', `/messages/${message}/explain`);
    expect(after.body.factcheck?.sealed).toBe(true);
  });

  it('reads memory and compaction from provenance when they were recorded', async () => {
    h = await harness({ kn });
    const { message } = await answered('Owls are nocturnal birds of prey.');
    await h.repo.updateMessage(message, {
      provenance: {
        memory: {
          files: [{ path: 'USER.md', commit: 'abc123', entries: ['m:1'], tokens: 12, dropped: 0 }],
          tokens: 40,
          truncated: 0,
        },
        compaction: {
          summary_id: 'sum_1',
          upto_message_id: 'msg_1',
          tokens_before: 9000,
          tokens_after: 1200,
        },
      },
    });
    const x = (await h.call<Explain>('GET', `/messages/${message}/explain`)).body;
    expect(x.memory?.files[0]?.path).toBe('USER.md');
    expect(x.compaction?.tokens_after).toBe(1200);
  });

  it('only explains answers', async () => {
    h = await harness({ kn });
    const thread = await h.newThread();
    const sent = await h.send(thread, 'hello');
    await h.settle(sent.run_id);
    expect((await h.call('GET', `/messages/${sent.user_message_id}/explain`)).status).toBe(404);
  });
});

describe('the offline model as a fact-checker', () => {
  it('extracts sentences at exact offsets, leaving citations and bullets out', () => {
    const answer =
      'From your sources:\n\n- Owls are nocturnal birds of prey. [1]\n\n_Offline test model: quotes only._';
    const [c] = fakeClaims(answer);
    expect(c && answer.slice(c.char_start, c.char_end)).toBe('Owls are nocturnal birds of prey.');
    expect(fakeClaims(answer)).toHaveLength(1);
  });

  it('contradicts on a differing number or negation, supports on agreement', () => {
    const ev = [{ ref: 'E1', text: 'The pump runs at 3000 rpm.' }];
    expect(fakeVerdict('The pump runs at 3000 rpm.', ev).stance).toBe('supported');
    expect(fakeVerdict('The pump runs at 4500 rpm.', ev).stance).toBe('contradicted');
    expect(fakeVerdict('The pump never runs at 3000 rpm.', ev).stance).toBe('contradicted');
    expect(fakeVerdict('Owls hunt at night.', ev).stance).toBe('insufficient');
  });
});
