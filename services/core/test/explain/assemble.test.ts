/**
 * "Why did the AI say this?" for Claude Code's answers: one written in a
 * live turn from NVX Ancile is told apart from one brought in from a
 * terminal's transcript, which has no citation record.
 */
import { describe, expect, it } from 'vitest';
import { assembleExplain } from '../../src/explain/assemble';
import type { MessageRecord } from '../../src/threads/repo';

const message = (p: Partial<MessageRecord>): MessageRecord =>
  ({
    id: 'msg_1',
    thread_id: 'thr_1',
    parent_id: null,
    role: 'assistant',
    parts: [{ type: 'text', text: 'Done.' }],
    status: 'complete',
    model_id: 'claude-code/claude-opus-5-5',
    requested_model_id: null,
    usage: null,
    provenance: {},
    run_id: null,
    trace_id: 't'.repeat(32),
    created_at: '2026-10-12T09:00:00.000Z',
    ...p,
  }) as MessageRecord;

const explain = (m: MessageRecord) =>
  assembleExplain({
    message: m,
    decisions: [],
    factcheck: null,
    actionOf: () => undefined,
    modelName: () => null,
  });

describe('where an answer was written', () => {
  it('says an answer brought in from the terminal has no citation record', () => {
    const x = explain(
      message({ provenance: { claude_code: { session_id: 's', uuid: 'a1', uuids: ['a1'] } } }),
    );
    expect(x.origin).toBe('claude_code_import');
    expect(x.retrieval).toBeNull();
  });

  it('knows a live turn from NVX Ancile, by its run, its flag or its name', () => {
    expect(
      explain(message({ run_id: 'run_1', provenance: { claude_code: { session_id: 's' } } })).origin,
    ).toBe('claude_code_live');
    expect(explain(message({ provenance: { claude_code: { session_id: 's', live: true } } })).origin).toBe(
      'claude_code_live',
    );
    expect(
      explain(message({ provenance: { model_name: 'Claude Code', claude_code: { session_id: 's' } } }))
        .origin,
    ).toBe('claude_code_live');
    expect(explain(message({ model_id: 'openai/gpt-5' })).origin).toBe('ancile');
  });
});
