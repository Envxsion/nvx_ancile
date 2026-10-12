/**
 * Phase 3 (C): a turn reads through context links. Linked notebooks are
 * searched beside the thread's own, ranked together, and a linked passage
 * names its notebook in the trace and in the citation; a linked thread's
 * summary is given as context; refused links are recorded for the Why view.
 */
import type { Message, RetrievalTrace, SearchHit, SearchResponse, ThreadPath } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { explainLinks, searchWithLinks } from '../../src/conductor/links';
import { DEFAULT_LIMITS, type Retriever } from '../../src/conductor/retrieval';
import type { TurnLinks } from '../../src/links/service';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

const hit = (id: string, score: number, text: string): SearchHit => ({
  kind: 'chunk',
  chunk_id: `chk_${id}`,
  source_id: `src_${id}`,
  source_title: `Source ${id}`,
  text,
  heading_path: [],
  page: null,
  char_start: 0,
  char_end: text.length,
  score,
  rerank_score: null,
  ranks: { vector: 1, text: 1 },
});

const res = (hits: SearchHit[]): SearchResponse => ({ hits, mode: 'hybrid', embedder: 'local/test', ms: 3 });

const BY_NOTEBOOK: Record<string, SearchResponse> = {
  nbk_pumps: res([hit('own', 0.4, 'The P-300 pump weighs 18 kg.')]),
  nbk_specs: res([hit('linked', 0.9, 'The P-300 pump moves 42 litres a minute at full speed.')]),
};

describe('searching with links', () => {
  it('ranks own and linked passages together and marks the linked ones', async () => {
    const seen: string[] = [];
    const retriever: Retriever = {
      search: async ({ notebookId, sourceIds }) => {
        seen.push(`${notebookId}:${sourceIds?.join(',') ?? '*'}`);
        return BY_NOTEBOOK[notebookId] ?? res([]);
      },
    };
    const { response, via } = await searchWithLinks({
      retriever,
      workspaceId: 'w',
      query: 'q',
      limits: DEFAULT_LIMITS,
      own: { notebookId: 'nbk_pumps' },
      linked: [
        {
          linkId: 'lnk_1',
          source: 'link' as const,
          via: 'thread',
          notebookId: 'nbk_specs',
          title: 'Specs',
          sourceIds: ['src_linked'],
        },
      ],
    });
    expect(seen).toEqual(['nbk_pumps:*', 'nbk_specs:src_linked']);
    expect(response.hits.map((x) => x.chunk_id)).toEqual(['chk_linked', 'chk_own']);
    expect(via.get('chk_linked')).toEqual({
      link_id: 'lnk_1',
      notebook_id: 'nbk_specs',
      notebook_title: 'Specs',
    });
    expect(via.has('chk_own')).toBe(false);
  });

  it('leaves out a linked notebook whose search fails, and keeps a source both hold as the thread’s own', async () => {
    const shared = hit('shared', 0.5, 'Shared passage.');
    const retriever: Retriever = {
      search: async ({ notebookId }) => {
        if (notebookId === 'nbk_down') throw new Error('down');
        return res([shared]);
      },
    };
    const { response, via } = await searchWithLinks({
      retriever,
      workspaceId: 'w',
      query: 'q',
      limits: DEFAULT_LIMITS,
      own: { notebookId: 'nbk_pumps' },
      linked: [
        {
          linkId: 'lnk_a',
          source: 'link' as const,
          via: 'thread',
          notebookId: 'nbk_down',
          title: 'Down',
          sourceIds: undefined,
        },
        {
          linkId: 'lnk_b',
          source: 'link' as const,
          via: 'notebook',
          notebookId: 'nbk_same',
          title: 'Same',
          sourceIds: undefined,
        },
      ],
    });
    expect(response.hits).toHaveLength(1);
    expect(via.size).toBe(0);
  });

  it('explains used, empty, summary and refused links', () => {
    const turn: TurnLinks = {
      notebooks: [
        {
          linkId: 'lnk_1',
          source: 'link' as const,
          via: 'thread',
          notebookId: 'nbk_specs',
          title: 'Specs',
          sourceIds: undefined,
        },
        {
          linkId: 'lnk_2',
          source: 'link' as const,
          via: 'notebook',
          notebookId: 'nbk_none',
          title: 'None',
          sourceIds: undefined,
        },
      ],
      summaries: [
        { linkId: 'lnk_3', source: 'link' as const, via: 'thread', threadId: 'thr_y', title: 'Y', text: 'S' },
      ],
      skipped: [
        {
          link_id: 'lnk_4',
          kind: 'sources',
          via: 'thread',
          to_kind: 'notebook',
          to_id: 'nbk_private',
          title: 'Private',
          state: 'refused',
          passages: 0,
          cited: 0,
          code: 'scope.private_notebook',
          reason: 'no',
        },
      ],
    };
    const trace = {
      hits: [
        { via: { link_id: 'lnk_1', notebook_id: 'nbk_specs' }, cited: true },
        { via: { link_id: 'lnk_1', notebook_id: 'nbk_specs' }, cited: false },
      ],
    } as unknown as RetrievalTrace;
    const out = explainLinks(turn, trace);
    expect(out.map((l) => [l.link_id, l.state, l.passages, l.cited])).toEqual([
      ['lnk_4', 'refused', 0, 0],
      ['lnk_1', 'used', 2, 1],
      ['lnk_2', 'empty', 0, 0],
      ['lnk_3', 'used', 0, 0],
    ]);
    expect(explainLinks(null, null)).toEqual([]);
  });
});

