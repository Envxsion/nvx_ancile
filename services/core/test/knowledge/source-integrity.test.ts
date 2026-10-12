/**
 * Track G, Core side: an answer's citations survive their source being
 * deleted or changed; a fact-check re-run keeps the score before it; one
 * huge source cannot fill a turn's passages.
 */
import type {
  CitationStatus,
  EvidenceResponse,
  Factcheck,
  Message,
  Part,
  PassageCheckRequest,
  PassageCheckResponse,
  RetrievalTrace,
  SearchHit,
  SearchResponse,
  StartFactcheckResponse,
  ThreadPath,
} from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { applyCitations } from '../../src/conductor/citations';
import { capPerSource, fetchK, groundingFrom, type Retriever } from '../../src/conductor/retrieval';
import { MemoryTombstoneStore, passageHash, sourceIntegrity } from '../../src/knowledge/integrity';
import { type Harness, harness, WORKSPACE_ID } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

const hit = (n: number, text: string, source = `src_${n}`): SearchHit => ({
  kind: 'chunk',
  chunk_id: `chk_${n}`,
  source_id: source,
  source_title: source === 'src_big' ? 'Repo dump' : `Source ${n}`,
  text,
  heading_path: [],
  page: null,
  char_start: n * 100,
  char_end: n * 100 + text.length,
  score: 1 / n,
  rerank_score: null,
  ranks: { vector: n, text: n },
});

const PUMP = 'The P-300 pump moves 42 litres a minute at full speed. It weighs 18 kg.';
const RESPONSE: SearchResponse = {
  hits: [hit(1, PUMP, 'src_manual'), hit(2, 'Service it every 600 running hours.', 'src_guide')],
  mode: 'hybrid',
  embedder: 'local/test',
  ms: 3,
};

/**
 * A knowledge service stand-in: /passages/check answers from `state`
 * (source id → what became of it), /evidence finds the pump passage.
 */
function fakeKnowledge(state: Map<string, 'current' | 'changed' | 'removed'>) {
  const calls: PassageCheckRequest[] = [];
  return {
    calls,
    down: false,
    async post<T>(path: string, body: unknown): Promise<T> {
      if (path === '/passages/check') {
        if (this.down) throw new Error('knowledge is down');
        const req = body as PassageCheckRequest;
        calls.push(req);
        const res: PassageCheckResponse = {
          items: req.items.map((i) => ({
            ref: i.ref,
            source_id: i.source_id,
            state: state.get(i.source_id) ?? 'current',
            source_title: state.get(i.source_id) === 'removed' ? null : 'Pump manual',
            deleted_at: null,
          })),
        };
        return res as T;
      }
      if (path === '/evidence') {
        const req = body as { claims: string[] };
        const res: EvidenceResponse = {
          mode: 'hybrid',
          embedder: null,
          ms: 1,
          results: req.claims.map((claim) => {
            const on = /pump/i.test(claim);
            return {
              claim,
              coverage: on ? 1 : 0,
              hits: on
                ? [
                    {
                      kind: 'chunk' as const,
                      chunk_id: 'chk_1',
                      source_id: 'src_manual',
                      source_title: 'Pump manual',
                      page: null,
                      heading_path: [],
                      text: PUMP,
                      quote: PUMP,
                      quote_start: 0,
                      quote_end: PUMP.length,
                      rerank_score: 0.95,
                      relevance: 0.95,
                    },
                  ]
                : [],
            };
          }),
        };
        return res as T;
      }
      throw new Error(`unexpected ${path}`);
    },
  };
}

describe('citations keep what they quoted', () => {
  it('records the source title and a hash of the whole passage at cite time', () => {
    const g = groundingFrom(RESPONSE, { query: 'q', notebookId: 'nbk_1', notebookTitle: null });
    const r = applyCitations(
      [{ type: 'text', text: 'It moves 42 litres a minute [1].' }],
      g.trace,
      new Map(g.spans),
    );
    const ref = r.parts.find((p) => p.type === 'citation_ref') as Extract<Part, { type: 'citation_ref' }>;
    expect(ref.source_title).toBe('Source 1');
    expect(ref.text_sha256).toBe(passageHash(PUMP));
    expect(ref.text_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ref.quote).toBe(PUMP);
  });
});

