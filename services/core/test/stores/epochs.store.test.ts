/**
 * ------------------------------------------------------------------
 *  Title    |  Prompt epochs and sent forms (store contract)
 *  Ref      |  ROADMAP.md CA2, CA4 · migration 0034
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  The same behaviour from the in-memory stores and the
 *           |  Postgres ones: an epoch comes back with the exact text it
 *           |  was stored with, and a message's sent form is text that
 *           |  survives byte for byte (jsonb would reorder its keys).
 * ------------------------------------------------------------------
 */

import { beforeEach, expect, it } from 'vitest';
import {
  type EpochRecord,
  type EpochStore,
  MemoryEpochStore,
  newTrack,
  PgEpochStore,
} from '../../src/conductor/epoch';
import { MemoryThreadRepo, PgThreadRepo, type ThreadRepo } from '../../src/threads/repo';
import { eachBackend, uid } from '../support/stores';

eachBackend('prompt epochs and sent forms', (backend) => {
  let threads: ThreadRepo;
  let epochs: EpochStore;
  let ws: string;

  beforeEach(() => {
    const b = backend();
    ws = b.owner.workspaceId;
    threads = b.sql ? new PgThreadRepo(b.sql) : new MemoryThreadRepo();
    epochs = b.sql ? new PgEpochStore(b.sql) : new MemoryEpochStore();
  });

  it('keeps an epoch as stored, and moves only what moves', async () => {
    const thread = (await threads.createThread({ id: uid('thr'), workspace_id: ws })).id;
    const tools = '[{"name":"b","description":"x","inputSchema":{"z":1,"a":2}}]';
    const e: EpochRecord = {
      id: uid('epc'),
      thread_id: thread,
      reason: 'new_thread',
      model_family: 'claude',
      thinking: false,
      system_text: 'You are the assistant.\n\nMemory: x',
      tools_json: tools,
      tools_hash: 'abc',
      memory_commit: 'abc1234',
      memory_text: 'Memory: x',
      instructions: '',
      display_name: 'Opus',
      compaction_id: null,
      track: newTrack({ snapshot: { 'USER.md': 'abc1234' }, sent: { 'USER.md': 'abc1234' } }),
      started_at: '2026-10-19T00:00:00.000Z',
      last_used_at: '2026-10-19T00:00:00.000Z',
    };
    await epochs.create(e);
    expect(await epochs.get(e.id)).toEqual(e);
    const track = newTrack({ ...e.track, sent: { 'USER.md': 'def5678' } });
    await epochs.patch(e.id, { last_used_at: '2026-10-19T00:10:00.000Z', track });
    const back = await epochs.get(e.id);
    expect(back?.tools_json).toBe(tools);
    expect(back?.last_used_at).toBe('2026-10-19T00:10:00.000Z');
    expect(back?.track.sent).toEqual({ 'USER.md': 'def5678' });
    expect(await epochs.get(uid('epc'))).toBeUndefined();
  });

  it('keeps what a message was sent as, byte for byte, and its epoch', async () => {
    const thread = (await threads.createThread({ id: uid('thr'), workspace_id: ws })).id;
    const id = uid('msg');
    await threads.insertMessage({
      id,
      thread_id: thread,
      parent_id: null,
      role: 'user',
      parts: [{ type: 'text', text: 'hi' }],
      status: 'complete',
      trace_id: '0'.repeat(32),
    });
    const other = uid('msg');
    await threads.insertMessage({
      id: other,
      thread_id: thread,
      parent_id: id,
      role: 'assistant',
      parts: [{ type: 'text', text: 'hello' }],
      status: 'complete',
      trace_id: '0'.repeat(32),
    });
    expect((await threads.sentForms([id, other])).size).toBe(0);
    // Key order and spacing a jsonb column would not keep.
    const sent = '[{"role":"user","content":"b","a":1,"z":{"y":2,  "x":3}}]';
    await threads.updateMessage(id, { sent });
    await threads.updateMessage(other, { epoch_id: 'epc_1' });
    const forms = await threads.sentForms([id, other, 'missing']);
    expect(forms.get(id)).toEqual({ sent, epoch_id: null });
    expect(forms.get(other)).toEqual({ sent: null, epoch_id: 'epc_1' });
    expect(forms.size).toBe(2);
    // Writing the other field leaves this one alone.
    await threads.updateMessage(id, { epoch_id: 'epc_2' });
    expect((await threads.sentForms([id])).get(id)).toEqual({ sent, epoch_id: 'epc_2' });
  });
});
