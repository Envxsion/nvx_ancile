/**
 * Claude Code tool results that an older mapping left outside the answer
 * holding their calls. Core now keeps a result with its call (mapper
 * version 4) and repairs older threads in place, leaving the answer that
 * gave its results away as an empty link (results_moved_to). The thread
 * draws each step once, with its result, either way.
 */
import type { Message, Part } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { toMessageViews } from '../src/lib/mappers';

function message(p: Partial<Message> & Pick<Message, 'id' | 'role' | 'parts'>): Message {
  return {
    thread_id: 't1',
    parent_id: null,
    model_id: null,
    requested_model_id: null,
    status: 'complete',
    edit_of_id: null,
    provenance: {},
    usage: null,
    run_id: null,
    trace_id: 'x',
    created_at: '2026-10-01T09:00:00.000Z',
    ...p,
  } as Message;
}

const cc = (extra: Record<string, unknown> = {}) => ({
  claude_code: { session_id: 's', uuid: 'u', uuids: ['u'], ...extra },
});
const call: Part = { type: 'tool_call', call_id: 'c1', tool: 'Bash', args: { command: 'pnpm test' } };
const result: Part = { type: 'tool_result', call_id: 'c1', ok: true, result: 'ok', duration_ms: 1200 };
const note = message({
  id: 'n',
  role: 'system',
  parent_id: 'a',
  parts: [{ type: 'text', text: 'A background task finished' }],
  provenance: cc({
    kind: 'notification',
    notification: { source: 'task', title: 'Background task finished' },
  }),
});

describe('Claude Code results kept apart from their calls', () => {
  it('a thread Core has not synced since: the stray result joins the answer that made the call', () => {
    const views = toMessageViews([
      message({ id: 'a', role: 'assistant', parts: [call], provenance: cc() }),
      note,
      message({ id: 's', role: 'assistant', parent_id: 'n', parts: [result], provenance: cc() }),
    ]);
    expect(views.map((v) => [v.id, v.folded ?? false])).toEqual([
      ['a', false],
      ['n', false],
      ['s', true],
    ]);
    expect(views[0]?.parts).toEqual([call, result]);
  });

  it('a repaired thread: the answer that gave its results away is a folded link, the call shows its result', () => {
    const views = toMessageViews([
      message({ id: 'a', role: 'assistant', parts: [call, result], provenance: cc() }),
      note,
      message({
        id: 's',
        role: 'assistant',
        parent_id: 'n',
        parts: [{ type: 'text', text: '' }],
        provenance: cc({ results_moved_to: 'a' }),
      }),
      message({
        id: 'u2',
        role: 'user',
        parent_id: 's',
        parts: [{ type: 'text', text: 'Thanks' }],
        provenance: cc(),
      }),
    ]);
    expect(views.map((v) => [v.id, v.folded ?? false])).toEqual([
      ['a', false],
      ['n', false],
      ['s', true],
      ['u2', false],
    ]);
    // Drawn once: the moved result is not added a second time.
    expect(views[0]?.parts?.filter((p) => p.type === 'tool_result')).toHaveLength(1);
  });

  it('an answer that kept more than results, or holds entries it cannot show, is drawn as it is', () => {
    const views = toMessageViews([
      message({ id: 'a', role: 'assistant', parts: [call, result], provenance: cc() }),
      note,
      message({
        id: 's',
        role: 'assistant',
        parent_id: 'n',
        parts: [{ type: 'text', text: 'All green.' }],
        provenance: cc({ results_moved_to: 'a' }),
      }),
      message({
        id: 'k',
        role: 'assistant',
        parent_id: 's',
        parts: [{ type: 'text', text: '' }],
        provenance: cc({ results_moved_to: 'a', unknown: { count: 1, types: ['hologram'] } }),
      }),
    ]);
    expect(views.map((v) => [v.id, v.folded ?? false])).toEqual([
      ['a', false],
      ['n', false],
      ['s', false],
      ['k', false],
    ]);
    expect(views[2]?.parts).toEqual([{ type: 'text', text: 'All green.' }]);
  });

  it('only Claude Code answers are joined that way; another model never makes one', () => {
    const views = toMessageViews([
      message({ id: 'a', role: 'assistant', parts: [call] }),
      message({ id: 's', role: 'assistant', parent_id: 'a', parts: [result] }),
    ]);
    expect(views.map((v) => [v.id, v.folded ?? false])).toEqual([
      ['a', false],
      ['s', false],
    ]);
    expect(views[0]?.parts).toEqual([call]);
  });
});
