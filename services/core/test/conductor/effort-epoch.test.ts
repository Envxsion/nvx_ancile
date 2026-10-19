/**
 * ------------------------------------------------------------------
 *  Title    |  Reasoning effort and the prompt epoch (EN1, CA2)
 *  Ref      |  ROADMAP.md EN1 · docs/prompt-caching.md
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  A thread's effort rides on the next request and does
 *           |  not start an epoch, so the cached start of the
 *           |  conversation survives a change of it; turning thinking
 *           |  on or off still does.
 * ------------------------------------------------------------------
 */

import type { Message } from '@nvx/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toSdkMessages } from '../../src/gateway/convert';
import type { ModelRequest } from '../../src/gateway/types';
import { fakeModel } from '../gateway/fake-provider';
import { type Harness, harness } from '../support/harness';

vi.setConfig({ testTimeout: 15_000 });

let h: Harness;
afterEach(async () => h?.close());

async function reply(t: string, text: string, parent: string | null = null, extra = {}) {
  const sent = await h.send(t, text, { parent_id: parent, ...extra });
  await h.settle(sent.run_id);
  return sent;
}
const epochOf = async (id: string) =>
  ((await h.repo.getMessage(id)) as Message).provenance.epoch as {
    id: string;
    started: boolean;
    reason: string;
  };
const calls = () => h.provider.calls.filter((c) => c.req.tools?.length).map((c) => c.req);

describe('a change of effort', () => {
  it('goes on the next request, leaves the epoch and the start of the request alone, and can be cleared', async () => {
    h = await harness();
    const t = await h.newThread();
    const a = await reply(t, '/say first answer');
    expect((await h.call('PATCH', `/threads/${t}`, { effort: 'high' })).status).toBe(200);
    const b = await reply(t, 'second question', a.assistant_message_id);
    expect((await epochOf(b.assistant_message_id)).started).toBe(false);
    expect((await epochOf(b.assistant_message_id)).id).toBe((await epochOf(a.assistant_message_id)).id);

    const [x, y] = calls() as [ModelRequest, ModelRequest];
    expect(x.effort).toBeUndefined();
    expect(y.effort).toBe('high');
    // What a provider caches by is the same: system, tools, and every earlier message.
    expect(y.system).toBe(x.system);
    expect(y.tools).toEqual(x.tools);
    const wire = (r: ModelRequest) =>
      toSdkMessages(r.messages, { tools: true }).map((m) => JSON.stringify(m));
    expect(wire(y).slice(0, wire(x).length)).toEqual(wire(x));

    // null puts it back to the model's default.
    await h.call('PATCH', `/threads/${t}`, { effort: null });
    await reply(t, 'third question', b.assistant_message_id);
    expect(calls().at(-1)?.effort).toBeUndefined();
  });

  it('is refused when it is not one of the levels', async () => {
    h = await harness();
    const t = await h.newThread();
    expect((await h.call('PATCH', `/threads/${t}`, { effort: 'maximum' })).status).toBe(400);
  });

  it('stays out of the way of the epoch rule: thinking toggled still starts a new one', async () => {
    h = await harness({
      models: [fakeModel('other', 'echo', 'other-family')],
      taskClasses: { 'chat.default': ['offline/test'] },
    });
    const t = await h.newThread();
    const a = await reply(t, '/say one');
    await h.call('PATCH', `/threads/${t}`, { effort: 'medium' });
    const b = await reply(t, 'two', a.assistant_message_id);
    expect((await epochOf(b.assistant_message_id)).started).toBe(false);
    await h.call('PATCH', `/threads/${t}`, { thinking: true });
    const c = await reply(t, 'three', b.assistant_message_id);
    expect(await epochOf(c.assistant_message_id)).toMatchObject({
      reason: 'thinking_toggled',
      started: true,
    });
  });
});
