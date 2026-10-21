/**
 * ------------------------------------------------------------------
 *  Title    |  A fallback with a smaller window gets a request it holds
 *  Ref      |  ROADMAP.md HO1 · conductor/refit.ts · gateway.ts (fit)
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  The turn is built for the first model of the chain. If
 *           |  that one fails and the next has a smaller window, the
 *           |  same request used to be sent again and overflow. Now it
 *           |  is rebuilt at the summary size that window reads, or the
 *           |  model is skipped with a plain reason. Offline models only.
 * ------------------------------------------------------------------
 */

import type { Message } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeModel } from '../../src/gateway/fake';
import { harness } from '../support/harness';

type H = Awaited<ReturnType<typeof harness>>;
let h: H | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const big = fakeModel('big', 'script');
const small = { ...fakeModel('small', 'echo'), context_window: 3_000, max_output: 100 };
const tiny = { ...fakeModel('tiny', 'echo'), context_window: 700, max_output: 100 };
const roomy = fakeModel('roomy', 'echo');

async function longThread(hh: H) {
  const t = await hh.newThread();
  let parent: string | null = null;
  for (let i = 1; i <= 5; i++) {
    const r = await hh.send(
      t,
      `Question ${i} about pumps. ${'More detail about valves and seals. '.repeat(40)}`,
      {
        parent_id: parent,
        model: 'fake/big',
      },
    );
    await hh.settle(r.run_id);
    parent = r.assistant_message_id;
  }
  return { t, parent };
}

const events = async (hh: H, runId: string) => hh.eventsOf(runId);

describe('a fallback with a smaller window', () => {
  it('is sent the thread at the size its window reads, not the request built for the first model', async () => {
    h = await harness({
      models: [big, small],
      taskClasses: { 'chat.default': ['fake/big', 'fake/small'], utility: ['fake/big'] },
      offline: false,
    });
    const { t, parent } = await longThread(h);
    const sent = await h.send(t, '/fail 500', { parent_id: parent, model: 'fake/big' });
    await h.settle(sent.run_id);

    const calls = h.provider.calls.filter((c) => c.model === 'fake/small');
    expect(calls).toHaveLength(1);
    const firstTry = h.provider.calls.filter((c) => c.model === 'fake/big').at(-1);
    const text = (m: { content: string }[]) => m.map((x) => x.content).join('\n').length;
    // The first model was sent every turn; the smaller one a summary and the latest turns.
    expect(text(calls[0]?.req.messages ?? [])).toBeLessThan(text(firstTry?.req.messages ?? []));
    expect(JSON.stringify(calls[0]?.req.messages)).toContain(
      'Summary of the earlier part of this conversation',
    );
    expect(JSON.stringify(calls[0]?.req.messages)).not.toContain('Question 1 about pumps');

    const reply = (await h.repo.getMessage(sent.assistant_message_id)) as Message;
    expect(reply.model_id).toBe('fake/small');
    expect(reply.status).toBe('complete');
    const refit = (reply.provenance as { refit?: { model_id: string; level: string }[] }).refit;
    expect(refit?.[0]).toMatchObject({ model_id: 'fake/small' });
    expect(['page', 'paragraph', 'line']).toContain(refit?.[0]?.level);
    // The original messages are all still there.
    expect((await h.repo.messages(t)).length).toBeGreaterThanOrEqual(11);
  });

  it('is skipped, with the reason, when even the smallest summary cannot fit', async () => {
    h = await harness({
      models: [big, tiny, roomy],
      taskClasses: { 'chat.default': ['fake/big', 'fake/tiny', 'fake/roomy'], utility: ['fake/big'] },
      offline: false,
    });
    const { t, parent } = await longThread(h);
    const sent = await h.send(t, '/fail 500', { parent_id: parent, model: 'fake/big' });
    await h.settle(sent.run_id);

    // The tiny model was never asked: its window cannot hold the system text and the tools.
    expect(h.provider.calls.some((c) => c.model === 'fake/tiny')).toBe(false);
    const evs = await events(h, sent.run_id);
    const skip = evs.find((e) => e.type === 'fallback' && e.from_model === 'fake/tiny');
    expect(skip).toMatchObject({ to_model: 'fake/roomy', reason: 'context_overflow' });
    expect((skip as { detail: string }).detail).toMatch(/window cannot hold this thread, so it was skipped/);
    const reply = (await h.repo.getMessage(sent.assistant_message_id)) as Message;
    expect(reply.model_id).toBe('fake/roomy');
  });

  it('leaves a request that fits exactly as built', async () => {
    h = await harness({
      models: [big, roomy],
      taskClasses: { 'chat.default': ['fake/big', 'fake/roomy'], utility: ['fake/big'] },
      offline: false,
    });
    const { t, parent } = await longThread(h);
    const sent = await h.send(t, '/fail 500', { parent_id: parent, model: 'fake/big' });
    await h.settle(sent.run_id);
    const a = h.provider.calls.filter((c) => c.model === 'fake/big').at(-1);
    const b = h.provider.calls.filter((c) => c.model === 'fake/roomy').at(-1);
    expect(JSON.stringify(b?.req.messages)).toBe(JSON.stringify(a?.req.messages));
    const reply = (await h.repo.getMessage(sent.assistant_message_id)) as Message;
    expect((reply.provenance as { refit?: unknown }).refit).toBeUndefined();
  });
});

describe('the turn counts the real request', () => {
  it('compacts for the model asked when the system text and tools fill most of its window', async () => {
    // A 5-turn thread is about 1.1k tokens; with ~1k of system text and tools in a 3.0k window it is past 95%.
    h = await harness({
      models: [{ ...big, context_window: 3_000, max_output: 100 }],
      taskClasses: { 'chat.default': ['fake/big'], utility: ['fake/big'] },
      offline: false,
    });
    const t = await h.newThread();
    let parent: string | null = null;
    let last = '';
    for (let i = 1; i <= 6; i++) {
      const r = await h.send(
        t,
        `Question ${i} about pumps. ${'More detail about valves and seals. '.repeat(40)}`,
        {
          parent_id: parent,
        },
      );
      await h.settle(r.run_id);
      parent = r.assistant_message_id;
      last = r.assistant_message_id;
    }
    const rows = await h.branches.summaries(t, 'compaction');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.for_window === 3_000)).toBe(true);
    const reply = (await h.repo.getMessage(last)) as Message;
    expect(reply.provenance).toMatchObject({ compaction: { auto: true } });
  });
});
