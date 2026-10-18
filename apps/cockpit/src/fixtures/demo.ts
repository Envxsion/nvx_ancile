/**
 * ------------------------------------------------------------------
 *  Title    |  DEMO fixtures
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A realistic workspace so the shell can be reviewed
 *           |  before the backend exists: a notebook about a depot
 *           |  battery retrofit, a branched thread with citations,
 *           |  claims, a fallback, and an approval waiting.
 *  How      |  lib/data.ts serves these only when the Core API is
 *           |  unreachable, and flips the status bar to "Demo data" so
 *           |  nobody mistakes them for their own.
 *  Note     |  Every source here is fictional (supplier datasheets,
 *           |  internal surveys); the figures are illustrative, not
 *           |  claims about real products.
 * ------------------------------------------------------------------
 */

import type { CredentialStatus, Explain, ModelWatchReport, ProviderInfo, WatchedModel } from '@nvx/contracts';
import { COCKPIT_VERSION } from '../lib/build';
import type {
  EvidenceView,
  LiveState,
  ModelView,
  NotebookView,
  PendingApproval,
  ServiceHealth,
  SourceView,
  ThreadSummary,
  ThreadView,
  TreeNodeView,
} from '../lib/types';

export const DEMO = true as const;

export const models: ModelView[] = [
  {
    id: 'anthropic/claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    provider: 'Anthropic',
    hue: 'azure',
    via: 'direct',
    contextWindow: 400_000,
    billing: { kind: 'key', payer: 'anthropic' },
    price: { in: 3, out: 15 },
  },
  {
    id: 'anthropic/claude-opus-5-5',
    name: 'Claude Opus 5.5',
    provider: 'Anthropic',
    hue: 'cyan',
    via: 'direct',
    contextWindow: 400_000,
    billing: { kind: 'key', payer: 'anthropic' },
    price: { in: 5, out: 25 },
  },
  {
    id: 'openai/gpt-5.5',
    name: 'GPT-5.5',
    provider: 'OpenAI',
    hue: 'jade',
    via: 'direct',
    contextWindow: 400_000,
    billing: { kind: 'key', payer: 'openai' },
    price: { in: 2, out: 10 },
  },
  {
    id: 'google/gemini-3-pro',
    name: 'Gemini 3 Pro',
    provider: 'Google',
    hue: 'magenta',
    via: 'direct',
    contextWindow: 1_000_000,
    billing: { kind: 'key', payer: 'google' },
    price: { in: 2, out: 12 },
  },
  {
    id: 'anthropic/claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    provider: 'Anthropic',
    hue: 'coral',
    via: 'direct',
    contextWindow: 200_000,
    billing: { kind: 'key', payer: 'anthropic' },
    price: { in: 1, out: 5 },
  },
  {
    id: 'controller/qwen3-72b',
    name: 'Qwen3 72B',
    provider: 'depot-gpu',
    hue: 'amber',
    via: 'controller',
    contextWindow: 128_000,
    billing: { kind: 'local', payer: null },
    note: 'Runs on your RunPod node',
  },
  {
    id: 'ollama/qwen3:14b',
    name: 'Qwen3 14B',
    provider: 'Ollama, this machine',
    hue: 'chalk',
    via: 'direct',
    contextWindow: 32_000,
    billing: { kind: 'local', payer: null },
  },
];

export const notebooks: NotebookView[] = [
  {
    id: 'nbk_01J9ZK0000000000000000DEPO',
    title: 'Kingsford depot retrofit',
    sources: 6,
    threads: 4,
    updatedAt: '2026-10-07T08:42:00Z',
  },
  {
    id: 'nbk_01J9ZK0000000000000000EVAL',
    title: 'Retrieval evaluation',
    sources: 14,
    threads: 3,
    updatedAt: '2026-10-05T16:10:00Z',
  },
  {
    id: 'nbk_01J9ZK0000000000000000PARS',
    title: 'Parser rewrite',
    sources: 3,
    threads: 2,
    updatedAt: '2026-09-29T11:03:00Z',
  },
];

/** The sample notebook every demo thread and source belongs to. */
const DEPOT = 'nbk_01J9ZK0000000000000000DEPO';

export const threads: ThreadSummary[] = [
  {
    id: 'thr_01J9ZK00000000000000000BUF',
    title: 'Sodium-ion or LFP for the depot buffer?',
    notebookId: DEPOT,
    updatedAt: '2026-10-07T08:42:00Z',
    branches: 3,
    live: true,
  },
  {
    id: 'thr_01J9ZK00000000000000000TAR',
    title: 'Tariff modelling: shoulder vs peak',
    notebookId: DEPOT,
    updatedAt: '2026-10-06T14:20:00Z',
    branches: 1,
  },
  {
    id: 'thr_01J9ZK00000000000000000DNO',
    title: 'Questions for the network operator',
    notebookId: DEPOT,
    updatedAt: '2026-10-04T09:55:00Z',
    branches: 2,
  },
  {
    id: 'thr_01J9ZK00000000000000000BRD',
    title: 'Board paper outline',
    notebookId: DEPOT,
    updatedAt: '2026-10-02T17:31:00Z',
    branches: 1,
  },
  {
    id: 'thr_01J9ZK00000000000000000RST',
    title: 'Lifetimes in the tokeniser rewrite',
    notebookId: null,
    updatedAt: '2026-10-01T21:12:00Z',
    branches: 1,
  },
  {
    id: 'thr_01J9ZK00000000000000000RDL',
    title: 'Reading list on retrieval evaluation',
    notebookId: null,
    updatedAt: '2026-09-28T10:00:00Z',
    branches: 1,
  },
];

