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
 *           |  of the reply and validate it with zod. A reply that
 *           |  cannot be read gets one repair retry that says which
 *           |  fields were wrong. The caller can ask for an outcome:
 *           |  why nothing came back, and what the call cost.
 *  Note     |  Every prompt ends "Return JSON matching <Name>." so the
 *           |  offline test model can recognise it (gateway/fake.ts).
 *           |  The gateway has no provider-side structured output yet,
 *           |  so JSON is asked for in the prompt and checked here.
 *           |  TODO(phase-5): use a provider's JSON mode where it exists.
 * ------------------------------------------------------------------
 */

import type { ModelConfig } from '@nvx/contracts';
import type { z } from 'zod';
import { loadPrompt, render } from '../conductor/prompt';
import { isLocalModel } from '../engines/select';
import type { Gateway } from '../gateway/gateway';
import type { ModelRegistry } from '../gateway/registry';
import { logFor } from '../obs/logger';

const log = logFor('memory');

/** What one utility call came to, for a caller that wants to say why nothing happened. */
export interface UtilityOutcome {
  ok: boolean;
  /** Why not, in words a note can use. Never any of the content. */
  reason?: string;
  /** The model that answered last. */
  modelId?: string;
  /** Tokens over every attempt (the repair retry included). */
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface Utility {
  json<S extends z.ZodTypeAny>(
    prompt: { id: string; fallback: string; output: string },
    vars: Record<string, string | number | boolean | null | undefined>,
    schema: S,
    opts?: {
      maxOutputTokens?: number;
      /**
       * Task classes to try first, cheapest wanted first (for example `memory.detector`, then
       * `utility`). Absent: `utility`, then `chat.default`. A class that does not exist is skipped.
       */
      taskClasses?: string[];
      /** Use only a model on this machine or the person's own node (a private notebook). */
      localOnly?: boolean;
      /** Called once with what the call came to, answer or not. */
      outcome?: (o: UtilityOutcome) => void;
    },
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
  const chain = (classes?: string[], localOnly?: boolean): ModelConfig[] => {
    for (const tc of [...(classes ?? []), 'utility', 'chat.default']) {
      try {
        const c = deps.registry.chain(tc, null);
        const usable = localOnly ? c.filter((m) => isLocalModel(m)) : c;
        if (usable.length) return usable;
      } catch {
        /* try the next class */
      }
    }
    return [];
  };

  return {
    async json(prompt, vars, schema, opts) {
      const out: UtilityOutcome = { ok: false, inputTokens: 0, outputTokens: 0 };
      const done = (extra: Partial<UtilityOutcome>) => opts?.outcome?.({ ...out, ...extra });
      const models = chain(opts?.taskClasses, opts?.localOnly);
      if (!models.length) {
        done({ reason: 'no model is set up for this' });
        return null;
      }
      const template = await loadPrompt(deps.promptsDir, prompt.id, prompt.fallback);
      let content = render(template, vars);
      if (!content.includes(`Return JSON matching ${prompt.output}`))
        content += `\n\nReturn JSON matching ${prompt.output}.`;
      const asked = content;
      const maxOutputTokens = opts?.maxOutputTokens ?? 800;

      const ask = async (text: string, tokens: number) => {
        const signal = AbortSignal.timeout(deps.timeoutMs ?? 45_000);
        let reply = '';
        let cutOff = false;
        for await (const ev of deps.gateway.stream(
          models,
          {
            system: SYSTEM,
            messages: [{ role: 'user', content: text }],
            temperature: 0,
            maxOutputTokens: tokens,
          },
          signal,
        )) {
          if (ev.type === 'model') out.modelId = ev.modelId;
          if (ev.type !== 'chunk') continue;
          if (ev.chunk.type === 'text') reply += ev.chunk.delta;
          else if (ev.chunk.type === 'finish') {
            cutOff = /length|max_tokens/i.test(ev.chunk.finishReason);
            out.inputTokens += ev.chunk.usage.inputTokens;
            out.outputTokens += ev.chunk.usage.outputTokens;
            if (ev.chunk.costUsd !== undefined) out.costUsd = (out.costUsd ?? 0) + ev.chunk.costUsd;
          }
        }
        return { reply, cutOff };
      };

      let why = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        let r: { reply: string; cutOff: boolean };
        try {
          r = await ask(
            attempt === 0
              ? asked
              : `${asked}\n\nYour last reply could not be used (${why}). Reply again with only the JSON object, keeping every field short.`,
            attempt === 0 ? maxOutputTokens : Math.round(maxOutputTokens * 1.5),
          );
        } catch (err) {
          log.warn({ err, prompt: prompt.id }, 'a memory utility call failed');
          done({ reason: 'the model did not answer' });
          return null;
        }
        const json = extractJson(r.reply);
        if (json === undefined) {
          why = r.cutOff ? 'it was cut off before the JSON ended' : 'it was not JSON';
        } else {
          const parsed = schema.safeParse(json);
          if (parsed.success) {
            done({ ok: true });
            return parsed.data;
          }
          // Field names and issue codes only: never what the person's content said.
          why = parsed.error.issues
            .slice(0, 4)
            .map((i) => `${i.path.join('.') || 'reply'}: ${i.code}`)
            .join(', ');
        }
        log.info(
          { prompt: prompt.id, attempt: attempt + 1, reason: why, chars: r.reply.length },
          'a memory utility call returned something unusable',
        );
      }
      done({ reason: `the reply could not be read (${why})` });
      return null;
    },
  };
}
