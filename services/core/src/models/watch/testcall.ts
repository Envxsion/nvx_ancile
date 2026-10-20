/**
 * ------------------------------------------------------------------
 *  Title    |  The test call before a line moves
 *  Ref      |  guard rail GR16 · roadmap MD5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Prove a newer model answers before "follow latest"
 *           |  switches to it.
 *  How      |  One minimal request through the normal gateway path
 *           |  (the same client, resilience and spans as any answer):
 *           |  "Reply with the single word: ready", 16 tokens, no
 *           |  tools. It passes when some text came back and nothing
 *           |  failed. Tokens and cost are logged (numbers only) and
 *           |  the call has its own trace span like any model call.
 *  Note     |  Other utility calls are not written to Usage either:
 *           |  Usage is read from the answers on messages.
 * ------------------------------------------------------------------
 */
import type { Gateway } from '../../gateway/gateway';
import { priceOf } from '../../gateway/usage';
import { logFor } from '../../obs/logger';
import type { TestCall } from './service';

const log = logFor('model-watch');

export const TEST_PROMPT = 'Reply with the single word: ready';

const REFUSAL_WORDS =
  /(no longer available|not found|does not exist|not supported|deprecated|not permitted|no access|unknown model)/i;

const PRIVACY_BLOCK = /(all providers have been ignored|no allowed providers are available)/i;
const PRIVACY_HINT =
  'Your OpenRouter privacy settings block every provider for this model: openrouter.ai/settings/privacy';

/**
 * The provider's reason when it refused this model for good (F3c): a 404, a model the key may not use,
 * or a 400 that says the model is gone. Null for anything that is about the key, the account or the
 * moment (a rate limit, no credit, an overload, a bad key), which says nothing about the model.
 */
export function modelRefusal(err: unknown): string | null {
  // A one-model chain fails as a ChainFailedError whose last attempt holds the provider's words.
  const last = (
    err as { attempts?: { errorClass?: string; detail?: string; code?: string }[] }
  )?.attempts?.at(-1);
  const e = last ?? (err as { errorClass?: string; message?: string; code?: string });
  const message = String((last ? last.detail : (e as { message?: string }).message) ?? '');
  // The account's privacy settings leave OpenRouter no provider for the model: about this account and
  // this model, so it is unavailable, whatever class the status gave it. Their words, then the way out.
  if (PRIVACY_BLOCK.test(message))
    return `${message.replace(/\s+/g, ' ').trim().slice(0, 160)} ${PRIVACY_HINT}`;
  if (e.errorClass !== 'permanent') return null;
  if (e.code !== 'provider.model_not_permitted' && !REFUSAL_WORDS.test(message)) return null;
  // The provider's own sentence when it gave one, else ours. Cut short; the gateway never puts a key in it.
  return message.replace(/\s+/g, ' ').trim().slice(0, 240) || 'The provider refused this model.';
}

export function gatewayTestCall(gateway: Gateway): TestCall {
  return async (model, signal) => {
    let text = '';
    let input = 0;
    let output = 0;
    try {
      for await (const ev of gateway.stream(
        [model],
        {
          system: 'Ancile task: models.test. Follow the instruction in the user message exactly.',
          messages: [{ role: 'user', content: TEST_PROMPT }],
          maxOutputTokens: 16,
          temperature: 0,
        },
        signal,
      )) {
        if (ev.type !== 'chunk') continue;
        if (ev.chunk.type === 'text') text += ev.chunk.delta;
        else if (ev.chunk.type === 'finish') {
          input += ev.chunk.usage.inputTokens;
          output += ev.chunk.usage.outputTokens;
        }
      }
    } catch (err) {
      const cls = (err as { errorClass?: string })?.errorClass ?? 'unknown';
      log.warn({ model: model.id, error_class: cls }, 'the test call failed');
      const refused = modelRefusal(err);
      return {
        ok: false,
        detail: `${model.display_name} did not answer the test call (${cls}).`,
        ...(refused && { refused }),
      };
    }
    log.info(
      {
        model: model.id,
        input_tokens: input,
        output_tokens: output,
        cost_usd: priceOf(model, { inputTokens: input, outputTokens: output }),
      },
      'test call finished',
    );
    if (!text.trim())
      return { ok: false, detail: `${model.display_name} answered the test call with no text.` };
    return { ok: true, detail: null };
  };
}
