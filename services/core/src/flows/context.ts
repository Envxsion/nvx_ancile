/**
 * ------------------------------------------------------------------
 *  Title    |  Flow context
 *  Ref      |  DESIGN.md §16.2
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Decide exactly what one node is shown: which part of
 *           |  the conversation, which passages, which memory, and
 *           |  which earlier nodes' work, trimmed to a token budget.
 *  How      |  A policy comes from the edge that brought the work, else
 *           |  from a Context node just before it, else the default
 *           |  (whole branch, retrieved passages, memory pack, previous
 *           |  node's work). Trimming order: upstream work, sources,
 *           |  conversation (oldest first), memory.
 *  Note     |  The assembled payload is recorded for the editor's "last
 *           |  run" view and for estimate-context.
 * ------------------------------------------------------------------
 */

import { type ContextPolicy, FULL_CONTEXT } from '@nvx/contracts';
import type { ModelMessage } from '../gateway/types';
import { approxTokens } from '../memory/inject';

export interface Upstream {
  node: string;
  label: string;
  text: string;
}

export interface Payload {
  system: string;
  messages: ModelMessage[];
  tokens: {
    system: number;
    memory: number;
    sources: number;
    conversation: number;
    upstream: number;
    task: number;
  };
  /** What was cut to fit the budget, in words. */
  trimmed: string[];
}

export interface ContextSources {
  /** The conversation for a mode, oldest first, ending before the message being answered. */
  conversation(policy: ContextPolicy['conversation']): Promise<ModelMessage[]>;
  sources(policy: ContextPolicy['sources']): Promise<string>;
  memory(mode: ContextPolicy['memory']): Promise<string>;
}

export const DEFAULT_POLICY: ContextPolicy = FULL_CONTEXT;

const TEAM_NOTE =
  'You are one step in a team of models answering the user. Do your part well and plainly; another step may build on your output.';

function upstreamBlock(items: Upstream[]): string {
  if (!items.length) return '';
  return ['Work so far from the team:', ...items.map((u) => `### ${u.label}\n${u.text.trim()}`)].join('\n\n');
}

function cut(text: string, maxTokens: number): string {
  if (approxTokens(text) <= maxTokens) return text;
  const chars = Math.max(0, maxTokens * 4 - 20);
  return `${text.slice(0, chars).trimEnd()}… (shortened to fit)`;
}

/**
 * Build what a model node sees.
 * `task` is a manager's or loop's instruction for this call: it replaces the
 * user's message as the thing to do (with upstream 'plan', it is all it sees).
 */
export async function assemble(opts: {
  policy: ContextPolicy;
  role: string;
  input: string;
  upstream: Upstream[];
  task?: string;
  src: ContextSources;
}): Promise<Payload> {
  const p = opts.policy;
  const [memory, sources, conversation] = await Promise.all([
    p.memory === 'none' ? Promise.resolve('') : opts.src.memory(p.memory),
    p.sources.mode === 'none' ? Promise.resolve('') : opts.src.sources(p.sources),
    p.conversation.mode === 'none'
      ? Promise.resolve([] as ModelMessage[])
      : opts.src.conversation(p.conversation),
  ]);

  let up: Upstream[] = [];
  if (p.upstream === 'previous' || p.upstream === 'all') up = opts.upstream;
  else if (p.upstream === 'plan' && !opts.task) up = opts.upstream.slice(-1);

  let task: string;
  if (p.upstream === 'plan') task = opts.task ?? up[0]?.text ?? opts.input;
  else task = opts.task ? `${opts.task}\n\nThe user's message was:\n${opts.input}` : opts.input;
  if (p.upstream === 'plan') up = [];

  let upstreamText = upstreamBlock(up);
  let sourcesText = sources;
  let memoryText = memory;
  let convo = conversation;
  const trimmed: string[] = [];

  const total = () =>
    approxTokens(opts.role) +
    approxTokens(memoryText) +
    approxTokens(sourcesText) +
    convo.reduce((n, m) => n + approxTokens(m.content), 0) +
    approxTokens(upstreamText) +
    approxTokens(task);

  const budget = p.budget_tokens;
  if (budget && total() > budget) {
    const over = () => total() - budget;
    if (over() > 0 && upstreamText) {
      upstreamText = cut(upstreamText, Math.max(200, approxTokens(upstreamText) - over()));
      trimmed.push('earlier steps shortened');
    }
    if (over() > 0 && sourcesText) {
      sourcesText = cut(sourcesText, Math.max(0, approxTokens(sourcesText) - over()));
      trimmed.push('passages shortened');
    }
    while (over() > 0 && convo.length) {
      convo = convo.slice(1);
      if (!trimmed.includes('older turns dropped')) trimmed.push('older turns dropped');
    }
    if (over() > 0 && memoryText) {
      memoryText = cut(memoryText, Math.max(0, approxTokens(memoryText) - over()));
      trimmed.push('memory shortened');
    }
  }

  const system = [opts.role.trim() || TEAM_NOTE, memoryText, sourcesText].filter(Boolean).join('\n\n');
  const userTurn = [task, upstreamText].filter(Boolean).join('\n\n---\n\n');
  return {
    system,
    messages: [...convo, { role: 'user', content: userTurn }],
    tokens: {
      system: approxTokens(opts.role),
      memory: approxTokens(memoryText),
      sources: approxTokens(sourcesText),
      conversation: convo.reduce((n, m) => n + approxTokens(m.content), 0),
      upstream: approxTokens(upstreamText),
      task: approxTokens(task),
    },
    trimmed,
  };
}

/** A policy with every field present (an edge may give a partial one through defaults). */
export function policyOr(
  p: ContextPolicy | undefined,
  fallback: ContextPolicy = DEFAULT_POLICY,
): ContextPolicy {
  return p ?? fallback;
}
