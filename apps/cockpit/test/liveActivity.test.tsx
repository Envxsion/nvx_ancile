/**
 * Live activity: tool steps lead with what they are doing, every opened step
 * shows its input and result (or why there is none), web search results read
 * as a list, blank text leaves no gaps, and the live footer says the phase.
 */
import type { Message, Part, RunEvent } from '@nvx/contracts';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { toMessageViews } from '../src/lib/mappers';
import { fold, type LiveTurn } from '../src/lib/run';
import { livePhase, liveTokens, shortCount } from '../src/thread/LiveFooter';
import { costText } from '../src/thread/Message';
import { Parts } from '../src/thread/Parts';
import { loadToolStepCards } from '../src/thread/ToolStepLazy';
import { elapsed, ToolCwd } from '../src/thread/ToolSteps';

// The step cards load on demand in the app; here they are in before the first render.
await loadToolStepCards();

const call = (id: string, tool: string, args: unknown): Part => ({
  type: 'tool_call',
  call_id: id,
  tool,
  args,
});
const ok = (id: string, result: unknown): Part => ({ type: 'tool_result', call_id: id, ok: true, result });

/** Open every folded section so bodies draw (they draw only once opened). */
function unfold(container: HTMLElement) {
  const done = new Set<Element>();
  for (let round = 0; round < 6; round++) {
    const fresh = [...container.querySelectorAll('details')].filter((d) => !done.has(d));
    if (!fresh.length) return;
    for (const d of fresh) {
      done.add(d);
      const was = d.open;
      d.open = true;
      fireEvent(d, new Event('toggle'));
      d.open = was;
    }
  }
}

function parts(ps: Part[], opts: { streaming?: boolean; waiting?: boolean } = {}) {
  const r = render(
    <ToolCwd.Provider value="/home/me/proj">
      <Parts parts={ps} streaming={!!opts.streaming} waiting={!!opts.waiting} />
    </ToolCwd.Provider>,
  );
  unfold(r.container);
  return r;
}

const label = (c: HTMLElement) =>
  [...c.querySelectorAll('.tool-step > summary')].map((s) =>
    (s.querySelector('.tool-step__label')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );

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
    created_at: new Date().toISOString(),
    ...p,
  } as Message;
}
const cc = { claude_code: { session_id: 's', uuid: 'u', uuids: ['u'] } };

const search = (id: string) => call(id, 'WebSearch', { query: 'AI tutoring LMS market' });
const HITS =
  'Web search results for query: "AI tutoring LMS market"\n\nLinks: [{"title":"Tutoring at scale","url":"https://example.com/a"},{"title":"LMS \\"guide\\"","url":"https://docs.example.org/b"}]\n\nA short summary of what was found.';

describe('web search steps', () => {
  it('waiting on you: shows the query and says why there is no result yet', () => {
    const { container } = parts([search('w1')], { streaming: true, waiting: true });
    const step = container.querySelector('.tool-step');
    expect(step).toHaveAttribute('data-state', 'waiting');
    expect(step?.querySelector('.tool-step__body')?.textContent).toContain('AI tutoring LMS market');
    expect(step?.querySelector('.tstep__pending')?.textContent).toBe('Waiting for your decision.');
  });

  it('still running: says there is no result yet', () => {
    const { container } = parts([search('w0')], { streaming: true });
    expect(container.querySelector('.tstep__pending')?.textContent).toBe('No result yet.');
  });

  it('done: the results as titles and links, with the raw text one click away', () => {
    const { container } = parts([search('w2'), ok('w2', HITS)]);
    const links = [...container.querySelectorAll('.web-hits a')];
    expect(links.map((a) => a.textContent)).toEqual(['Tutoring at scale', 'LMS "guide"']);
    expect(links[1]).toHaveAttribute('href', 'https://docs.example.org/b');
    expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer');
    expect(container.querySelector('.tool-step__body')?.textContent).not.toContain('"url"');
    fireEvent.click(screen.getByRole('button', { name: 'Show raw' }));
    expect(container.querySelector('.tool-step__body pre')?.textContent).toContain('Links: [');
    expect(screen.getByRole('button', { name: 'Show the list' })).toBeInTheDocument();
  });

  it("the API's own web_search result reads the same way", () => {
    const { container } = parts([
      call('s1', 'web_search', { query: 'nvx' }),
      ok('s1', '{"title":"One","url":"https://one.example"}\n{"title":"Two","url":"https://two.example"}'),
    ]);
    expect(label(container)).toEqual(["Searched the web for 'nvx'"]);
    expect([...container.querySelectorAll('.web-hits a')].map((a) => a.textContent)).toEqual(['One', 'Two']);
  });

  it('a result that came as a list of text blocks still lists its links', () => {
    const { container } = parts([search('w4'), ok('w4', [{ type: 'text', text: HITS }])]);
    expect(container.querySelectorAll('.web-hits a')).toHaveLength(2);
  });
});

