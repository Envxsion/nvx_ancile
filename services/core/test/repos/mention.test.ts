/**
 * An @repo on a message reaches the turn: git tools in that turn act on the
 * mentioned repository, whatever the thread is linked to.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

describe('@repo', () => {
  it('carries the mentioned repository into the turn', async () => {
    h = await harness();
    const thread = await h.newThread();
    const sent = await h.send(thread, 'What changed on this branch?', {
      mentions: [{ kind: 'repo', id: 'rep_example' }],
    });
    const run = await h.runs.get(sent.run_id);
    expect((run?.checkpoint as { input: { repoId?: string } } | undefined)?.input.repoId).toBe('rep_example');
    await h.settle(sent.run_id);
  });

  it('leaves the turn unscoped without one', async () => {
    h = await harness();
    const sent = await h.send(await h.newThread(), 'Hello');
    const run = await h.runs.get(sent.run_id);
    expect((run?.checkpoint as { input: { repoId?: string } } | undefined)?.input.repoId).toBeUndefined();
    await h.settle(sent.run_id);
  });
});
