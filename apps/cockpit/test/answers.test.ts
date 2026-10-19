/**
 * Copy formats (AN1), export (EX3), find in a thread (TS2), code block helpers (AN3),
 * the selection actions' text (AN2) and the turn summary (CH4).
 */
import type { Part } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import {
  citationsOf,
  clipboardFor,
  markdownToHtml,
  markdownToPlain,
  withFootnotes,
} from '../src/lib/answerText';
import { defaultFileName, fileNameProblem, isMermaid, isPython, runRequest } from '../src/lib/codeActions';
import { quoteBlock } from '../src/lib/selectionActions';
import { exportHtml, exportMarkdown, exportName, MAX_STEPS } from '../src/lib/threadExport';
import { findInThread, keepActive, occurrences, stepIndex } from '../src/lib/threadFind';
import type { CitationView, MessageView } from '../src/lib/types';
import { buildSteps, changedFiles, spanWords, tokenWords, turnSummary } from '../src/receipt/figures';

const msg = (
  id: string,
  role: 'user' | 'assistant',
  parts: Part[],
  extra: Partial<MessageView> = {},
): MessageView => ({
  id,
  parentId: null,
  role,
  blocks: [],
  parts,
  modelId: role === 'assistant' ? 'm/one' : null,
  createdAt: '2026-10-19T00:00:00.000Z',
  ...extra,
});
const text = (t: string): Part => ({ type: 'text', text: t });
const cites: CitationView[] = [
  { marker: 1, sourceId: 's1', title: 'Heat pump guide', quote: 'COP of 3', location: 'p. 4' },
  { marker: 2, sourceId: 's2', title: 'Unused', quote: '', location: '' },
];

describe('copy formats (AN1)', () => {
  it('footnotes only the markers the answer uses', () => {
    const out = withFootnotes('It has a COP of 3 [1]. See [x](http://a.b).', cites);
    expect(out).toContain('[^1]');
    expect(out).toContain('[^1]: Heat pump guide, p. 4. "COP of 3"');
    expect(out).not.toContain('Unused');
    expect(out).toContain('[x](http://a.b)');
  });

  it('turns Markdown into plain text, keeping code as it is', () => {
    const plain = markdownToPlain(
      '# Title\n\n**Bold** and `code` and [a link](https://x.y)\n\n- one\n- two\n\n```js\nconst a = **1**;\n```',
    );
    expect(plain).toBe('Title\n\nBold and code and a link (https://x.y)\n\n- one\n- two\n\nconst a = **1**;');
  });

  it('never lets answer text become markup', () => {
    const html = markdownToHtml('<script>alert(1)</script> and [bad](javascript:alert(1)) and **ok**');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('<strong>ok</strong>');
  });

  it('builds each form, rich with HTML too', () => {
    const a = { text: 'Hi **there** [1]', citations: cites };
    expect(clipboardFor(a, 'markdown')).toEqual({ text: 'Hi **there** [1]' });
    expect(clipboardFor(a, 'plain').text).toBe('Hi there [1]');
    expect(clipboardFor(a, 'sources').text).toContain('[^1]: Heat pump guide');
    expect(clipboardFor(a, 'rich').html).toContain('<strong>there</strong>');
  });

  it('reads sources from citation parts, naming a removed one', () => {
    const parts: Part[] = [
      {
        type: 'citation_ref',
        marker: 1,
        chunk_id: 'c',
        source_id: 's',
        char_start: 0,
        char_end: 1,
        quote: 'q',
      },
    ];
    expect(citationsOf({ parts })[0]?.title).toBe('A source that has since been removed');
  });
});