describe('source integrity', () => {
  it('a tombstone says removed, with the name, even when knowledge has forgotten the source', async () => {
    const tombstones = new MemoryTombstoneStore();
    await tombstones.record({
      source_id: 'src_manual',
      workspace_id: 'wsp_1',
      title: 'Pump manual',
      kind: 'file',
      reason: 'merged',
      merged_into: 'src_manual_v2',
    });
    const kn = fakeKnowledge(new Map([['src_manual', 'removed']]));
    const check = sourceIntegrity({ workspaceId: 'wsp_1', tombstones, kn });
    const [gone, other] = await check.check([
      { ref: 'chk_1', source_id: 'src_manual', text_sha256: passageHash(PUMP) },
      { ref: 'chk_2', source_id: 'src_guide', text_sha256: null },
    ]);
    expect(gone).toMatchObject({
      state: 'removed',
      source_title: 'Pump manual',
      merged_into: 'src_manual_v2',
    });
    expect(gone?.removed_at).toBeTruthy();
    expect(other).toMatchObject({ state: 'current', removed_at: null });
    // The hash goes to knowledge as it was stored; a citation without one sends null.
    expect(kn.calls[0]?.items.map((i) => i.text_sha256)).toEqual([passageHash(PUMP), null]);
  });

  it('says unknown, never changed, when knowledge cannot be asked; tombstones still count', async () => {
    const tombstones = new MemoryTombstoneStore();
    await tombstones.record({
      source_id: 'src_old',
      workspace_id: 'wsp_1',
      title: 'Old notes',
      kind: 'text',
      reason: 'deleted',
      merged_into: null,
    });
    const kn = fakeKnowledge(new Map());
    kn.down = true;
    const check = sourceIntegrity({ workspaceId: 'wsp_1', tombstones, kn });
    const out = await check.check([
      { ref: 'chk_1', source_id: 'src_manual', text_sha256: null },
      { ref: 'chk_9', source_id: 'src_old', text_sha256: null },
    ]);
    expect(out.map((o) => o.state)).toEqual(['unknown', 'removed']);
    expect(out[1]?.source_title).toBe('Old notes');
  });

  it('a tombstone in another workspace does not count', async () => {
    const tombstones = new MemoryTombstoneStore();
    await tombstones.record({
      source_id: 'src_manual',
      workspace_id: 'wsp_other',
      title: 'x',
      kind: null,
      reason: 'deleted',
      merged_into: null,
    });
    const check = sourceIntegrity({ workspaceId: 'wsp_1', tombstones, kn: fakeKnowledge(new Map()) });
    expect((await check.check([{ ref: 'c', source_id: 'src_manual', text_sha256: null }]))[0]?.state).toBe(
      'current',
    );
  });
});