export const sources: SourceView[] = [
  {
    id: 'src_na280',
    title: 'NA-280 sodium-ion module, datasheet rev 4',
    kind: 'file',
    status: 'ready',
    detail: 'PDF · 18 pages · 212 chunks',
    contextLevel: 'full',
    tags: ['supplier', 'sodium-ion'],
  },
  {
    id: 'src_lf305',
    title: 'LF-305 LFP module, datasheet rev 2',
    kind: 'file',
    status: 'ready',
    detail: 'PDF · 22 pages · 240 chunks',
    contextLevel: 'full',
    tags: ['supplier', 'lfp'],
  },
  {
    id: 'src_survey',
    title: 'Depot load survey, March 2026',
    kind: 'file',
    status: 'ready',
    detail: 'PDF · 52 pages · 611 chunks',
    contextLevel: 'insights',
    tags: ['site', 'load'],
  },
  {
    id: 'src_fe12',
    title: 'Fire engineering note FE-12',
    kind: 'file',
    status: 'ready',
    detail: 'DOCX · 9 pages · 74 chunks',
    contextLevel: 'full',
    tags: ['fire', 'compliance'],
  },
  {
    id: 'src_offer',
    title: 'Grid connection offer, revision C',
    kind: 'url',
    status: 'stale',
    detail: 'Changed upstream 2 days ago',
    contextLevel: 'insights',
    tags: ['grid'],
  },
  {
    id: 'src_tariff',
    title: 'Thread: Tariff modelling',
    kind: 'thread',
    status: 'embedding',
    detail: 'Embedding 96 of 140 chunks',
    contextLevel: 'off',
    tags: ['tariff'],
  },
];