describe('export (EX3)', () => {
  const call: Part = { type: 'tool_call', call_id: 'c1', tool: 'fs_read', args: { path: 'a.md' } };
  const result: Part = { type: 'tool_result', call_id: 'c1', ok: true, result: 'hello' };
  const thread = {
    title: 'Heat pumps',
    messages: [
      msg('u1', 'user', [text('Which heat pump?')]),
      msg(
        'a1',
        'assistant',
        [
          { type: 'reasoning', text: 'secret thoughts' },
          call,
          result,
          text('Get one with a COP of 3 [1].'),
          {
            type: 'citation_ref',
            marker: 1,
            chunk_id: 'c',
            source_id: 's',
            char_start: 0,
            char_end: 1,
            quote: 'COP of 3',
            source_title: 'Heat pump guide',
          },
          { type: 'image', url: '/api/v1/images/x', mime: 'image/png', alt: 'a chart' },
        ],
        { usage: { tokens: 1200, costUsd: 0.0123, ms: 3400 } },
      ),
    ],
  };

  it('writes sources as footnotes, steps folded, and leaves thinking out unless asked', () => {
    const md = exportMarkdown(thread);
    expect(md).toContain('# Heat pumps');
    expect(md).toContain('## You');
    expect(md).toContain('[^a2-1]');
    expect(md).toContain('[^a2-1]: Heat pump guide');
    expect(md).toContain('<summary>Tool steps (1)</summary>');
    expect(md).toContain('*(image: a chart)*');
    expect(md).not.toContain('secret thoughts');
    expect(md).not.toContain('Receipt:');
    const full = exportMarkdown(thread, { thinking: true, steps: false, receipts: true, sources: false });
    expect(full).toContain('secret thoughts');
    expect(full).not.toContain('Tool steps');
    expect(full).toContain('Receipt: ');
    expect(full).not.toContain('[^');
  });

  it('counts the steps past the limit instead of listing hundreds', () => {
    const calls: Part[] = Array.from({ length: MAX_STEPS + 5 }, (_, i) => ({
      type: 'tool_call' as const,
      call_id: `k${i}`,
      tool: 'fs_read',
      args: {},
    }));
    const md = exportMarkdown({ title: 't', messages: [msg('a', 'assistant', [...calls, text('done')])] });
    expect(md).toContain(`Tool steps (${MAX_STEPS})`);
    expect(md).toContain('5 more tool steps are not listed');
  });

  it('makes a page that prints, with nothing from the answer run', () => {
    const html = exportHtml({
      title: 'A <b>title</b>',
      messages: [msg('u', 'user', [text('<img src=x onerror=alert(1)>')])],
    });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('@media print');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
    expect(html).toContain('A &lt;b&gt;title&lt;/b&gt;');
    expect(exportName('A/B: c?', 'md')).toBe('AB c.md');
  });
});

describe('find in a thread (TS2)', () => {
  const messages = [
    msg('u1', 'user', [text('Tell me about zebras')]),
    msg('a1', 'assistant', [
      { type: 'reasoning', text: 'zebras have stripes' },
      { type: 'tool_call', call_id: 'c1', tool: 'web_search', args: { q: 'zebra stripes' } },
      { type: 'tool_result', call_id: 'c1', ok: true, result: { text: 'Zebra facts' } },
      text('Zebras are striped. A zebra herd is a dazzle.'),
    ]),
  ];

  it('finds words in text, thinking and folded tool steps, in reading order', () => {
    const hits = findInThread(messages, 'zebra');
    expect(hits.map((h) => [h.messageId, h.where])).toEqual([
      ['u1', 'text'],
      ['a1', 'thinking'],
      ['a1', 'tool'],
      ['a1', 'tool'],
      ['a1', 'text'],
      ['a1', 'text'],
    ]);
    expect(hits.find((h) => h.where === 'tool')?.callId).toBe('c1');
    expect(hits.filter((h) => h.where === 'text' && h.messageId === 'a1').map((h) => h.nth)).toEqual([0, 1]);
  });

  it('matches code in answers and ignores case, and finds nothing for nothing', () => {
    expect(findInThread([msg('a', 'assistant', [text('```py\nPRINT(1)\n```')])], 'print(')).toHaveLength(1);
    expect(findInThread(messages, '')).toEqual([]);
    expect(findInThread(messages, 'qqq')).toEqual([]);
    expect(occurrences('aaaa', 'aa')).toBe(2);
  });

  it('steps and wraps, and keeps the match you are on while an answer streams', () => {
    expect(stepIndex(-1, 3, 1)).toBe(0);
    expect(stepIndex(-1, 3, -1)).toBe(2);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(0, 0, 1)).toBe(-1);
    const before = findInThread(messages, 'zebra');
    const prev = before[4];
    const grown = [
      ...messages.slice(0, 1),
      { ...(messages[1] as MessageView), parts: [...(messages[1]?.parts ?? []), text(' More zebra.')] },
    ];
    const now = findInThread(grown, 'zebra');
    expect(now.length).toBe(before.length + 1);
    expect(keepActive(prev, now)).toBe(4);
  });
});