describe('an answer after its source is deleted or changed', () => {
  const retriever: Retriever = { search: async () => RESPONSE };

  async function groundedAnswer(): Promise<Message> {
    const t = await h.newThread({ notebook_id: 'nbk_pumps' });
    const sent = await h.send(t, 'How fast is the P-300 pump?');
    await h.settle(sent.run_id);
    const path = (await h.call<ThreadPath>('GET', `/threads/${t}/path`)).body;
    return path.messages.at(-1) as Message;
  }

  it('reads "removed" with the quoted passage intact, and "changed" when the text moved on', async () => {
    const state = new Map<string, 'current' | 'changed' | 'removed'>();
    const tombstones = new MemoryTombstoneStore();
    const kn = fakeKnowledge(state);
    h = await harness({
      retriever,
      integrity: sourceIntegrity({ workspaceId: WORKSPACE_ID, tombstones, kn }),
    });
    const m = await groundedAnswer();
    const ref = m.parts.find((p) => p.type === 'citation_ref') as Extract<Part, { type: 'citation_ref' }>;
    expect(ref).toBeTruthy();

    const before = (await h.call<CitationStatus>('GET', `/messages/${m.id}/citations`)).body;
    expect(before.items[0]).toMatchObject({ marker: ref.marker, state: 'current', removed_at: null });

    // The source is deleted: the answer is untouched and its citation says so.
    await tombstones.record({
      source_id: ref.source_id,
      workspace_id: WORKSPACE_ID,
      title: ref.source_title ?? '',
      kind: 'file',
      reason: 'deleted',
      merged_into: null,
    });
    state.set(ref.source_id, 'removed');
    const after = (await h.call<CitationStatus>('GET', `/messages/${m.id}/citations`)).body;
    expect(after.items[0]).toMatchObject({ state: 'removed', source_title: ref.source_title });
    expect(after.items[0]?.removed_at).toBeTruthy();
    const still = (await h.repo.getMessage(m.id))?.parts.find((p) => p.type === 'citation_ref');
    expect(still).toEqual(ref);

    // Another answer whose source was re-read with different text.
    tombstones.rows.clear();
    state.set(ref.source_id, 'changed');
    const changed = (await h.call<CitationStatus>('GET', `/messages/${m.id}/citations`)).body;
    expect(changed.items[0]?.state).toBe('changed');
  });

  it('a re-run fact-check keeps the earlier score beside the new one, and says the sources changed', async () => {
    const state = new Map<string, 'current' | 'changed' | 'removed'>();
    const tombstones = new MemoryTombstoneStore();
    const kn = fakeKnowledge(state);
    h = await harness({ kn, integrity: sourceIntegrity({ workspaceId: WORKSPACE_ID, tombstones, kn }) });
    const t = await h.newThread();
    const sent = await h.send(t, '/say The P-300 pump moves 42 litres a minute at full speed.');
    await h.settle(sent.run_id);
    const id = sent.assistant_message_id;
    const run = async () => {
      const start = await h.call<StartFactcheckResponse>('POST', `/messages/${id}/factcheck`);
      await h.settle(start.body.run_id);
      return (await h.call<Factcheck>('GET', `/messages/${id}/factcheck`)).body;
    };

    const first = await run();
    expect(first.status).toBe('done');
    expect(first.previous).toBeNull();

    // Nothing changed: the earlier score is shown, with no note.
    const second = await run();
    expect(second.previous).toMatchObject({
      id: first.id,
      confidence: first.confidence,
      sources_changed: false,
    });
    expect(second.previous?.note).toBeNull();

    // The manual is deleted, and the check is run again.
    state.set('src_manual', 'removed');
    await tombstones.record({
      source_id: 'src_manual',
      workspace_id: WORKSPACE_ID,
      title: 'Pump manual',
      kind: 'file',
      reason: 'deleted',
      merged_into: null,
    });
    const third = await run();
    expect(third.previous).toMatchObject({
      id: second.id,
      confidence: second.confidence,
      sources_changed: true,
      removed: 1,
      changed: 0,
      note: 'Sources changed since: 1 removed.',
    });
    // Every check is kept: the first is still readable in the store.
    expect((await h.factchecks.get(first.id))?.confidence).toBe(first.confidence);
  });
});

describe('one source cannot fill a turn', () => {
  it('caps passages per source and keeps the ranking', () => {
    const hits = [1, 2, 3, 4, 5, 6].map((n) => hit(n, `p${n}`, 'src_big'));
    const mixed = [...hits.slice(0, 5), hit(7, 'p7'), hits[5] as SearchHit, hit(8, 'p8')];
    const out = capPerSource(mixed, 8, 4);
    expect(out.map((h) => h.chunk_id)).toEqual(['chk_1', 'chk_2', 'chk_3', 'chk_4', 'chk_7', 'chk_8']);
    expect(capPerSource(mixed, 3, 4).map((h) => h.chunk_id)).toEqual(['chk_1', 'chk_2', 'chk_3']);
    expect(fetchK(8, 4)).toBe(24);
    expect(fetchK(8, 8)).toBe(8);
    expect(fetchK(40, 1)).toBe(100);
  });

  it('a grounded turn takes at most four passages from a huge source', async () => {
    const big: SearchResponse = {
      ...RESPONSE,
      hits: [
        ...[1, 2, 3, 4, 5, 6, 7].map((n) => hit(n, `Pump fact ${n} from the dump.`, 'src_big')),
        hit(8, PUMP, 'src_manual'),
      ],
    };
    const asked: number[] = [];
    h = await harness({
      retriever: {
        search: async ({ k }) => {
          asked.push(k);
          return big;
        },
      },
    });
    const t = await h.newThread({ notebook_id: 'nbk_pumps' });
    const sent = await h.send(t, 'How fast is the P-300 pump?');
    await h.settle(sent.run_id);
    const path = (await h.call<ThreadPath>('GET', `/threads/${t}/path`)).body;
    const trace = (path.messages.at(-1)?.provenance as { retrieval?: RetrievalTrace } | undefined)?.retrieval;
    expect(asked).toEqual([8]);
    expect(trace?.hits.filter((x) => x.source_id === 'src_big')).toHaveLength(4);
    expect(trace?.hits.some((x) => x.source_id === 'src_manual')).toBe(true);
  });
});
