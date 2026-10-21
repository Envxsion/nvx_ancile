/**
 * ------------------------------------------------------------------
 *  Title    |  Work survives a change of model: text forms (HO1)
 *  Ref      |  ROADMAP.md HO1 · docs/prompt-caching.md
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  A tool result replayed as text says when it was cut, and
 *           |  an earlier turn's [n] citations name their sources, so a
 *           |  later model never reads a number with nothing behind it.
 * ------------------------------------------------------------------
 */

import type { Part } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { citationLabel, citedForHistory, relabelCitations } from '../../src/conductor/citations';
import { historyFor } from '../../src/conductor/context';
import { cutMiddle, TOOL_TEXT_MAX, toolsAsText } from '../../src/gateway/convert';
import { partsText } from '../../src/threads/compact';
import type { MessageRecord } from '../../src/threads/repo';

describe('a cut tool result', () => {
  it('keeps the start and the end and says how much was left out', () => {
    const body = `START ${'a'.repeat(6_000)} END`;
    const out = cutMiddle(body);
    expect(out.startsWith('START')).toBe(true);
    expect(out.endsWith('END')).toBe(true);
    expect(out).toContain(`[cut: ${(body.length - TOOL_TEXT_MAX).toLocaleString('en-GB')} characters left out]`);
    expect(out.length).toBeLessThan(body.length);
  });

  it('leaves a short result alone', () => {
    expect(cutMiddle('short')).toBe('short');
  });

  it('is what a model without tools reads of a long result', () => {
    const parts: Part[] = [
      { type: 'tool_call', call_id: 'c', tool: 'fs_read', args: {} },
      { type: 'tool_result', call_id: 'c', ok: true, result: `head ${'x'.repeat(9_000)} tail` },
    ];
    const text = toolsAsText(parts)
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('');
    expect(text).toMatch(/\[cut: [\d,]+ characters left out\]/);
    expect(text).toContain('tail]');
  });
});

describe('citations in earlier turns', () => {
  const ref = (marker: number, extra: Record<string, unknown> = {}): Part =>
    ({
      type: 'citation_ref',
      marker,
      chunk_id: `c${marker}`,
      source_id: `s${marker}`,
      char_start: 0,
      char_end: 1,
      quote: 'q',
      ...extra,
    }) as Part;
  const answer: Part[] = [
    {
      type: 'text',
      text: 'The pump moves 9 l/min [1] and the tank holds 40 l [2, 3]. `a[1]` stays. Unknown [7].',
    },
    ref(1, { source_title: 'Pump manual', page: 12 }),
    ref(2, { source_title: 'Tank [spec]', page: null }),
    ref(3),
  ];

  it('names the source and page, never a bare number', () => {
    const text = (citedForHistory(answer)[0] as { text: string }).text;
    expect(text).toContain('9 l/min [Pump manual, p. 12]');
    expect(text).toContain('[Tank spec][a source]');
    expect(text).toContain('`a[1]` stays');
    expect(text).toContain('Unknown [7].');
  });

  it('is what a summary and a rebuilt history read', () => {
    expect(partsText(answer)).toContain('[Pump manual, p. 12]');
    const rec = (id: string, parent: string | null, role: 'user' | 'assistant', parts: Part[]) =>
      ({
        id,
        thread_id: 't',
        parent_id: parent,
        role,
        parts,
        model_id: null,
        requested_model_id: null,
        status: 'complete',
        edit_of_id: null,
        provenance: {},
        usage: null,
        run_id: null,
        trace_id: 'x',
        created_at: '2026-10-07T00:00:00Z',
      }) as MessageRecord;
    const msgs = [
      rec('u1', null, 'user', [{ type: 'text', text: 'How big?' }]),
      rec('a1', 'u1', 'assistant', answer),
      rec('u2', 'a1', 'user', [{ type: 'text', text: 'And then?' }]),
    ];
    const history = historyFor(msgs, 'u2');
    expect(history[1]?.content).toContain('[Pump manual, p. 12]');
    expect(history[1]?.content).not.toContain('l/min [1]');
  });

  it('labels a marker only when every number in it has a source', () => {
    const labels = new Map([[1, citationLabel({ source_title: 'A' })]]);
    const out = relabelCitations([{ type: 'text', text: 'x [1] y [1, 2]' }], labels);
    expect((out[0] as { text: string }).text).toBe('x [A] y [1, 2]');
  });
});
