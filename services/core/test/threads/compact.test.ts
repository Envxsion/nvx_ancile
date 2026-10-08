import type { Part } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { historyFor } from '../../src/conductor/context';
import { toolsAsText, toSdkMessages } from '../../src/gateway/convert';
import { offlineUtility, utilityTask } from '../../src/gateway/offline-utility';
import type { SummaryRecord } from '../../src/threads/branches';
import { cutPoint, pathBudget, substitute } from '../../src/threads/compact';
import { asTree, type MessageRecord } from '../../src/threads/repo';
import { topicDrift } from '../../src/threads/suggest';

const msg = (id: string, parent: string | null, role: 'user' | 'assistant', text: string): MessageRecord => ({
  id,
  thread_id: 't',
  parent_id: parent,
  role,
  parts: [{ type: 'text', text }],
  model_id: null,
  requested_model_id: null,
  status: 'complete',
  edit_of_id: null,
  provenance: {},
  usage: null,
  run_id: null,
  trace_id: 'x',
  created_at: '2026-10-07T00:00:00Z',
});

// u1 a1 u2 a2 u3 a3 u4
const chain: MessageRecord[] = [];
for (let i = 1; i <= 7; i++) {
  const role = i % 2 ? 'user' : 'assistant';
  chain.push(msg(`m${i}`, i === 1 ? null : `m${i - 1}`, role, `${role} says thing number ${i} `.repeat(20)));
}
const path = asTree(chain);
const summary = (upto: string): SummaryRecord => ({
  id: `sum_${upto}`,
  thread_id: 't',
  upto_message_id: upto,
  kind: 'compaction',
  content: 'Short summary.',
  tokens: 4,
  model_id: 'x',
  created_at: '2026-10-07T00:00:00Z',
});

describe('compaction', () => {
  it('cuts after the last reply before the verbatim tail', () => {
    expect(cutPoint(path, 4)).toBe(1); // m2: keeps m3..m7 since m3 is a question
    expect(cutPoint(path.slice(0, 3), 4)).toBe(-1);
  });

  it('substitutes the summary and drops what it covers from history', () => {
    const sub = substitute(path, [summary('m2')]);
    expect(sub.skipThrough).toBe('m2');
    expect(sub.note).toContain('Short summary.');
    expect(sub.provenance?.tokens_after).toBeLessThan(sub.provenance?.tokens_before ?? 0);
    const history = historyFor(chain, 'm7', sub.skipThrough);
    expect(history.map((m) => m.content.slice(0, 20))).toEqual(
      ['m3', 'm4', 'm5', 'm6', 'm7'].map((id) => {
        const part = chain.find((c) => c.id === id)?.parts[0];
        return part?.type === 'text' ? part.text.slice(0, 20) : '';
      }),
    );
  });

  it('ignores a summary that would eat into the latest turns', () => {
    expect(substitute(path, [summary('m6')]).skipThrough).toBeNull();
  });

  it('warns at 80% and is critical at 95% of the window', () => {
    const model = { id: 'm', context_window: 1_000, max_output: 100 } as never;
    const b = pathBudget({ headId: 'm7', path, summaries: [], model, system: 200 });
    expect(b.used.reserve_output).toBe(100);
    expect(b.level).toBe(b.ratio >= 0.95 ? 'critical' : b.ratio >= 0.8 ? 'warn' : 'ok');
    const huge = pathBudget({ headId: 'm7', path, summaries: [], model, system: 900 });
    expect(huge.level).toBe('critical');
    expect(huge.compactable).toBe(2);
  });
});

describe('parts for the target model', () => {
  const parts: Part[] = [
    { type: 'text', text: 'Reading it. ' },
    { type: 'tool_call', call_id: 'c1', tool: 'fs_read', args: { path: '/a' } },
    { type: 'tool_result', call_id: 'c1', ok: true, result: 'hello' },
    { type: 'reasoning', text: 'hidden' },
  ];

  it('replays a tool exchange as text for a model without tools', () => {
    const out = toSdkMessages([{ role: 'assistant', content: '', parts }], { tools: false });
    expect(out).toHaveLength(1);
    expect(JSON.stringify(out)).toContain('[Called fs_read');
    expect(JSON.stringify(out)).toContain('[Result: hello]');
    expect(JSON.stringify(out)).not.toContain('hidden');
    expect(toolsAsText(parts).every((p) => p.type === 'text' || p.type === 'reasoning')).toBe(true);
  });

  it('gives an image without vision as its caption, marked', () => {
    const out = toSdkMessages([
      {
        role: 'user',
        content: '',
        parts: [
          { type: 'text', text: 'What is this?' },
          { type: 'image', url: 'x', mime: 'image/png', caption: 'a red pump' },
        ],
      },
    ]);
    expect(out[0]).toMatchObject({
      role: 'user',
      content: 'What is this?\n[Image, described: a red pump]\n',
    });
  });
});

describe('the offline model on utility prompts', () => {
  it('reads the task from the system line', () => {
    expect(utilityTask('Ancile task: threads.compact. Follow the instructions.')).toBe('threads.compact');
    expect(utilityTask('You are the assistant')).toBeNull();
  });

  it('summarises extractively and compares as JSON', () => {
    const compact = offlineUtility(
      'threads.compact',
      'Conversation to compress:\nUser: How big is the tank? It matters.\n\nAssistant: The tank holds 40 litres. More detail follows.',
    );
    expect(compact).toContain('The user asked: How big is the tank?');
    const cmp = JSON.parse(
      offlineUtility(
        'threads.compare',
        'Branch A (x):\nAssistant: One two three.\n\nBranch B (y):\nAssistant: Four.\n\nReturn JSON',
      ),
    );
    expect(cmp.differences[1]).toMatchObject({ aspect: 'Length', a: '4 words', b: '2 words' });
  });

  it('compares how the answers open, not the questions, on branches made by an edit', () => {
    const cmp = JSON.parse(
      offlineUtility(
        'threads.compare',
        'Branch A (x):\nUser: How big is the tank?\n\nAssistant: It holds 40 litres.\n\nBranch B (y):\nUser: How big is the pump?\n\nAssistant: It moves 9 litres a minute.\n\nReturn JSON',
      ),
    );
    expect(cmp.differences[0]).toMatchObject({
      aspect: 'Question',
      a: 'How big is the tank?',
      b: 'How big is the pump?',
    });
    expect(cmp.differences[1]).toMatchObject({
      aspect: 'How the answer opens',
      a: 'It holds 40 litres.',
      b: 'It moves 9 litres a minute.',
    });
  });
});

describe('topic drift', () => {
  it('fires only with enough history and almost no shared words', () => {
    const recent = [
      'pump impeller inspection schedule',
      'impeller wear signs',
      'impeller material cavitation',
    ];
    expect(
      topicDrift(recent, 'Draft a birthday invitation for grandmother Rosalind next Saturday').fired,
    ).toBe(true);
    expect(topicDrift(recent, 'Which impeller coating lasts longest under cavitation stress?').fired).toBe(
      false,
    );
    expect(topicDrift(recent.slice(0, 2), 'Draft a birthday invitation for grandmother Rosalind').fired).toBe(
      false,
    );
  });
});
