/**
 * ------------------------------------------------------------------
 *  Title    |  Utility calls
 *  Ref      |  DESIGN.md §8.3–8.5, prompts/threads/*
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The small model jobs around a thread: compaction
 *           |  summaries, "how these branches differ", topic shifts,
 *           |  merge synthesis. One way to run a prompt file through
 *           |  the gateway on the `utility` task class and get text or
 *           |  JSON back.
 *  How      |  The prompt file is rendered and sent as the user turn.
 *           |  The system line names the task (`Ancile task: <id>`),
 *           |  which is how the offline test model knows what to do.
 *           |  JSON is read leniently (the first {...} in the reply)
 *           |  and validated by the caller's schema; a reply that does
 *           |  not parse is null, never an exception, so callers can
 *           |  fall back to something computed.
 * ------------------------------------------------------------------
 */

import type { z } from 'zod';
import { loadPrompt, render } from '../conductor/prompt';
import type { Gateway } from '../gateway/gateway';
import { TASK_LINE } from '../gateway/offline-utility';
import type { ModelRegistry } from '../gateway/registry';

export interface UtilityDeps {
  gateway: Gateway;
  registry: ModelRegistry;
  promptsDir: string;
}

export interface UtilityResult {
  text: string;
  modelId: string | null;
  usage: { input: number; output: number };
}

export async function runUtility(
  deps: UtilityDeps,
  opts: {
    promptId: string;
    fallback: string;
    vars: Record<string, string | number | null | undefined>;
    signal?: AbortSignal;
    maxOutputTokens?: number;
  },
): Promise<UtilityResult | null> {
  const chain = deps.registry.chain('utility');
  if (!chain.length) return null;
  const template = await loadPrompt(deps.promptsDir, opts.promptId, opts.fallback);
  const prompt = render(template, opts.vars);
  const signal = opts.signal ?? AbortSignal.timeout(90_000);
  let text = '';
  let modelId: string | null = null;
  const usage = { input: 0, output: 0 };
  for await (const ev of deps.gateway.stream(
    chain,
    {
      system: `${TASK_LINE} ${opts.promptId}. Follow the instructions in the user message exactly.`,
      messages: [{ role: 'user', content: prompt }],
      ...(opts.maxOutputTokens && { maxOutputTokens: opts.maxOutputTokens }),
      temperature: 0.2,
    },
    signal,
  )) {
    if (ev.type === 'model') modelId = ev.modelId;
    else if (ev.type === 'chunk') {
      if (ev.chunk.type === 'text') text += ev.chunk.delta;
      else if (ev.chunk.type === 'finish') {
        usage.input += ev.chunk.usage.inputTokens;
        usage.output += ev.chunk.usage.outputTokens;
      }
    }
  }
  return { text: text.trim(), modelId, usage };
}

/** The first JSON object in a reply (models wrap JSON in prose or fences). */
export function readJson<T>(text: string, schema: z.ZodType<T>): T | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