export const thread: ThreadView = {
  id: threads[0]?.id ?? 'thr_demo',
  title: threads[0]?.title ?? 'Demo thread',
  notebookId: DEPOT,
  tldr: 'Comparing two quoted 2 MWh buffers for the 06:00 charging peak. LFP is cheaper to site; sodium-ion holds capacity better on cold mornings. Open question: container separation under FE-12.',
  messages: [
    {
      id: 'msg_u1',
      parentId: null,
      role: 'user',
      modelId: null,
      createdAt: '2026-10-07T08:30:00Z',
      blocks: [
        {
          kind: 'p',
          spans: [
            {
              text: "We need a 2 MWh buffer at Kingsford to shave the 06:00 charging peak. Compare the sodium-ion and LFP quotes we've had, and flag anything the fire engineer would object to.",
            },
          ],
        },
      ],
    },
    {
      id: 'msg_a1',
      parentId: 'msg_u1',
      role: 'assistant',
      modelId: 'openai/gpt-5.5',
      fallback: { from: 'anthropic/claude-sonnet-5-5', reason: 'timed out twice' },
      siblings: { index: 2, count: 3 },
      confidence: 0.74,
      usage: { tokens: 3_412, costUsd: 0.00872, ms: 6_400 },
      // A key answer with a search, a retry that worked and some cache (roadmap WY1).
      rawUsage: {
        input_tokens: 2_840,
        output_tokens: 572,
        cached_tokens: 1_600,
        cache_write_tokens: 400,
        cache_reported: true,
        cost_usd: 0.00872,
        billing: { kind: 'key', payer: 'openai' },
        rates: { input: 2, cached: 0.2, cache_write: 2.5, output: 10 },
        ms: 6_400,
        calls: [
          {
            model_id: 'openai/gpt-5.5',
            started_ms: 700,
            ms: 1_500,
            input_tokens: 1_000,
            cached_tokens: 0,
            cache_write_tokens: 400,
            output_tokens: 90,
            cost_usd: 0.0031,
            stop: 'tool_calls',
          },
          {
            model_id: 'openai/gpt-5.5',
            started_ms: 3_300,
            ms: 1_200,
            input_tokens: 900,
            cached_tokens: 700,
            cache_write_tokens: 0,
            output_tokens: 110,
            cost_usd: 0.00164,
            stop: 'tool_calls',
          },
          {
            model_id: 'openai/gpt-5.5',
            started_ms: 4_600,
            ms: 1_800,
            input_tokens: 940,
            cached_tokens: 900,
            cache_write_tokens: 0,
            output_tokens: 372,
            cost_usd: 0.00398,
            stop: 'end',
          },
        ],
      },
      provenance: {
        attempts: [{ model: 'anthropic/claude-sonnet-5-5', reason: 'transient', detail: 'timed out twice' }],
        recovered: [
          { what: 'tool', name: 'search_sources', attempts: 2, waited_ms: 1_200, reason: 'timeout' },
          { what: 'model', name: 'GPT-5.5', attempts: 2, waited_ms: 2_000, reason: 'rate_limited' },
        ],
      },
      createdAt: '2026-10-07T08:31:12Z',
      status: 'complete',
      blocks: [
        {
          kind: 'p',
          spans: [
            { text: 'Both quotes meet the 2 MWh requirement. Where they differ is where the risk sits.' },
          ],
        },
        {
          kind: 'ul',
          items: [
            [
              { text: 'Cold mornings. ', code: false },
              {
                text: 'The NA-280 keeps 88% of rated capacity at −10 °C, against 71% for the LF-305',
                claim: { id: 'clm_cold', verdict: 'verified' },
              },
              { text: '', cite: 1 },
              { text: '', cite: 2 },
              { text: '. That matters because the peak you are shaving is a winter one.' },
            ],
            [
              { text: 'Footprint. ' },
              {
                text: 'LFP fits in two 20 ft containers; sodium-ion needs three at its lower energy density',
                claim: { id: 'clm_footprint', verdict: 'verified' },
              },
              { text: '', cite: 1 },
              { text: '', cite: 2 },
              { text: '.' },
            ],
            [
              { text: 'Cycle life. ' },
              {
                text: 'At two cycles a day, the LF-305 would reach its 6,000-cycle rating in roughly eight years',
                claim: { id: 'clm_cycles', verdict: 'unverified' },
              },
              { text: '', cite: 3 },
              { text: ', so the warranty term needs checking against the 15-year business case.' },
            ],
            [
              { text: 'Fire. ' },
              {
                text: 'Both chemistries need the same 3 m separation between containers under FE-12',
                claim: { id: 'clm_fire', verdict: 'contradicted' },
              },
              { text: '', cite: 4 },
              { text: '.' },
            ],
          ],
        },
        {
          kind: 'p',
          spans: [
            {
              text: "On balance, LFP is cheaper to site and sodium-ion is the safer choice if winter peaks drive the case. I'd put the separation question to the fire engineer before deciding.",
            },
          ],
        },
      ],
      citations: [
        {
          marker: 1,
          sourceId: 'src_na280',
          title: 'NA-280 datasheet rev 4',
          quote: 'Usable capacity at −10 °C: 88% of rated (0.2C discharge).',
          location: 'p. 4',
        },
        {
          marker: 2,
          sourceId: 'src_lf305',
          title: 'LF-305 datasheet rev 2',
          quote: 'Capacity retention at −10 °C: 71%. Two units per 20 ft enclosure at 1.03 MWh each.',
          location: 'p. 3',
        },
        {
          marker: 3,
          sourceId: 'src_survey',
          title: 'Depot load survey, March 2026',
          quote: 'Proposed dispatch: one full cycle before 06:00 and a partial cycle at the 17:30 return.',
          location: 'p. 12',
        },
        {
          marker: 4,
          sourceId: 'src_fe12',
          title: 'Fire engineering note FE-12',
          quote:
            'LFP enclosures: minimum 3.0 m separation. Sodium-ion enclosures: 1.5 m, subject to the supplier test report.',
          location: '§3.2',
        },
      ],
    },
    {
      id: 'msg_u1p',
      parentId: 'msg_a1',
      role: 'user',
      modelId: null,
      createdAt: '2026-10-07T08:33:00Z',
      blocks: [
        {
          kind: 'p',
          spans: [{ text: 'Check the separation distances against FE-12 once more, on my Claude plan.' }],
        },
      ],
    },
    {
      id: 'msg_a1p',
      parentId: 'msg_u1p',
      role: 'assistant',
      modelId: 'claude-code/claude-opus-5-5',
      modelName: 'Claude Opus 5.5',
      usage: { tokens: 5_940, costUsd: 0.19, ms: 21_400 },
      // A plan answer: tokens only, with Claude Code's own estimate at API prices.
      rawUsage: {
        input_tokens: 5_200,
        output_tokens: 740,
        cached_tokens: 4_100,
        cache_write_tokens: 600,
        cache_reported: true,
        cost_usd: 0.19,
        billing: { kind: 'plan', payer: 'max' },
        ms: 21_400,
      },
      provenance: { route: { kind: 'model', from: 'thread' } },
      createdAt: '2026-10-07T08:33:40Z',
      status: 'complete',
      blocks: [
        {
          kind: 'p',
          spans: [
            {
              text: 'The 3.0 m separation for LFP enclosures holds. The sodium-ion figure of 1.5 m depends on the supplier test report, which is not in the notebook yet.',
            },
          ],
        },
      ],
    },
    {
      id: 'msg_u1l',
      parentId: 'msg_a1p',
      role: 'user',
      modelId: null,
      createdAt: '2026-10-07T08:36:10Z',
      blocks: [{ kind: 'p', spans: [{ text: 'Give me a one-line summary I can paste into chat.' }] }],
    },
    {
      id: 'msg_a1l',
      parentId: 'msg_u1l',
      role: 'assistant',
      modelId: 'ollama/qwen3:14b',
      usage: { tokens: 2_310, costUsd: 0, ms: 18_200 },
      // A local answer: tokens only, nothing to pay, and no cache figures reported.
      rawUsage: {
        input_tokens: 1_900,
        output_tokens: 410,
        cached_tokens: 0,
        cache_write_tokens: 0,
        cache_reported: false,
        cost_usd: 0,
        billing: { kind: 'local', payer: null },
        ms: 18_200,
      },
      provenance: { route: { kind: 'model', from: 'message' } },
      createdAt: '2026-10-07T08:36:30Z',
      status: 'complete',
      blocks: [
        {
          kind: 'p',
          spans: [
            {
              text: 'Both quotes fit the 2 MWh need; LFP is cheaper to site, sodium-ion is steadier in winter, and FE-12 separation is open.',
            },
          ],
        },
      ],
    },
    {
      id: 'msg_u2',
      parentId: 'msg_a1l',
      role: 'user',
      modelId: null,
      createdAt: '2026-10-07T08:40:02Z',
      blocks: [
        {
          kind: 'p',
          spans: [
            {
              text: 'Draft a one-page summary for the procurement board and save it in the notebook folder.',
            },
          ],
        },
      ],
    },
    {
      id: 'msg_a2',
      parentId: 'msg_u2',
      role: 'assistant',
      modelId: 'openai/gpt-5.5',
      createdAt: '2026-10-07T08:40:09Z',
      status: 'pending',
      blocks: [
        {
          kind: 'p',
          spans: [
            { text: 'The draft is ready. Saving it needs your go-ahead: ' },
            { text: 'board-summary.md', code: true },
            { text: ' in the Kingsford folder.' },
          ],
        },
      ],
    },
  ],
};

