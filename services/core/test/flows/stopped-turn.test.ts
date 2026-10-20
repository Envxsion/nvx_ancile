/**
 * ------------------------------------------------------------------
 *  Title    |  A stopped flow turn still shows what it spent
 *  Ref      |  DESIGN.md §16 · conductor/pipeline.ts
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  Found live: stopping a flow turn left no steps and $0,
 *           |  losing the router call's cost. Calls that finished are
 *           |  counted, and the one in flight is estimated.
 * ------------------------------------------------------------------
 */

import type { Flow, FlowProvenance, Message, ThreadPath } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

describe('a flow turn stopped while a model is answering', () => {
  it('keeps the usage as an estimate and names who answered', async () => {
    h = await harness();
    const f = await h.call<Flow>('POST', '/flows', {
      name: 'Pumps flow',
      from: 'tpl_single',
      scope: 'notebook',
      scope_ref: 'nbk_pumps',
      activate: true,
    });
    expect(f.status).toBe(201);
    const t = await h.newThread({ notebook_id: 'nbk_pumps' });
    const sent = await h.send(t, '/slow alpha beta gamma delta epsilon zeta eta theta');
    for (let i = 0; i < 100 && h.text(await h.eventsOf(sent.run_id)).length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    await h.call('POST', `/messages/${sent.assistant_message_id}/stop`);
    await h.settle(sent.run_id);
    const path = (await h.call<ThreadPath>('GET', `/threads/${t}/path`)).body;
    const m = path.messages.at(-1) as Message;
    expect(m.status).toBe('stopped');
    expect(m.model_id).toBeTruthy();
    expect(m.usage?.estimated).toBe(true);
    expect(m.usage?.input_tokens).toBeGreaterThan(0);
    expect((m.provenance as { flow?: FlowProvenance }).flow?.flow_id).toBe(f.body.id);
  });
});
