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
      return { ok: false, detail: `${model.display_name} did not answer the test call (${cls}).` };
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
