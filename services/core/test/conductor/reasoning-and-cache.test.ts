/**
 * ------------------------------------------------------------------
 *  Title    |  A turn keeps its reasoning and names its cache (CA1, CA5)
 *  Ref      |  ROADMAP.md CA1, CA5 · docs/prompt-caching.md
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  Through the whole conductor: a multi-step tool turn
 *           |  stores the reasoning it was given, signatures and all,
 *           |  the next step and the next turn carry it back by the
 *           |  provider's rule, and every request names the thread,
 *           |  branch and epoch its cache keys are made from.
 * ------------------------------------------------------------------
 */

import type { Message, ModelConfig } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { branchKeyFor } from '../../src/conductor/context';
import { toSdkMessages } from '../../src/gateway/convert';
import { replayFor } from '../../src/gateway/replay';
import type { ModelRequest } from '../../src/gateway/types';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

const chatCalls = () => h.provider.calls.filter((c) => c.req.tools?.length).map((c) => c.req);

async function reply(t: string, text: string, parent: string | null = null) {
  const sent = await h.send(t, text, { parent_id: parent });
  await h.settle(sent.run_id);
  return sent;
}

const claude = { provider: 'anthropic', via: 'direct', provider_model: 'claude-sonnet-5-5' } as ModelConfig;
const deepseek = { provider: 'deepseek', via: 'direct', provider_model: 'deepseek-v4-pro' } as ModelConfig;

describe('reasoning through a multi-step tool turn', () => {
  it('is stored as received and carried into the next step and the next turn', async () => {
    h = await harness();
    const t = await h.newThread();
    const a = await reply(t, '/thinktool fs_list {"path":"/workspace"}');
    const calls = chatCalls();
    expect(calls).toHaveLength(2);

    // Step two sees step one's reasoning, signature included, ahead of the call it made.
    const partial = calls[1]?.messages.at(-1);
    expect(partial?.parts?.[0]).toEqual({
      type: 'reasoning',
      text: 'I should call the tool. ',
      provider_meta: { anthropic: { signature: 'sig-before' } },
    });

    // The answer keeps both blocks as parts, and as the form it was sent in.
    const m = (await h.repo.getMessage(a.assistant_message_id)) as Message;
    expect(m.parts.filter((p) => p.type === 'reasoning')).toHaveLength(2);
    const stored = (await h.repo.sentForms([a.assistant_message_id])).get(a.assistant_message_id)?.sent ?? '';
    expect(stored).toContain('sig-before');
    expect(stored).toContain('sig-after');

    // The next turn: DeepSeek gets both as reasoning_content, Anthropic as signed blocks.
    await reply(t, 'and now?', a.assistant_message_id);
    const next = chatCalls().at(-1) as ModelRequest;
    const prior = next.messages.find((x) => x.role === 'assistant');
    expect(prior?.sent).toContain('sig-after');
    const forDeepseek = toSdkMessages(next.messages, {
      tools: true,
      reasoning: replayFor(deepseek, { tools: true }),
    });
    const texts = forDeepseek
      .filter((x) => x.role === 'assistant')
      .flatMap((x) =>
        x.content.filter((c) => c.type === 'reasoning').map((c) => (c as { text: string }).text),
      );
    expect(texts).toEqual(['I should call the tool. ', 'Weighing what the tool returned. ']);
    const forClaude = toSdkMessages(next.messages, {
      tools: true,
      reasoning: replayFor(claude, { tools: true }),
    });
    expect(JSON.stringify(forClaude)).toContain('"signature":"sig-before"');
    // A provider with no rule gets none.
    const forOpenAi = toSdkMessages(next.messages, {
      tools: true,
      reasoning: replayFor({ ...deepseek, provider: 'openai' }, { tools: true }),
    });
    expect(JSON.stringify(forOpenAi)).not.toContain('reasoning');
  });
});

describe('every request names its cache scope', () => {
  it('is the same for each turn of a branch and each step of a turn, and differs on another branch', async () => {
    h = await harness();
    const t = await h.newThread();
    const a = await reply(t, '/tool fs_list {"path":"/workspace"}');
    await reply(t, 'second', a.assistant_message_id);
    const calls = chatCalls();
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const first = calls[0]?.cache;
    expect(first).toMatchObject({ threadId: t });
    for (const c of calls) expect(c.cache).toEqual(first);

    // A second question from the start is another branch of the same thread.
    const fork = await reply(t, 'a different start');
    const forked = chatCalls().at(-1)?.cache;
    expect(forked?.threadId).toBe(t);
    expect(forked?.branch).not.toBe(first?.branch);
    const all = await h.repo.messages(t);
    expect(branchKeyFor(all, fork.user_message_id)).toBe(forked?.branch);
    // The first branch keeps its own id now that there is a fork above it.
    expect(branchKeyFor(all, a.user_message_id)).toBe(first?.branch);
  });

  it('splits the frozen system prompt into rules and snapshot for Anthropic', async () => {
    h = await harness({ memory: true });
    const t = await h.newThread();
    await reply(t, '/say hello');
    const req = chatCalls().at(-1) as ModelRequest;
    expect(req.systemBlocks).toBeDefined();
    const [rules, snapshot] = req.systemBlocks as [string, string];
    expect(`${rules}\n\n${snapshot}`).toBe(req.system);
    expect(snapshot.length).toBeGreaterThan(0);
  });
});
