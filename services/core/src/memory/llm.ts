/**
 * ------------------------------------------------------------------
 *  Title    |  Utility model calls with structured output
 *  Ref      |  DESIGN.md §6.3 (capture uses the `utility` task class)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Ask a cheap model a narrow question and get back a typed
 *           |  object, or nothing: capture must never fail a turn, so a
 *           |  bad answer is the same as no answer.
 *  How      |  Render a prompt file, stream it through the gateway on the
 *           |  `utility` chain (falling back to `chat.default` when no
 *           |  utility model is configured), take the outermost {...}
 *           |  of the reply and validate it with zod.
 *  Note     |  Every prompt ends "Return JSON matching <Name>." so the
 *           |  offline test model can recognise it (gateway/fake.ts).
 * ------------------------------------------------------------------
 */

import type { ModelConfig } from '@nvx/contracts';
import type { z } from 'zod';
import { loadPrompt, render } from '../conductor/prompt';
import type { Gateway } from '../gateway/gateway';
import type { ModelRegistry } from '../gateway/registry';
import { logFor } from '../obs/logger';

const log = logFor('memory');

export interface Utility {
  json<S extends z.ZodTypeAny>(
    prompt: { id: string; fallback: string; output: string },
    vars: Record<string, string | number | boolean | null | undefined>,
    schema: S,
  ): Promise<z.infer<S> | null>;
}

const SYSTEM =
  'You are a careful assistant that answers with a single JSON object and nothing else. No prose, no code fences.';

/** The outermost JSON object in a reply, tolerating fences and chatter around it. */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

export function utilityFrom(deps: {
  gateway: Gateway;
  registry: ModelRegistry;
  promptsDir: string;
  timeoutMs?: number;
}): Utility {
  const chain = (): ModelConfig[] => {
    for (const tc of ['utility', 'chat.default']) {
      try {
        const c = deps.registry.chain(tc, null);
        if (c.length) return c;
      } catch {
        /* try the next class */
      }
    }
    return [];
  };

  return {
    async json(prompt, vars, schema) {
      const models = chain();
      if (!models.length) return null;
      const template = await loadPrompt(deps.promptsDir, prompt.id, prompt.fallback);
      let content = render(template, vars);
      if (!content.includes(`Return JSON matching ${prompt.output}`))
        content += `\n\nReturn JSON matching ${prompt.output}.`;
      const signal = AbortSignal.timeout(deps.timeoutMs ?? 45_000);
      let text = '';
      try {
        for await (const ev of deps.gateway.stream(
          models,
          { system: SYSTEM, messages: [{ role: 'user', content }], temperature: 0, maxOutputTokens: 800 },
          signal,
        )) {
          if (ev.type === 'chunk' && ev.chunk.type === 'text') text += ev.chunk.delta;
        }
      } catch (err) {
        log.warn({ err, prompt: prompt.id }, 'a memory utility call failed');
        return null;
      }
      const parsed = schema.safeParse(extractJson(text));
      if (!parsed.success) {
        log.info({ prompt: prompt.id }, 'a memory utility call returned something unusable');
        return null;
      }
      return parsed.data;
    },
  };
}