export const tree: TreeNodeView[] = [
  {
    id: 'msg_u1',
    parentId: null,
    role: 'user',
    preview: 'We need a 2 MWh buffer at Kingsford…',
    modelId: null,
    collapsed: 0,
    branch: null,
    active: true,
  },
  {
    id: 'msg_a1a',
    parentId: 'msg_u1',
    role: 'assistant',
    preview: 'Short answer: LFP, unless…',
    modelId: 'anthropic/claude-sonnet-5-5',
    collapsed: 0,
    branch: { name: 'First answer', hue: 'azure' },
    active: false,
  },
  {
    id: 'msg_a1',
    parentId: 'msg_u1',
    role: 'assistant',
    preview: 'Both quotes meet the 2 MWh requirement…',
    modelId: 'openai/gpt-5.5',
    collapsed: 0,
    branch: { name: 'Main', hue: 'jade' },
    active: true,
  },
  {
    id: 'msg_u2',
    parentId: 'msg_a1',
    role: 'user',
    preview: 'Draft a one-page summary for the board…',
    modelId: null,
    collapsed: 0,
    branch: null,
    active: true,
  },
  {
    id: 'msg_a2',
    parentId: 'msg_u2',
    role: 'assistant',
    preview: 'The draft is ready. Saving it needs…',
    modelId: 'openai/gpt-5.5',
    collapsed: 0,
    branch: null,
    active: true,
  },
  {
    id: 'msg_a1c',
    parentId: 'msg_u1',
    role: 'assistant',
    preview: 'If winter is the whole case…',
    modelId: 'anthropic/claude-opus-5-5',
    collapsed: 0,
    branch: { name: 'Winter-only case', hue: 'cyan' },
    active: false,
  },
  {
    id: 'msg_u1c',
    parentId: 'msg_a1c',
    role: 'user',
    preview: 'Model a 1.5 MWh sodium-ion option…',
    modelId: null,
    collapsed: 6,
    branch: null,
    active: false,
  },
];

export const evidence: EvidenceView[] = [
  {
    claimId: 'clm_fire',
    claim: 'Both chemistries need the same 3 m separation between containers under FE-12',
    verdict: 'contradicted',
    confidence: 0.12,
    support: [
      {
        source: 'Fire engineering note FE-12, §3.2',
        quote: 'LFP enclosures: minimum 3.0 m separation.',
        stance: 'supports',
      },
      {
        source: 'Fire engineering note FE-12, §3.2',
        quote: 'Sodium-ion enclosures: 1.5 m, subject to the supplier test report.',
        stance: 'contradicts',
      },
    ],
    rationale: 'FE-12 sets different distances by chemistry. The 3 m figure only applies to LFP.',
  },
  {
    claimId: 'clm_cycles',
    claim: 'At two cycles a day, the LF-305 would reach its 6,000-cycle rating in roughly eight years',
    verdict: 'unverified',
    confidence: 0.41,
    support: [
      {
        source: 'Depot load survey, p. 12',
        quote: 'One full cycle before 06:00 and a partial cycle at the 17:30 return.',
        stance: 'supports',
      },
    ],
    rationale:
      'The survey describes about 1.4 equivalent cycles a day, not two, and no source states the 6,000-cycle rating.',
  },
  {
    claimId: 'clm_cold',
    claim: 'The NA-280 keeps 88% of rated capacity at −10 °C, against 71% for the LF-305',
    verdict: 'verified',
    confidence: 0.93,
    support: [
      {
        source: 'NA-280 datasheet, p. 4',
        quote: 'Usable capacity at −10 °C: 88% of rated.',
        stance: 'supports',
      },
      { source: 'LF-305 datasheet, p. 3', quote: 'Capacity retention at −10 °C: 71%.', stance: 'supports' },
    ],
    rationale: 'Both figures appear verbatim in the supplier datasheets.',
  },
  {
    claimId: 'clm_footprint',
    claim: 'LFP fits in two 20 ft containers; sodium-ion needs three',
    verdict: 'verified',
    confidence: 0.86,
    support: [
      {
        source: 'LF-305 datasheet, p. 3',
        quote: 'Two units per 20 ft enclosure at 1.03 MWh each.',
        stance: 'supports',
      },
    ],
    rationale:
      'The LFP figure is stated; the sodium-ion count follows from the NA-280 enclosure rating on p. 6.',
  },
];