describe('code block actions (AN3)', () => {
  it('knows what can run and what to call a saved file', () => {
    expect(isPython('python')).toBe(true);
    expect(isPython('py')).toBe(true);
    expect(isPython('js')).toBe(false);
    expect(isMermaid('Mermaid')).toBe(true);
    expect(defaultFileName('typescript')).toBe('snippet.ts');
    expect(defaultFileName(null)).toBe('snippet.txt');
  });

  it('refuses names that leave the workspace or break a path', () => {
    expect(fileNameProblem('')).not.toBeNull();
    expect(fileNameProblem('../x.py')).not.toBeNull();
    expect(fileNameProblem('a:b.py')).not.toBeNull();
    expect(fileNameProblem('src/ok.py')).toBeNull();
    expect(fileNameProblem('C:\\work\\ok.py')).toBeNull();
  });

  it('asks for a run in a fence that the code cannot close', () => {
    const ask = runRequest('print("```")\n');
    expect(ask).toContain('````python');
    expect(ask.endsWith('````')).toBe(true);
  });
});

describe('selection actions (AN2)', () => {
  it('quotes every line and cuts very long text at a word', () => {
    expect(quoteBlock('one\n\ntwo')).toBe('> one\n>\n> two');
    const long = quoteBlock(`${'word '.repeat(600)}`, 100);
    expect(long.length).toBeLessThan(110);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('the run timeline (CH4)', () => {
  const parts: Part[] = [
    { type: 'tool_call', call_id: 'a', tool: 'fs_write', args: { path: '/w/a.ts' } },
    { type: 'tool_result', call_id: 'a', ok: true, result: '', duration_ms: 400 },
    { type: 'tool_call', call_id: 'b', tool: 'fs_write', args: { path: '/w/a.ts' } },
    { type: 'tool_result', call_id: 'b', ok: true, result: '' },
    { type: 'tool_call', call_id: 'c', tool: 'fs_write', args: { path: '/w/c.ts' } },
    { type: 'tool_result', call_id: 'c', ok: false, result: 'no' },
    { type: 'tool_call', call_id: 'd', tool: 'fs_read', args: { path: '/w/d.ts' } },
    { type: 'tool_result', call_id: 'd', ok: true, result: 'x' },
    text('done'),
  ];
  const usageCall = (started_ms: number, stop: 'tool_calls' | 'end') => ({
    model_id: 'm/one',
    started_ms,
    ms: 1_000,
    input_tokens: 20_000,
    cached_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 1_000,
    cost_usd: 0.01,
    stop,
  });

  it('counts only changes that worked, once per file', () => {
    expect(changedFiles(parts)).toEqual(['/w/a.ts']);
  });

  it('carries start, status, call id and tokens on each step', () => {
    const steps = buildSteps({
      calls: [usageCall(0, 'tool_calls'), usageCall(60_000, 'end')],
      parts,
      recovered: [],
      priced: false,
    });
    const tool = steps.find((s) => s.callId === 'c');
    expect(tool?.status).toBe('failed');
    expect(steps.find((s) => s.callId === 'a')?.status).toBe('ok');
    expect(steps.find((s) => s.id === 'call-1')?.atMs).toBe(60_000);
    expect(steps.find((s) => s.id === 'call-0')?.tokens).toBe(21_000);
  });

  it('sums the turn up in one line', () => {
    const steps = buildSteps({
      calls: [usageCall(0, 'tool_calls'), usageCall(99_000, 'end')],
      parts,
      recovered: [],
      priced: false,
    });
    expect(turnSummary(steps, { parts })).toBe('Ran 6 steps in 1m 40s, changed 1 file, 42k tokens');
    expect(turnSummary([], { parts: [text('hi')] })).toBeNull();
    expect(spanWords(100_000)).toBe('1m 40s');
    expect(spanWords(3_900_000)).toBe('1h 05m');
    expect(tokenWords(41_200)).toBe('41k tokens');
    expect(tokenWords(900)).toBe('900 tokens');
  });
});
