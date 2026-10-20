/**
 * A whole fact-check on models that cannot answer: it ends, within its limits, with every claim
 * "Not checked: <reason>" (never a crash), and stopping it ends it as cancelled. And every model call it
 * made is in Usage, with its purpose.
 */
import type { EvidenceResponse, Factcheck, StartFactcheckResponse, UsageReport } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { factcheckReply } from '../../src/gateway/fake-factcheck';
import type { Gateway } from '../../src/gateway/gateway';
import { type Harness, harness } from '../support/harness';

const ANSWER =
  'The ZX-4410 pump must be primed before first use. Error code E-19 means the impeller is blocked. The pump weighs twelve kilograms in total. The housing is made of cast aluminium alloy. Output pressure peaks at four bar.';

/** Knowledge finds one passage for every claim, so every claim has something to be judged against. */
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
            text: 'The pump is described here.',
            quote: 'The pump is described here.',
            quote_start: 0,
            quote_end: 27,
            rerank_score: 0.9,
            relevance: 0.9,
          },
        ],
      })),
    };
    return res as T;
  },
};

/** Extraction works; every verification reply is nonsense, so no model can ever settle a claim. */
function unusable() {
  const calls = { extract: 0, verify: 0 };
  const gateway = {
    async *stream(chain: { id: string }[], req: { messages: { content: string }[] }) {
      const prompt = req.messages[0]?.content ?? '';
      yield { type: 'model', modelId: chain[0]?.id };
      if (prompt.includes('Return JSON matching ClaimList')) {
        calls.extract += 1;
        yield { type: 'chunk', chunk: { type: 'text', delta: factcheckReply(prompt) as string } };
      } else {
        calls.verify += 1;
        yield { type: 'chunk', chunk: { type: 'text', delta: 'I cannot say.' } };
      }
      yield {
        type: 'chunk',
        chunk: { type: 'finish', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 5 } },
      };
    },
  } as unknown as Gateway;
  return { gateway, calls };
}

/** Every call waits until it is stopped. */
function hanging() {
  let started!: () => void;
  const begun = new Promise<void>((r) => {
    started = r;
  });
  const gateway = {
    async *stream(_chain: unknown, _req: unknown, signal: AbortSignal) {
      started();
      await new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
      });
    },
  } as unknown as Gateway;
  return { gateway, begun };
}

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function answered(text: string) {
  const thread = await h.newThread();
  const sent = await h.send(thread, `/say ${text}`);
  await h.settle(sent.run_id);
  return sent.assistant_message_id;
}

describe('a check on models that cannot answer', () => {
  it('ends within its limits, every claim "Not checked", and is not a crash', async () => {
    const bad = unusable();
    h = await harness({ kn, factcheck: { gateway: bad.gateway } });
    const message = await answered(ANSWER);
    const start = await h.call<StartFactcheckResponse>('POST', `/messages/${message}/factcheck`);
    expect(start.status).toBe(202);
    await h.settle(start.body.run_id, 20_000);
    const f = (await h.call<Factcheck>('GET', `/messages/${message}/factcheck`)).body;

    expect(f.status).toBe('done');
    expect(f.claims.length).toBeGreaterThanOrEqual(4);
    for (const c of f.claims) {
      expect(c.verdict).toBe('unverified');
      expect(c.rationale).toMatch(/^Not checked: /);
    }
    // One call to find the claims, then at most three for each claim, and never more than twenty.
    expect(bad.calls.extract).toBe(1);
    expect(bad.calls.verify).toBeLessThanOrEqual(3 * f.claims.length);
    expect(bad.calls.extract + bad.calls.verify).toBeLessThanOrEqual(20);
  });

  it('stopping it ends it as cancelled, not as run.crashed', async () => {
    const wait = hanging();
    h = await harness({ kn, factcheck: { gateway: wait.gateway } });
    const message = await answered(ANSWER);
    const start = await h.call<StartFactcheckResponse>('POST', `/messages/${message}/factcheck`);
    await wait.begun;
    await h.call('POST', `/runs/${start.body.run_id}/cancel`);
    await h.settle(start.body.run_id, 10_000);
    const run = await h.runs.get(start.body.run_id);
    expect(run?.status).toBe('cancelled');
    const f = (await h.call<Factcheck>('GET', `/messages/${message}/factcheck`)).body;
    // The check reads cancelled, as the run does; it is not a failure.
    expect(f.status).toBe('cancelled');
    expect(f.error?.code).toBe('run.cancelled');
  });
});

describe('usage counts every model call, with its purpose', () => {
  it('a fact-check shows under "factcheck", and chat answers are not counted twice', async () => {
    h = await harness({ kn });
    const message = await answered('The ZX-4410 pump must be primed before first use.');
    const start = await h.call<StartFactcheckResponse>('POST', `/messages/${message}/factcheck`);
    await h.settle(start.body.run_id, 20_000);
    await new Promise((r) => setTimeout(r, 20));

    const purposes = new Set(h.ledger.calls.map((c) => c.purpose));
    expect(purposes).toEqual(new Set(['factcheck']));
    expect(h.ledger.calls.length).toBeGreaterThanOrEqual(1);

    const report = (await h.call<UsageReport>('GET', '/usage?range=day')).body;
    const by = Object.fromEntries(report.by_purpose.map((p) => [p.purpose, p]));
    expect(by.factcheck?.calls).toBe(h.ledger.calls.length);
    // Chat answers are not counted twice: the ledger holds none of them.
    expect(h.ledger.calls.some((c) => c.purpose === 'chat')).toBe(false);
    const sum = report.by_purpose.reduce((n, p) => n + p.input_tokens + p.output_tokens, 0);
    expect(sum).toBe(report.totals.input_tokens + report.totals.output_tokens);
  });
});