describe('every step says what it does and shows its detail', () => {
  it('a described command leads with its description, the command muted under it', () => {
    const { container } = parts([
      call('b1', 'Bash', { command: 'ls -la src/mpass', description: 'Reading M-Pass data models' }),
      ok('b1', 'a.ts'),
    ]);
    expect(label(container)).toEqual(['Reading M-Pass data models']);
    expect(container.querySelector('.tool-step__cmd')?.textContent).toBe('ls -la src/mpass');
  });

  it('a step whose result never came says so, with its input', () => {
    const { container } = parts([call('r9', 'Read', { file_path: '/home/me/proj/a.ts' })]);
    const body = container.querySelector('.tool-step__body');
    expect(body?.querySelector('.code__lang')?.textContent).toBe('Input');
    expect(body?.querySelector('.tstep__pending')?.textContent).toBe('No result was recorded for this step.');
  });

  it('a live step counts its seconds', () => {
    const { container } = render(
      <Parts parts={[call('t1', 'Bash', { command: 'sleep 3' })]} streaming waiting={false} />,
    );
    // Without a run in the store there is no clock: nothing is invented.
    expect(container.querySelector('.tool-step__time')).toBeNull();
    expect(elapsed(3_400)).toBe('3s');
    expect(elapsed(87_000)).toBe('1m 27s');
    expect(elapsed(3_840_000)).toBe('1h 4m');
  });
});

describe('no gaps, and text in order', () => {
  it('blank text between steps leaves no gap and does not split the run', () => {
    const steps = Array.from({ length: 5 }, (_, i) => [
      call(`b${i}`, 'Bash', { command: `echo ${i}` }),
      ok(`b${i}`, `${i}`),
      { type: 'text', text: '\n\n' } as Part,
    ]).flat();
    const { container } = parts(steps);
    expect(container.querySelectorAll('details.tool-group')).toHaveLength(1);
    expect(container.querySelectorAll('.md')).toHaveLength(0);
  });

  it('interim text stays between the steps it came between', () => {
    const { container } = parts([
      { type: 'text', text: "I'll map the code first." },
      call('i1', 'Grep', { pattern: 'Pass' }),
      ok('i1', 'Found 0 files'),
      { type: 'text', text: 'Now the models.' },
      call('i2', 'Read', { file_path: '/home/me/proj/m.ts' }),
      ok('i2', '     1→x'),
    ]);
    const order = [...container.querySelectorAll('.msg-text, .md, .tool-step')]
      .filter((el) => !el.parentElement?.closest('.tool-step, .md'))
      .map((el) => (el.classList.contains('tool-step') ? 'step' : 'text'));
    expect(order).toEqual(['text', 'step', 'text', 'step']);
  });

  it('a result Claude Code put in a message of its own joins the step it belongs to', () => {
    const views = toMessageViews([
      message({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Look it up' }] }),
      message({ id: 'a1', role: 'assistant', parent_id: 'u1', parts: [search('w3')], provenance: cc }),
      message({
        id: 'a2',
        role: 'assistant',
        parent_id: 'a1',
        parts: [ok('w3', HITS), { type: 'text', text: '' }],
        provenance: cc,
      }),
    ]);
    const drawn = views.filter((v) => !v.folded);
    expect(drawn.map((v) => v.id)).toEqual(['u1', 'a1']);
    expect(drawn[1]?.parts?.some((p) => p.type === 'tool_result' && p.call_id === 'w3')).toBe(true);
  });
});

describe('the live run', () => {
  const blank: LiveTurn = {
    runId: 'r',
    threadId: 't',
    messageId: 'm',
    parts: [],
    status: 'running',
    modelId: null,
    modelName: null,
    fallback: null,
    waking: null,
    approvalId: null,
    approvals: {},
    error: null,
    done: false,
    lastSeq: 0,
    startedAt: null,
    calls: {},
    streamedChars: 0,
    reportedTokens: null,
    activity: null,
  };
  let seq = 0;
  const at = (s: number) => new Date(Date.UTC(2026, 9, 13, 12, 0, s)).toISOString();
  const ev = (e: Record<string, unknown>, s: number) => ({ seq: ++seq, at: at(s), ...e }) as RunEvent;

  it('folds interim text, steps and their clocks in the order they came', () => {
    let t = blank;
    t = fold(t, ev({ type: 'text.delta', message_id: 'm', delta: "I'll map the code." }, 0));
    t = fold(
      t,
      ev(
        { type: 'tool.call', call_id: 'c1', tool: 'Bash', args_preview: { command: 'ls' }, tier: 'auto' },
        1,
      ),
    );
    expect(livePhase(t, false)).toBe('Running ls');
    t = fold(t, ev({ type: 'tool.result', call_id: 'c1', ok: true, preview: 'a' }, 4));
    t = fold(t, ev({ type: 'text.delta', message_id: 'm', delta: 'Done.' }, 5));
    expect(t.parts.map((p) => p.type)).toEqual(['text', 'tool_call', 'tool_result', 'text']);
    expect(t.calls.c1).toEqual({ start: at(1), end: at(4) });
    expect(t.startedAt).toBe(at(0));
    expect(livePhase(t, false)).toBe('Writing');
    expect(liveTokens(t)).toBe(Math.round("I'll map the code.Done.".length / 4));
  });

  it('says when it runs hooks, and when it waits for you', () => {
    let t = fold(blank, ev({ type: 'activity', phase: 'hooks', detail: 'Running PostToolUse hooks' }, 0));
    expect(livePhase(t, false)).toBe('Running PostToolUse hooks');
    t = fold(t, ev({ type: 'activity', phase: null }, 1));
    expect(livePhase(t, false)).toBe('Thinking');
    expect(livePhase(t, true)).toBe('Waiting for your decision');
    expect(shortCount(2_100)).toBe('2.1k');
  });

  it('a Claude Code answer with no metered cost says the plan covers it', () => {
    expect(costText(0, 'claude-code/claude-opus-5-5')).toBe('Included in your Claude plan');
    expect(costText(0, 'openai/gpt')).not.toBe('Included in your Claude plan');
  });
});