/**
 * What GET /messages/:id/explain would say for a demo answer, for the receipt:
 * the first answer drew on memory, sources and a search; the others are plain.
 */
export function demoExplain(m: { id: string; modelId: string | null }): Explain {
  const base: Explain = {
    message_id: m.id,
    thread_id: thread.id,
    status: 'complete',
    trace_id: '9c2a01d4b5e64f0c8e9d3b1a7f6e5d40',
    run_id: null,
    model: { id: m.modelId, name: null, requested: null, chain: m.modelId ? [m.modelId] : [] },
    attempts: [],
    memory: null,
    retrieval: null,
    retrieval_error: null,
    tools: [],
    compaction: null,
    usage: null,
    factcheck: null,
    error: null,
    recovered: [],
    flow: null,
    scope: null,
    links: [],
    origin: 'ancile',
    trace_url: '/admin/traces?trace=9c2a01d4b5e64f0c8e9d3b1a7f6e5d40',
  };
  if (m.id !== 'msg_a1') return base;
  return {
    ...base,
    attempts: [{ model: 'anthropic/claude-sonnet-5-5', reason: 'transient', detail: 'timed out twice' }],
    memory: {
      files: [
        {
          path: 'AGENTS.md',
          commit: '8c1f2e0',
          entries: ['Cite sources inline', 'Say when a figure is an estimate'],
          tokens: 184,
          dropped: 0,
        },
        {
          path: 'USER.md',
          commit: '8c1f2e0',
          entries: ['Use British spelling', 'Prefers a recommendation at the end'],
          tokens: 96,
          dropped: 0,
        },
        {
          path: 'PROJECTS/kingsford-depot.md',
          commit: 'b72d9a1',
          entries: ['Business case runs 15 years', 'Peak to shave is 06:00 winter charging'],
          tokens: 312,
          dropped: 0,
        },
      ],
      tokens: 592,
      truncated: 0,
    },
    retrieval: {
      query: 'sodium-ion and LFP quotes, cold-morning capacity, separation',
      notebook_id: DEPOT,
      mode: 'hybrid',
      embedder: 'local/bge-small',
      ms: 212,
      invalid_markers: 0,
      grounded: false,
      hits: [
        ['NA-280 datasheet', 4, 0.82, 0.94, true],
        ['LF-305 datasheet', 3, 0.8, 0.91, true],
        ['Fire engineering note FE-12', 2, 0.71, 0.88, true],
        ['Depot load survey', 12, 0.69, 0.77, true],
        ['Grid connection offer', 2, 0.58, 0.31, false],
      ].map(([title, page, score, rerank, cited], i) => ({
        marker: i + 1,
        kind: 'chunk' as const,
        chunk_id: `chk_demo_${i}`,
        source_id: `src_demo_${i}`,
        source_title: title as string,
        page: page as number,
        score: score as number,
        rerank_score: rerank as number,
        ranks: { vector: i + 1, text: i + 2 },
        cited: cited as boolean,
      })),
    },
    tools: [
      {
        call_id: 'call_demo_1',
        tool: 'search_sources',
        args: { query: 'separation distance' },
        ok: true,
        result: 'Found 5 passages',
        declined_reason: null,
        duration_ms: 1_100,
        decision: null,
      },
      {
        call_id: 'call_demo_2',
        tool: 'fs_write',
        args: { path: 'notes.md' },
        ok: true,
        result: 'Wrote notes.md',
        declined_reason: null,
        duration_ms: 240,
        decision: {
          outcome: 'approved',
          tier: 'gated',
          action: 'fs.write',
          resource: 'fs:/workspace/kingsford-depot/notes.md',
          at: '2026-10-07T08:31:08Z',
          rule: null,
          scope: null,
        },
      },
    ],
    recovered: [
      { what: 'tool', name: 'search_sources', attempts: 2, waited_ms: 1_200, reason: 'timeout' },
      { what: 'model', name: 'GPT-5.5', attempts: 2, waited_ms: 2_000, reason: 'rate_limited' },
    ],
  };
}

export const approval: PendingApproval = {
  id: 'apr_01J9ZK000000000000000000A1',
  tool: 'files.write',
  action: 'fs.write',
  resource: 'fs:/workspace/kingsford-depot/board-summary.md',
  tier: 'gated',
  argsPreview:
    '# Depot buffer: options for the procurement board\n\nTwo quotes meet the 2 MWh requirement…\n(1,840 characters)',
  suggestions: [
    'fs:/workspace/kingsford-depot/board-summary.md',
    'fs:/workspace/kingsford-depot/**',
    'fs:/workspace/**',
  ],
  reason: 'Save the board summary the user asked for.',
};

export const criticalApproval: PendingApproval = {
  id: 'apr_01J9ZK000000000000000000C1',
  tool: 'compute.node',
  action: 'compute.node.terminate',
  resource: 'compute:node/research-h100',
  tier: 'critical',
  argsPreview: 'Terminate research-h100 and release its 200 GB container disk.',
  suggestions: [],
  reason: 'The idle rule asked to remove a node unused for 30 days.',
};

