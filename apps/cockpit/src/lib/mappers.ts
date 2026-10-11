/**
 * ------------------------------------------------------------------
 *  Title    |  Wire → view
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Core speaks the contract shapes (snake_case, parts);
 *           |  screens render view types. Every translation lives
 *           |  here so a contract change is one file to follow.
 * ------------------------------------------------------------------
 */

import type {
  AnswerRoute,
  Approval,
  FlowProvenance,
  Message,
  ModelInfo,
  Notebook,
  Part,
  RetrievalTrace,
  Source,
  ThreadPath,
  ThreadSummary as WireThreadSummary,
} from '@nvx/contracts';
import type {
  Hue,
  MessageView,
  ModelView,
  NotebookView,
  PendingApproval,
  SourceView,
  ThreadSummary,
  ThreadView,
} from './types';

/** The identity ramp minus violet, which sits beside the signal. */
const HUES: Hue[] = ['azure', 'coral', 'jade', 'amber', 'cyan', 'magenta'];
const FAMILY_HUE: Record<string, Hue> = {
  anthropic: 'azure',
  openai: 'jade',
  google: 'amber',
  qwen: 'cyan',
  meta: 'coral',
  mistral: 'magenta',
};

export function hueFor(family: string): Hue {
  if (family.startsWith('offline')) return 'chalk';
  const known = FAMILY_HUE[family];
  if (known) return known;
  let h = 0;
  for (const c of family) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length] as Hue;
}

const PROVIDER_NAME: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  controller: 'Your compute',
  node: 'Your GPU node',
  fake: 'Try-out',
  local: 'On this computer',
  'openai-compatible': 'Your server',
};

/**
 * The try-out models (built in, no AI) step out of the switcher and pickers
 * once a real model can answer, unless "Show try-out models" is on.
 */
export function hideTryout<T extends { offline?: boolean; status?: string | undefined; chat?: boolean }>(
  models: T[],
  keep: boolean,
): T[] {
  if (keep) return models;
  const real = models.some(
    (m) => !m.offline && m.chat !== false && (m.status === undefined || m.status === 'ready'),
  );
  return real ? models.filter((m) => !m.offline) : models;
}

export function toModelView(m: ModelInfo): ModelView {
  return {
    id: m.id,
    name: m.display_name,
    provider: PROVIDER_NAME[m.provider] ?? (m.provider.startsWith('endpoint-') ? 'Your server' : m.provider),
    hue: hueFor(m.family),
    via: m.via,
    contextWindow: m.context_window,
    status: m.status,
    offline: m.offline,
    chat: !m.capabilities.some((c) => c === 'embeddings' || c === 'rerank'),
    ...(m.offline && { note: "Doesn't use AI. For trying NVX Ancile before you add a model" }),
    ...(m.status === 'needs_key' && { note: 'Needs its API key' }),
    ...(m.custom && { custom: true, baseUrl: m.base_url ?? null }),
  };
}

export function toThreadSummary(t: WireThreadSummary): ThreadSummary {
  return {
    id: t.id,
    title: t.title,
    notebookId: t.notebook_id,
    updatedAt: t.updated_at,
    branches: t.branches,
    live: t.live,
    pinned: !!t.pinned_at,
    archived: !!t.archived_at,
  };
}

export function toNotebookView(n: Notebook): NotebookView {
  return {
    id: n.id,
    title: n.title,
    description: n.description,
    icon: n.icon,
    color: n.color,
    pinned: n.pinned,
    archived: !!n.archived_at,
    grounded: n.grounded,
    sources: n.counts.sources,
    threads: n.counts.threads,
    notes: n.counts.notes,
    updatedAt: n.updated_at,
  };
}

const STAGE_WORDS: Record<string, string> = {
  queued: 'Waiting to start',
  extracting: 'Reading',
  enriching: 'Cutting into passages',
  embedding: 'Indexing',
};

function sourceDetail(s: Source): string {
  if (s.status === 'failed') return s.error?.title ?? 'Could not be added';
  if (s.status !== 'ready') return s.progress?.message || STAGE_WORDS[s.status] || 'Working';
  if (s.stale) return 'Changed since it was fetched';
  const bits: string[] = [];
  if (s.pages) bits.push(`${s.pages} ${s.pages === 1 ? 'page' : 'pages'}`);
  bits.push(`${s.chunks.toLocaleString('en-GB')} ${s.chunks === 1 ? 'passage' : 'passages'}`);
  return bits.join(' · ');
}

export function toSourceView(s: Source): SourceView {
  const p = s.progress;
  return {
    id: s.id,
    title: s.title,
    kind: s.kind,
    status: s.status === 'ready' && s.stale ? 'stale' : s.status,
    detail: sourceDetail(s),
    contextLevel: s.context_level ?? 'full',
    tags: s.tags,
    uri: s.uri,
    mime: s.mime,
    bytes: s.bytes,
    summary: s.summary,
    chunks: s.chunks,
    pages: s.pages,
    progress: p?.total ? Math.min(1, (p.done ?? 0) / p.total) : null,
    error: s.error ? { title: s.error.title, hint: s.error.hint } : null,
    duplicateOf: s.duplicate_of
      ? { sourceId: s.duplicate_of.source_id, title: s.duplicate_of.title, kind: s.duplicate_of.kind }
      : null,
    createdAt: s.created_at,
  };
}

