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
  CcEvent,
  Hue,
  MessageView,
  ModelView,
  NotebookView,
  PendingApproval,
  SourceView,
  SubagentView,
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
    hue: m.hue ?? hueFor(m.family),
    ...(m.hue && { chosenHue: m.hue }),
    via: m.via,
    contextWindow: m.context_window,
    status: m.status,
    offline: m.offline,
    chat: !m.capabilities.some((c) => c === 'embeddings' || c === 'rerank'),
    ...(m.offline && { note: "Doesn't use AI. For trying NVX Ancile before you add a model" }),
    ...(m.status === 'needs_key' && { note: 'Needs its API key' }),
    ...(m.status === 'not_pulled' && { note: 'Not in Ollama yet: pull it in Settings → Models' }),
    ...(m.custom && { custom: true, baseUrl: m.base_url ?? null, keyName: m.secret }),
    local: isLocalWire(m.provider, m.via, m.base_url ?? null),
    ...(m.provider === 'openrouter' && m.provider_model && { openrouter: m.provider_model }),
  };
}

const LOCAL_PROVIDERS = new Set(['ollama', 'local', 'fake', 'node']);
const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\]|::1)$/i;

/** The same test Core's engine selection makes (engines/select.ts): local providers, GPU nodes, loopback servers. */
export function isLocalWire(provider: string, via: string, baseUrl: string | null): boolean {
  if (LOCAL_PROVIDERS.has(provider) || via === 'controller') return true;
  if (!baseUrl) return false;
  try {
    return LOOPBACK.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
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
    ...(t.settings?.claude_code && { fromClaudeCode: true }),
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
  /** What its engine was given and why (docs/engines.md): recalled, digested, dropped, seeded. */
  engine_context?: import('@nvx/contracts').EngineContextReport;
  /**
   * Mirrored from a Claude Code session. `kind: 'compact_boundary'` marks where
   * Claude Code compacted; `subagent` carries a subagent's transcript (one or a
   * list) on the tool result it belongs to. Both are optional and loosely shaped.
   */
  claude_code?: {
    session_id?: string;
    uuid?: string;
    /** compact_boundary, compact_summary, command, notification, interrupted. */
    kind?: string;
    subagent?: unknown;
    command?: { name?: unknown; args?: unknown; output?: unknown };
    notification?: { source?: unknown; title?: unknown; from?: unknown; status?: unknown };
    /** Entries in this message this version cannot show yet (kept as written in Core). */
    unknown?: { count?: unknown; types?: unknown };
    /** Written by a live turn in NVX Ancile, not brought in from the terminal. */
    live?: unknown;
  };
}

/** How many entries of a Claude Code message this version cannot show yet (0 when none). */
export function unknownCount(p: Provenance | undefined): number {
  const n = p?.claude_code?.unknown?.count;
  return typeof n === 'number' && n > 0 ? Math.floor(n) : 0;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Whatever shape a subagent transcript arrives in, as turns to read; nothing when absent. */
export function subagentsOf(raw: unknown): SubagentView[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.flatMap((item): SubagentView[] => {
    if (!item || typeof item !== 'object') return [];
    const o = item as Record<string, unknown>;
    const msgs = Array.isArray(o.messages) ? o.messages : Array.isArray(o.transcript) ? o.transcript : [];
    const turns = msgs.flatMap((m): SubagentView['turns'] => {
      if (!m || typeof m !== 'object') return [];
      const r = m as { role?: unknown; text?: unknown; parts?: unknown };
      const text =
        str(r.text) ??
        (Array.isArray(r.parts)
          ? partsText(r.parts.filter((p): p is Part => !!p && typeof p === 'object'))
          : '');
      if (!text.trim()) return [];
      return [{ role: r.role === 'user' ? 'user' : 'assistant', text }];
    });
    return [
      {
        callId: str(o.call_id) ?? str(o.tool_use_id),
        title: str(o.title) ?? str(o.description) ?? str(o.agent_type) ?? str(o.agent),
        turns,
      },
    ];
  });
}

/** Terminal colour codes that ride along in a command's output. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape character is the point
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const tagText = (text: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m ? (m[1] as string).trim() : null;
};
const NOTICE_SOURCES = new Set(['task', 'session', 'agent', 'system']);

/**
 * A Claude Code turn that is not a conversation bubble: what Core marked
 * (provenance kind), or, for sessions brought in before Core marked them,
 * what the text itself says (a slash command, "[Request interrupted by user]").
 * Nothing for an ordinary prompt or answer.
 */
export function ccEventOf(m: Message): CcEvent | null {
  const cc = (m.provenance as Provenance).claude_code;
  if (!cc) return null;
  const text = partsText(m.parts).trim();
  switch (cc.kind) {
    case 'compact_boundary':
      return { kind: 'compact_boundary', summary: text || null };
    case 'compact_summary':
      return { kind: 'compact_summary', summary: text };
    case 'command': {
      const c = cc.command ?? {};
      return {
        kind: 'command',
        name: str(c.name) ?? tagText(text, 'command-name'),
        args: str(c.args) ?? tagText(text, 'command-args'),
        output: (str(c.output) ?? tagText(text, 'local-command-stdout'))?.replace(ANSI, '') || null,
      };
    }
    case 'notification': {
      const n = cc.notification ?? {};
      const source = str(n.source);
      return {
        kind: 'notification',
        source: source && NOTICE_SOURCES.has(source) ? (source as 'task') : 'system',
        title: str(n.title) ?? 'Notification',
        from: str(n.from),
        status: str(n.status),
        body: text,
      };
    }
    case 'interrupted':
      return { kind: 'interrupted' };
    case 'unknown':
      return { kind: 'unknown', count: Math.max(1, unknownCount(m.provenance as Provenance)) };
  }
  if (m.role !== 'user') return null;
  if (/^\[Request interrupted by user[^\]]*\]$/.test(text)) return { kind: 'interrupted' };
  const name = tagText(text, 'command-name');
  const stdout = tagText(text, 'local-command-stdout');
  if (name || (stdout !== null && text.startsWith('<local-command-stdout>')))
    return {
      kind: 'command',
      name,
      args: tagText(text, 'command-args') || null,
      output: stdout?.replace(ANSI, '') || null,
    };
  return null;
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
  const cc = ccEventOf(m);
  // System turns are drawn only when Claude Code's mirror says what they are.
  if (m.role !== 'user' && m.role !== 'assistant' && !cc) return null;
  const prov = m.provenance as Provenance;
  const attempts = prov.attempts ?? [];
  const first = attempts[0];
  const subagents = subagentsOf(prov.claude_code?.subagent);
  return {
    ...(cc?.kind === 'compact_boundary' && { compactBoundary: true }),
    ...(cc && { cc }),
    ...(subagents.length > 0 && { subagents }),
    id: m.id,
    parentId: m.parent_id,
    role: m.role === 'user' ? 'user' : 'assistant',
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
    ...(prov.error && { error: { title: prov.error.title, hint: prov.error.hint, code: prov.error.code } }),
    ...(prov.lab &&
      m.run_id && {
        lab: { runId: m.run_id, undone: !!prov.lab_undone_at },
        modelName: prov.model_name ?? 'The lab',
      }),
  };
}

/**
 * Messages to draw. A message that is nothing but tool results (Claude Code
 * keeps them in the next turn, some providers in a `tool` message) joins the
 * answer that made the calls, so each step shows how it went. A user message
 * like that stays in the list, folded, so the branch still ends where it ends.
 */
export function toMessageViews(messages: Message[]): MessageView[] {
  const out: MessageView[] = [];
  // A thread other models answer too: Claude Code's own compaction is a folded terminal entry,
  // since NVX Ancile's summary is the record there (docs/engines.md).
  const mixed = isMixedThread(messages);
  for (const m of messages) {
    const onlyResults = m.parts.length > 0 && m.parts.every((p) => p.type === 'tool_result');
    if (m.role === 'tool' || (m.role === 'user' && onlyResults)) {
      const host = out.findLast((v) => v.role === 'assistant' && !v.folded && !v.cc);
      const subagents = subagentsOf((m.provenance as Provenance).claude_code?.subagent);
      if (host) {
        host.parts = [...(host.parts ?? []), ...m.parts.filter((p) => p.type === 'tool_result')];
        if (subagents.length) host.subagents = [...(host.subagents ?? []), ...subagents];
      }
      const v = m.role === 'user' ? toMessageView(m) : null;
      if (v) out.push({ ...v, parts: [], subagents: undefined, folded: true });
      continue;
    }
    const v = toMessageView(m);
    if (v?.cc && mixed && (v.cc.kind === 'compact_boundary' || v.cc.kind === 'compact_summary'))
      v.cc = { ...v.cc, terminal: true };
    if (v) out.push(v);
  }
  return out;
}

/** Does the thread hold answers by another model besides Claude Code's own? */
export function isMixedThread(messages: Pick<Message, 'role' | 'provenance'>[]): boolean {
  let cc = false;
  let other = false;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    if ((m.provenance as Provenance | undefined)?.claude_code) cc = true;
    else other = true;
    if (cc && other) return true;
  }
  return false;
}

export function toThreadView(p: ThreadPath): ThreadView {
  return {
    id: p.thread.id,
    title: p.thread.title,
    notebookId: p.thread.notebook_id,
    model: p.thread.settings.model ?? null,
    messages: toMessageViews(p.messages),
    activeRun: p.active_run ? { id: p.active_run.id, messageId: p.active_run.message_id } : null,
    claudeCode: p.thread.settings.claude_code ?? null,
    headId: p.head_id,
    total: p.total ?? p.messages.length,
    cursor: p.messages[0]?.id ?? null,
    hasMore: p.has_more ?? false,
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
    ...(a.args_editable && { args: a.args, argsEditable: true }),
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