export const health: ServiceHealth[] = [
  {
    service: 'Core',
    status: 'ok',
    latencyMs: 4,
    detail: `v${COCKPIT_VERSION} · uptime 3 h 12 min`,
    failures: 0,
  },
  { service: 'Postgres', status: 'ok', latencyMs: 2, detail: 'pgvector 0.8.1 · 38 MB', failures: 0 },
  { service: 'Knowledge', status: 'ok', latencyMs: 18, detail: 'Embedding 96 of 140 chunks', failures: 0 },
  { service: 'Controller', status: 'ok', latencyMs: 9, detail: '1 node running, 1 stopped', failures: 0 },
  {
    service: 'Anthropic',
    status: 'degraded',
    latencyMs: 1_240,
    detail: '2 timeouts in the last 5 minutes · circuit half-open',
    failures: 2,
  },
  { service: 'OpenAI', status: 'ok', latencyMs: 310, detail: 'Healthy', failures: 0 },
  {
    service: 'Ollama',
    status: 'down',
    latencyMs: null,
    detail: 'Nothing is listening on localhost:11434',
    failures: 3,
  },
];

export const live: LiveState = {
  modelId: 'anthropic/claude-sonnet-5-5',
  context: { ratio: 0.62, used: 248_000, window: 400_000 },
  node: { name: 'depot-gpu', state: 'running', rate: 0.44 },
  approvals: 1,
  health: 'degraded',
};

export const grants = [
  {
    id: 'gnt_1',
    action: 'fs.read',
    pattern: 'fs:/workspace/**',
    scope: 'Always',
    uses: 412,
    lastUsed: '3 min ago',
    expires: 'Never',
  },
  {
    id: 'gnt_2',
    action: 'http.get',
    pattern: 'http:https://api.github.com/**',
    scope: 'Notebook: Parser rewrite',
    uses: 38,
    lastUsed: 'yesterday',
    expires: 'In 6 days',
  },
  {
    id: 'gnt_3',
    action: 'mcp.github.create_issue',
    pattern: 'mcp:github/create_issue',
    scope: 'This thread',
    uses: 2,
    lastUsed: '2 days ago',
    expires: 'Never',
  },
  {
    id: 'gnt_4',
    action: 'shell.exec',
    pattern: 'shell:git status*',
    scope: 'Always',
    uses: 57,
    lastUsed: '1 h ago',
    expires: 'Never',
  },
];

export const nodes = [
  {
    id: 'nod_depot',
    name: 'depot-gpu',
    gpu: 'RTX A6000 48 GB',
    state: 'running' as const,
    rate: 0.44,
    hours: 61.5,
    storage: 4.0,
    model: 'Qwen3 72B (AWQ)',
  },
  {
    id: 'nod_h100',
    name: 'research-h100',
    gpu: 'H100 80 GB',
    state: 'stopped' as const,
    rate: 2.39,
    hours: 12.25,
    storage: 14.0,
    model: 'Llama 4 Maverick',
  },
];

export const operations = [
  {
    id: 'opn_1',
    title: 'Start depot-gpu',
    reached: 3,
    failed: false,
    timeline: ['08:02:11', '08:02:12', '08:02:14', '08:03:40'],
    detail: 'Pod running · vLLM answered /v1/models after 86 s',
  },
  {
    id: 'opn_2',
    title: 'Restart depot-gpu',
    reached: 2,
    failed: false,
    timeline: ['08:44:01', '08:44:02', '08:44:03'],
    detail: 'Pulling weights from the network volume · about 40 s left',
  },
  {
    id: 'opn_3',
    title: 'Start research-h100',
    reached: 1,
    failed: true,
    timeline: ['Yesterday 17:20:05', '17:20:06'],
    detail: 'There are no longer any instances available with the requested specifications.',
    suggestion:
      'No H100 capacity in EU-RO-1 right now. Try EU-SE-1, or start an A100 80 GB node with the same template.',
  },
];

export const memoryFiles = [
  { path: 'AGENTS.md', entries: 9, updated: '3 days ago', by: 'You' },
  { path: 'USER.md', entries: 14, updated: '12 min ago', by: 'NVX Ancile' },
  { path: 'PROJECTS/kingsford-depot.md', entries: 22, updated: 'today', by: 'NVX Ancile' },
  { path: 'PROJECTS/parser-rewrite.md', entries: 7, updated: 'last week', by: 'You' },
  { path: 'FAILURES/pdf-tables.md', entries: 3, updated: '2 weeks ago', by: 'NVX Ancile' },
  { path: 'MODELS/gpt-5.5.md', entries: 4, updated: 'yesterday', by: 'NVX Ancile' },
];

