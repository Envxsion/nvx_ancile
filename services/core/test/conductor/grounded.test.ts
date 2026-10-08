/**
 * Phase 3, Core side: a question asked in a notebook is answered from its
 * sources, and the answer's citations are held to what it was given.
 */
import type { Message, Part, RetrievalTrace, SearchResponse, ThreadPath } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { applyCitations } from '../../src/conductor/citations';
import { groundingFrom, queryFor, type Retriever } from '../../src/conductor/retrieval';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

const hit = (n: number, text: string) => ({
  kind: 'chunk' as const,
  chunk_id: `chk_${n}`,
  source_id: `src_${n}`,
  source_title: `Source ${n}`,
  text,
  heading_path: ['Specs'],
  page: n,
  char_start: n * 100,
  char_end: n * 100 + text.length,
  score: 1 / n,
  rerank_score: null,
  ranks: { vector: n, text: n },
});

const RESPONSE: SearchResponse = {
  hits: [
    hit(1, 'The P-300 pump moves 42 litres a minute at full speed. It weighs 18 kg.'),
    hit(2, 'Service intervals are every 600 running hours, or yearly, whichever is first.'),
  ],
  mode: 'hybrid',
  embedder: 'local/test',
  ms: 4,
};

describe('citations', () => {
  const trace = (): RetrievalTrace =>
    groundingFrom(RESPONSE, { query: 'q', notebookId: 'nbk_1', notebookTitle: 'Pumps' }).trace;
  const spans = new Map(
    groundingFrom(RESPONSE, { query: 'q', notebookId: 'nbk_1', notebookTitle: null }).spans,
  );

  it('keeps valid markers, strips invented ones and counts them', () => {
    const parts: Part[] = [
      { type: 'text', text: 'It moves 42 litres a minute [1][7]. Service it yearly [2, 9].' },
    ];
    const r = applyCitations(parts, trace(), spans);
    expect((r.parts[0] as { text: string }).text).toBe(
      'It moves 42 litres a minute [1]. Service it yearly [2].',
    );
    expect(r.trace.invalid_markers).toBe(2);
    expect(r.cited).toEqual([1, 2]);
    expect(r.parts.filter((p) => p.type === 'citation_ref')).toHaveLength(2);
  });

  it('leaves markers inside code and markdown links alone', () => {
    const parts: Part[] = [
      { type: 'text', text: 'Use `arr[3]` and see [the docs](https://x.y) and [9](https://z).' },
    ];
    const r = applyCitations(parts, trace(), spans);
    expect((r.parts[0] as { text: string }).text).toContain('`arr[3]`');
    expect(r.trace.invalid_markers).toBe(0);
  });

  it('is grounded only when every paragraph that says something cites', () => {
    const cited = applyCitations(
      [{ type: 'text', text: 'The pump moves 42 litres a minute at full speed [1].' }],
      trace(),
      spans,
    );
    expect(cited.trace.grounded).toBe(true);
    const mixed = applyCitations(
      [
        {
          type: 'text',
          text: 'The pump moves 42 litres a minute at full speed [1].\n\nIt is also the best pump ever made, by far.',
        },
      ],
      trace(),
      spans,
    );
    expect(mixed.trace.grounded).toBe(false);
  });

  it('carries the exact span of each cited passage', () => {
    const r = applyCitations([{ type: 'text', text: 'Yearly service [2].' }], trace(), spans);
    const ref = r.parts.find((p) => p.type === 'citation_ref');
    expect(ref).toMatchObject({ marker: 2, source_id: 'src_2', char_start: 200 });
  });

  it('searches a short follow-up together with the question before it', () => {
    expect(queryFor(['How fast is the P-300 pump?', 'and the P-400?'])).toBe(
      'How fast is the P-300 pump?\nand the P-400?',
    );
    expect(queryFor(['How often should the P-300 pump be serviced in a dusty site?'])).toBe(
      'How often should the P-300 pump be serviced in a dusty site?',
    );
  });
});

describe('a grounded turn', () => {
  async function lastAssistant(threadId: string): Promise<Message> {
    const path = (await h.call<ThreadPath>('GET', `/threads/${threadId}/path`)).body;
    return path.messages.at(-1) as Message;
  }

  it('answers from the notebook with valid citations and records why', async () => {
    const seen: string[] = [];
    const retriever: Retriever = {
      search: async ({ query, notebookId }) => {
        seen.push(`${notebookId}:${query}`);
        return RESPONSE;
      },
    };
    h = await harness({ retriever });
    const t = await h.newThread({ notebook_id: 'nbk_pumps' });
    const sent = await h.send(t, 'How fast is the P-300 pump?');
    await h.settle(sent.run_id);
    expect(seen).toEqual(['nbk_pumps:How fast is the P-300 pump?']);
    const m = await lastAssistant(t);
    const text = m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
    expect(text).toContain('[1]');
    expect(m.parts.some((p) => p.type === 'citation_ref')).toBe(true);
    const prov = m.provenance as { retrieval?: RetrievalTrace };
    expect(prov.retrieval?.hits.find((x) => x.marker === 1)?.cited).toBe(true);
    expect(prov.retrieval?.grounded).toBe(true);
    const evs = await h.eventsOf(sent.run_id);
    expect(evs.some((e) => e.type === 'retrieval.done')).toBe(true);
    expect(evs.some((e) => e.type === 'citation')).toBe(true);
  });

  it('goes on without sources when the search fails, and says so', async () => {
    h = await harness({
      retriever: {
        search: async () => {
          throw new Error('knowledge down');
        },
      },
    });
    const t = await h.newThread({ notebook_id: 'nbk_pumps' });
    const sent = await h.send(t, '/say plain answer');
    await h.settle(sent.run_id);
    const m = await lastAssistant(t);
    expect(m.status).toBe('complete');
    expect((m.provenance as { retrieval_error?: unknown }).retrieval_error).toBeTruthy();
  });

  it('narrows to @-mentioned sources, and grounds a loose thread in a mentioned notebook', async () => {
    const seen: { notebookId: string; sourceIds?: string[] }[] = [];
    h = await harness({
      retriever: {
        search: async ({ notebookId, sourceIds }) => {
          seen.push({ notebookId, sourceIds });
          return RESPONSE;
        },
      },
    });
    const t = await h.newThread();
    const res = await h.call<{ run_id: string }>('POST', `/threads/${t}/messages`, {
      parent_id: null,
      parts: [{ type: 'text', text: 'How fast is the P-300 pump?' }],
      mentions: [
        { kind: 'notebook', id: 'nbk_pumps' },
        { kind: 'source', id: 'src_1' },
      ],
    });
    await h.settle(res.body.run_id);
    expect(seen).toEqual([{ notebookId: 'nbk_pumps', sourceIds: ['src_1'] }]);
  });

  it('never searches outside a notebook', async () => {
    let calls = 0;
    h = await harness({
      retriever: {
        search: async () => {
          calls++;
          return RESPONSE;
        },
      },
    });
    const t = await h.newThread();
    const sent = await h.send(t, '/say hi');
    await h.settle(sent.run_id);
    expect(calls).toBe(0);
  });
});
