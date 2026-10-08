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

import type {
  EvidenceView,
  ExplainView,
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
  },
  {
    id: 'anthropic/claude-opus-5-5',
    name: 'Claude Opus 5.5',
    provider: 'Anthropic',
    hue: 'cyan',
    via: 'direct',
    contextWindow: 400_000,
  },
  {
    id: 'openai/gpt-5.5',
    name: 'GPT-5.5',
    provider: 'OpenAI',
    hue: 'jade',
    via: 'direct',
    contextWindow: 400_000,
  },
  {
    id: 'google/gemini-3-pro',
    name: 'Gemini 3 Pro',
    provider: 'Google',
    hue: 'magenta',
    via: 'direct',
    contextWindow: 1_000_000,
  },
  {
    id: 'anthropic/claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    provider: 'Anthropic',
    hue: 'coral',
    via: 'direct',
    contextWindow: 200_000,
  },
  {
    id: 'controller/qwen3-72b',
    name: 'Qwen3 72B',
    provider: 'depot-gpu',
    hue: 'amber',
    via: 'controller',
    contextWindow: 128_000,
    note: 'Runs on your RunPod node',
  },
  {
    id: 'ollama/qwen3:14b',
    name: 'Qwen3 14B',
    provider: 'Ollama, this machine',
    hue: 'chalk',
    via: 'direct',
    contextWindow: 32_000,
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
      usage: { tokens: 3_412, costUsd: 0.031, ms: 6_400 },
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
      id: 'msg_u2',
      parentId: 'msg_a1',
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

export const explain: ExplainView = {
  answered: 'openai/gpt-5.5',
  requested: 'anthropic/claude-sonnet-5-5',
  attempts: [
    {
      model: 'anthropic/claude-sonnet-5-5',
      outcome: 'timeout',
      reason: 'No first token after 30 s',
      ms: 30_000,
    },
    {
      model: 'anthropic/claude-sonnet-5-5',
      outcome: 'timeout',
      reason: 'Retry, no first token after 30 s',
      ms: 30_000,
    },
    { model: 'openai/gpt-5.5', outcome: 'answered', reason: null, ms: 6_400 },
  ],
  memory: [
    {
      path: 'AGENTS.md',
      commit: '8c1f2e0',
      entries: ['Cite sources inline', 'Say when a figure is an estimate'],
      tokens: 184,
    },
    {
      path: 'USER.md',
      commit: '8c1f2e0',
      entries: ['Use British spelling', 'Prefers a recommendation at the end'],
      tokens: 96,
    },
    {
      path: 'PROJECTS/kingsford-depot.md',
      commit: 'b72d9a1',
      entries: ['Business case runs 15 years', 'Peak to shave is 06:00 winter charging'],
      tokens: 312,
    },
    {
      path: 'MODELS/gpt-5.5.md',
      commit: '4e0aa13',
      entries: ['Keep lists to five items or fewer'],
      tokens: 41,
    },
  ],
  retrieval: [
    { title: 'NA-280 datasheet · p. 4', score: 0.82, rerank: 0.94, cited: true },
    { title: 'LF-305 datasheet · p. 3', score: 0.8, rerank: 0.91, cited: true },
    { title: 'Fire engineering note FE-12 · §3.2', score: 0.71, rerank: 0.88, cited: true },
    { title: 'Depot load survey · p. 12', score: 0.69, rerank: 0.77, cited: true },
    { title: 'Grid connection offer · §2', score: 0.58, rerank: 0.31, cited: false },
  ],
  tools: [],
  usage: { input: 2_840, output: 572, costUsd: 0.031 },
};

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
  { service: 'Core', status: 'ok', latencyMs: 4, detail: 'v0.1.0 · uptime 3 h 12 min', failures: 0 },
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