export const logs = [
  {
    at: '08:40:09.412',
    level: 'info',
    service: 'core',
    component: 'permissions',
    trace: '4bf92f3577b34da6a3ce929d0e0e4736',
    msg: 'approval requested · fs.write · gated',
  },
  {
    at: '08:31:12.008',
    level: 'info',
    service: 'core',
    component: 'gateway',
    trace: '0af7651916cd43dd8448eb211c80319c',
    msg: 'answered by openai/gpt-5.5 after fallback',
  },
  {
    at: '08:31:05.611',
    level: 'warn',
    service: 'core',
    component: 'gateway',
    trace: '0af7651916cd43dd8448eb211c80319c',
    msg: 'anthropic/claude-sonnet-5-5 timeout · attempt 2 of 2 · falling back',
  },
  {
    at: '08:30:35.600',
    level: 'warn',
    service: 'core',
    component: 'gateway',
    trace: '0af7651916cd43dd8448eb211c80319c',
    msg: 'anthropic/claude-sonnet-5-5 timeout · attempt 1 of 2',
  },
  {
    at: '08:30:35.201',
    level: 'info',
    service: 'knowledge',
    component: 'search',
    trace: '0af7651916cd43dd8448eb211c80319c',
    msg: 'hybrid search · 48 candidates · reranked to 8 · 64 ms',
  },
  {
    at: '08:30:35.118',
    level: 'debug',
    service: 'core',
    component: 'memory',
    trace: '0af7651916cd43dd8448eb211c80319c',
    msg: 'memory pack · 4 files · 633 tokens',
  },
  {
    at: '08:12:44.900',
    level: 'error',
    service: 'core',
    component: 'supervisor',
    trace: '9c2a01d4b5e64f0c8e9d3b1a7f6e5d40',
    msg: 'ollama unreachable · 3 consecutive failures · restart adapter is "none"',
  },
];

/* ---- Model updates (MD4, MD5) ---------------------------------------------- */

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const watched = (
  m: Pick<WatchedModel, 'id' | 'provider' | 'provider_model' | 'display_name' | 'line_id' | 'version'> &
    Partial<WatchedModel>,
): WatchedModel => ({
  preview: false,
  context_window: 400_000,
  max_output: 64_000,
  capabilities: ['tools', 'vision', 'json'],
  other_abilities: [],
  price: null,
  price_source: null,
  price_checked_at: null,
  lifecycle: 'active',
  retires_at: null,
  first_seen: hoursAgo(24 * 30),
  last_seen: hoursAgo(3),
  in_catalogue: true,
  ...m,
});

const checked = (provider: string, hours: number, models: number) => ({
  provider,
  checked_at: hoursAgo(hours),
  ok: true,
  error_code: null,
  error_title: null,
  unsupported: false,
  next_at: hoursAgo(hours - 24),
  models,
});

export const demoWatch: ModelWatchReport = {
  providers: [
    checked('anthropic', 3, 5),
    checked('openai', 5, 8),
    {
      provider: 'zai',
      checked_at: null,
      ok: false,
      error_code: null,
      error_title: null,
      unsupported: true,
      next_at: null,
      models: 0,
    },
  ],
  lines: [
    {
      id: 'anthropic/opus',
      provider: 'anthropic',
      name: 'Claude Opus',
      tier: 'best',
      latest_id: 'anthropic/claude-opus-5-6',
      current_id: 'anthropic/claude-opus-5-5',
      follow: false,
      previous_id: null,
      pending: { model_id: 'anthropic/claude-opus-5-6', state: 'offered', detail: null, at: hoursAgo(3) },
    },
    {
      id: 'anthropic/sonnet',
      provider: 'anthropic',
      name: 'Claude Sonnet',
      tier: 'balanced',
      latest_id: 'anthropic/claude-sonnet-5-5',
      current_id: 'anthropic/claude-sonnet-5-5',
      follow: true,
      previous_id: 'anthropic/claude-sonnet-5-4',
      pending: null,
    },
    {
      id: 'openai/gpt',
      provider: 'openai',
      name: 'GPT',
      tier: 'best',
      latest_id: 'openai/gpt-5.5',
      current_id: 'openai/gpt-5.5',
      follow: true,
      previous_id: null,
      pending: null,
    },
  ],
  models: [
    watched({
      id: 'anthropic/claude-opus-5-5',
      provider: 'anthropic',
      provider_model: 'claude-opus-5-5',
      display_name: 'Claude Opus 5.5',
      line_id: 'anthropic/opus',
      version: '5.5',
      price: { input_per_mtok: 5, output_per_mtok: 25 },
      price_source: 'provider',
      price_checked_at: hoursAgo(3),
    }),
    watched({
      id: 'anthropic/claude-opus-5-6',
      provider: 'anthropic',
      provider_model: 'claude-opus-5-6',
      display_name: 'Claude Opus 5.6',
      line_id: 'anthropic/opus',
      version: '5.6',
      capabilities: ['tools', 'vision', 'json', 'reasoning'],
      other_abilities: ['pdf_input'],
      price: { input_per_mtok: 5, output_per_mtok: 25 },
      price_source: 'provider',
      price_checked_at: hoursAgo(3),
      in_catalogue: false,
      first_seen: hoursAgo(3),
    }),
    watched({
      id: 'anthropic/claude-sonnet-5-5',
      provider: 'anthropic',
      provider_model: 'claude-sonnet-5-5',
      display_name: 'Claude Sonnet 5.5',
      line_id: 'anthropic/sonnet',
      version: '5.5',
      price: { input_per_mtok: 2, output_per_mtok: 10 },
      price_source: 'provider',
      price_checked_at: hoursAgo(3),
    }),
    watched({
      id: 'openai/gpt-5.5',
      provider: 'openai',
      provider_model: 'gpt-5.5',
      display_name: 'GPT-5.5',
      line_id: 'openai/gpt',
      version: '5.5',
      price: { input_per_mtok: 1.25, output_per_mtok: 10 },
      price_source: 'openrouter',
      price_checked_at: hoursAgo(5),
    }),
  ],
  changes: [
    {
      id: 'chg-new-opus',
      kind: 'new_model',
      model_id: 'anthropic/claude-opus-5-6',
      line_id: 'anthropic/opus',
      before: null,
      after: null,
      reason: null,
      at: hoursAgo(3),
      seen: false,
    },
    {
      id: 'chg-price-sonnet',
      kind: 'price',
      model_id: 'anthropic/claude-sonnet-5-5',
      line_id: 'anthropic/sonnet',
      before: { input_per_mtok: 3, output_per_mtok: 15 },
      after: { input_per_mtok: 2, output_per_mtok: 10 },
      reason: null,
      at: hoursAgo(3),
      seen: false,
    },
    {
      id: 'chg-pdf-opus',
      kind: 'unsupported_capability',
      model_id: 'anthropic/claude-opus-5-6',
      line_id: 'anthropic/opus',
      before: [],
      after: ['pdf_input'],
      reason: null,
      at: hoursAgo(3),
      seen: false,
    },
  ],
  bundled_prices_date: '2026-10-16',
  openrouter_prices: true,
};