describe('a turn that reads through links', () => {
  async function lastAssistant(threadId: string): Promise<Message> {
    const path = (await h.call<ThreadPath>('GET', `/threads/${threadId}/path`)).body;
    return path.messages.at(-1) as Message;
  }

  it('cites a linked notebook by name and records which links contributed', async () => {
    let asked = 0;
    h = await harness({
      retriever: { search: async ({ notebookId }) => BY_NOTEBOOK[notebookId] ?? res([]) },
      links: {
        forTurn: async () => {
          asked++;
          return {
            notebooks: [
              {
                linkId: 'lnk_1',
                source: 'link' as const,
                via: 'thread',
                notebookId: 'nbk_specs',
                title: 'Specs',
                sourceIds: undefined,
              },
            ],
            summaries: [
              {
                linkId: 'lnk_2',
                source: 'link' as const,
                via: 'notebook',
                threadId: 'thr_y',
                title: 'Pump trial',
                text: 'The trial ran for 3 weeks.',
              },
            ],
            skipped: [
              {
                link_id: 'lnk_3',
                kind: 'sources',
                via: 'thread',
                to_kind: 'notebook',
                to_id: 'nbk_private',
                title: 'Private notes',
                state: 'refused',
                passages: 0,
                cited: 0,
                code: 'scope.private_notebook',
                reason:
                  'The notebook "Private notes" is private, so it can only be read where nothing leaves this machine',
              },
            ],
          };
        },
      },
    });
    const t = await h.newThread({ notebook_id: 'nbk_pumps' });
    const sent = await h.send(t, 'How fast is the P-300 pump?');
    await h.settle(sent.run_id);
    expect(asked).toBe(1);
    const m = await lastAssistant(t);
    const prov = m.provenance as { retrieval?: RetrievalTrace; links?: { link_id: string; state: string }[] };
    expect(prov.retrieval?.hits[0]?.via).toEqual({
      link_id: 'lnk_1',
      notebook_id: 'nbk_specs',
      notebook_title: 'Specs',
    });
    expect(prov.links?.map((l) => [l.link_id, l.state])).toEqual([
      ['lnk_3', 'refused'],
      ['lnk_1', 'used'],
      ['lnk_2', 'used'],
    ]);
    const ref = m.parts.find((p) => p.type === 'citation_ref' && p.source_id === 'src_linked');
    expect(ref).toMatchObject({ notebook_id: 'nbk_specs', notebook_title: 'Specs' });
    const why = await h.call<{ links: { link_id: string }[] }>('GET', `/messages/${m.id}/explain`);
    expect(why.status).toBe(200);
    expect(why.body.links.map((l) => l.link_id)).toEqual(['lnk_3', 'lnk_1', 'lnk_2']);
  });

  it('reads linked notebooks in a thread outside any notebook', async () => {
    const seen: string[] = [];
    h = await harness({
      retriever: {
        search: async ({ notebookId }) => {
          seen.push(notebookId);
          return BY_NOTEBOOK[notebookId] ?? res([]);
        },
      },
      links: {
        forTurn: async () => ({
          notebooks: [
            {
              linkId: 'lnk_1',
              source: 'link' as const,
              via: 'thread',
              notebookId: 'nbk_specs',
              title: 'Specs',
              sourceIds: undefined,
            },
          ],
          summaries: [],
          skipped: [],
        }),
      },
    });
    const t = await h.newThread();
    const sent = await h.send(t, 'How fast is the P-300 pump?');
    await h.settle(sent.run_id);
    expect(seen).toEqual(['nbk_specs']);
    const m = await lastAssistant(t);
    const prov = m.provenance as { retrieval?: RetrievalTrace };
    expect(prov.retrieval?.notebook_id).toBeNull();
    expect(prov.retrieval?.hits).toHaveLength(1);
  });

  it('answers without links when they cannot be read', async () => {
    h = await harness({
      retriever: { search: async ({ notebookId }) => BY_NOTEBOOK[notebookId] ?? res([]) },
      links: {
        forTurn: async () => {
          throw new Error('links store down');
        },
      },
    });
    const t = await h.newThread({ notebook_id: 'nbk_pumps' });
    const sent = await h.send(t, 'How heavy is the P-300 pump?');
    await h.settle(sent.run_id);
    const m = await lastAssistant(t);
    expect(m.status).toBe('complete');
    expect((m.provenance as { links?: unknown }).links).toBeUndefined();
  });
});