export interface Provenance {
  model_name?: string | null;
  lab?: { session_id: string };
  lab_undone_at?: string;
  chain?: string[];
  attempts?: { model: string; reason: string; detail?: string }[];
  error?: { code: string; title: string; hint: string };
  retrieval?: RetrievalTrace;
  retrieval_error?: { code: string; title: string };
  /** The latest fact-check of this answer, in short (Core notes it here). */
  factcheck?: {
    id: string;
    status: 'running' | 'done' | 'failed';
    confidence?: number | null;
    sealed?: boolean;
  };
  compaction?: {
    summary_id: string;
    upto_message_id: string;
    tokens_before: number;
    tokens_after: number;
    auto?: boolean;
  };
  merged_from?:
    | { thread_id: string; message_id: string; side?: 'shared' | 'a' | 'b' }
    | { thread_id: string; message_id: string; side?: 'shared' | 'a' | 'b' }[];
  synthesized?: boolean;
  /** Flows (DESIGN §16): which flow answered, the path, decisions and every step. */
  flow?: FlowProvenance;
  /** How the answer was routed and why (DESIGN §16.3): a flow or one model, and who chose it. */
  route?: AnswerRoute;
}

const REASON_WORDS: Record<string, string> = {
  transient: 'was unavailable',
  capacity: 'was over capacity',
  refusal: 'declined',
  context_overflow: 'ran out of context',
  policy: 'was blocked by a policy',
  permanent: 'failed',
  bug: 'failed',
};

/** An error class as words; anything else is already a phrase. */
export const reasonWords = (reason: string) => REASON_WORDS[reason] ?? reason;

export function toMessageView(m: Message): MessageView | null {
  if (m.role !== 'user' && m.role !== 'assistant') return null;
  const prov = m.provenance as Provenance;
  const attempts = prov.attempts ?? [];
  const first = attempts[0];
  return {
    id: m.id,
    parentId: m.parent_id,
    role: m.role,
    blocks: [],
    parts: m.parts,
    modelId: m.model_id,
    ...(first &&
      m.model_id &&
      first.model !== m.model_id && { fallback: { from: first.model, reason: first.reason } }),
    ...(m.siblings &&
      m.siblings.count > 1 && {
        siblings: {
          index: m.siblings.index + 1,
          count: m.siblings.count,
          ...(m.siblings.ids && { ids: m.siblings.ids }),
        },
      }),
    ...(m.usage && {
      usage: { tokens: m.usage.input_tokens + m.usage.output_tokens, costUsd: m.usage.cost_usd },
    }),
    createdAt: m.created_at,
    provenance: prov,
    status: m.status === 'pending' || m.status === 'streaming' ? 'streaming' : m.status,
    runId: m.run_id,
    ...(prov.error && { error: { title: prov.error.title, hint: prov.error.hint } }),
    ...(prov.lab &&
      m.run_id && {
        lab: { runId: m.run_id, undone: !!prov.lab_undone_at },
        modelName: prov.model_name ?? 'The lab',
      }),
  };
}

export function toThreadView(p: ThreadPath): ThreadView {
  return {
    id: p.thread.id,
    title: p.thread.title,
    notebookId: p.thread.notebook_id,
    model: p.thread.settings.model ?? null,
    messages: p.messages.flatMap((m) => toMessageView(m) ?? []),
    activeRun: p.active_run ? { id: p.active_run.id, messageId: p.active_run.message_id } : null,
  };
}

const ACTION_WORDS: Record<string, string> = {
  'fs.read': 'read',
  'fs.list': 'list the folder',
  'fs.write': 'write to',
  'fs.delete': 'delete',
  'http.get': 'fetch',
  'http.post': 'send data to',
  'shell.exec': 'run',
};

/** "fs:/workspace/notes/a.md" → "notes/a.md", for sentences. */
export function shortResource(resource: string): string {
  return resource.replace(/^fs:\/workspace\/?/, '').replace(/^(http|shell):/, '') || 'the workspace';
}

/**
 * A tool's arguments as a person reads them: one line per field, and text
 * with line breaks shown as the lines it will write (not "\n" escapes).
 */
export function argsText(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return JSON.stringify(args, null, 2);
  return Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => {
      if (typeof v === 'string' && v.includes('\n'))
        return `${k}:\n${v
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n')}`;
      return `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`;
    })
    .join('\n');
}

export function toPendingApproval(a: Approval): PendingApproval {
  const verb = ACTION_WORDS[a.action] ?? `use ${a.tool} on`;
  return {
    id: a.id,
    runId: a.run_id,
    threadId: a.thread_id,
    tool: a.tool,
    action: a.action,
    resource: a.resource,
    tier: a.tier,
    argsPreview: typeof a.args_preview === 'string' ? a.args_preview : argsText(a.args_preview),
    suggestions: a.suggestions,
    reason:
      a.tier === 'critical'
        ? `The agent wants to ${verb} ${shortResource(a.resource)}. This can't be undone, so NVX Ancile asks every time.`
        : `The agent wants to ${verb} ${shortResource(a.resource)}.`,
  };
}

/** Plain text of parts, for copy and previews. */
export function partsText(parts: Part[] | undefined): string {
  return (parts ?? []).flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
}