/* ---- Providers and keys (PV1, PV3) ------------------------------------- */

const provider = (
  id: string,
  name: string,
  key_hint: string,
  docs_url: string,
  regions: { id: string; label: string }[] | null = null,
): ProviderInfo => ({
  id,
  name,
  regions,
  default_region: regions?.[0]?.id ?? null,
  key_hint,
  docs_url,
  has_models_list: true,
  credential_id: id as ProviderInfo['credential_id'],
  needs_key: true,
});

export const providers: ProviderInfo[] = [
  provider('anthropic', 'Anthropic', 'starts with sk-ant-', 'https://console.anthropic.com/settings/keys'),
  provider('openai', 'OpenAI', 'starts with sk-', 'https://platform.openai.com/api-keys'),
  provider('google', 'Google', 'starts with AIza', 'https://aistudio.google.com/apikey'),
  provider('openrouter', 'OpenRouter', 'starts with sk-or-v1-', 'https://openrouter.ai/keys'),
  provider('deepseek', 'DeepSeek', 'starts with sk-', 'https://platform.deepseek.com/api_keys'),
  provider('minimax', 'MiniMax', 'a long key; copy all of it', 'https://platform.minimax.io', [
    { id: 'global', label: 'Global (platform.minimax.io)' },
    { id: 'china', label: 'China (platform.minimax.cn)' },
  ]),
  provider('mistral', 'Mistral', 'a 32-character key with no prefix', 'https://console.mistral.ai/api-keys'),
  provider('moonshot', 'Moonshot (Kimi)', 'starts with sk-', 'https://platform.kimi.ai/console/api-keys', [
    { id: 'global', label: 'International (platform.kimi.ai)' },
    { id: 'china', label: 'China (platform.moonshot.cn)' },
  ]),
  provider(
    'qwen',
    'Qwen (Alibaba Model Studio)',
    'starts with sk-',
    'https://modelstudio.console.alibabacloud.com',
    [
      { id: 'singapore', label: 'Singapore / international' },
      { id: 'beijing', label: 'China (Beijing)' },
      { id: 'us', label: 'US (Virginia)' },
    ],
  ),
  provider('xai', 'xAI (Grok)', 'starts with xai-', 'https://console.x.ai'),
  provider(
    'zai',
    'Z.ai (GLM)',
    'two parts joined by a dot; copy all of it',
    'https://z.ai/manage-apikey/apikey-list',
    [
      { id: 'international', label: 'International (z.ai)' },
      { id: 'china', label: 'China (bigmodel.cn)' },
    ],
  ),
];

const status = (
  id: CredentialStatus['id'],
  env_var: string,
  rest: Partial<CredentialStatus> = {},
): CredentialStatus => ({
  id,
  set: false,
  last4: null,
  source: null,
  env_var,
  check: 'provider',
  available: true,
  unavailable_reason: null,
  ...rest,
});

/** Settings → API keys in demo mode: Moonshot saved in its China region, the rest not set. */
export const credentials: CredentialStatus[] = [
  status('anthropic', 'ANTHROPIC_API_KEY'),
  status('openai', 'OPENAI_API_KEY'),
  status('google', 'GOOGLE_API_KEY'),
  status('openrouter', 'OPENROUTER_API_KEY'),
  status('deepseek', 'DEEPSEEK_API_KEY'),
  status('moonshot', 'MOONSHOT_API_KEY', {
    set: true,
    source: 'saved',
    last4: 'c9d2',
    region: 'china',
    region_env_var: 'MOONSHOT_REGION',
  }),
  status('minimax', 'MINIMAX_API_KEY', { region: null, region_env_var: 'MINIMAX_REGION' }),
  status('zai', 'ZAI_API_KEY', { region: null, region_env_var: 'ZAI_REGION' }),
  status('qwen', 'DASHSCOPE_API_KEY', { region: null, region_env_var: 'DASHSCOPE_REGION' }),
  status('xai', 'XAI_API_KEY'),
  status('mistral', 'MISTRAL_API_KEY'),
];

/** What a failed check looked like, for a row in demo mode: DeepSeek's account has no credit. */
export const providerProblems: Record<string, { code: string; title: string; hint: string; detail: string }> =
  {
    deepseek: {
      code: 'provider.no_credit',
      title: 'DeepSeek says your account is out of credit',
      hint: 'Top up there, or use another model.',
      detail: 'Insufficient Balance',
    },
  };
