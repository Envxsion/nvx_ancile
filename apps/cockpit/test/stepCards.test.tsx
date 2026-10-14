/**
 * Steps as live cards: each card says its family (a command, an MCP tool,
 * a subagent, any other tool) by its icon and rule, counts its seconds on
 * one shared clock while it runs, says how long it took once done (the
 * saved duration, or the live clock) and what came back in one short line.
 * The "Working now" strip lists every step running, parallel calls too,
 * for Ancile's own turns and Claude Code's alike.
 */
import type { ClaudeCodeLiveState, Part, RunEvent } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { CcLiveLine } from '../src/claudecode/LiveBar';
import { queryClient } from '../src/lib/query';
import { between, fold, type LiveTurn, type StepClock, useRuns } from '../src/lib/run';
import { LiveFooter, livePhase } from '../src/thread/LiveFooter';
import { Parts } from '../src/thread/Parts';
import {
  familyOf,
  oneLine,
  resultLine,
  type ToolCall,
  type ToolResult,
  ToolStep,
  took,
  valueLine,
} from '../src/thread/ToolSteps';
import { nowWords, workingNow } from '../src/thread/WorkingNow';

const call = (id: string, tool: string, args: unknown): ToolCall => ({
  type: 'tool_call',
  call_id: id,
  tool,
  args,
});
const ok = (id: string, result: unknown, extra: Partial<ToolResult> = {}): ToolResult => ({
  type: 'tool_result',
  call_id: id,
  ok: true,
  result,
  ...extra,
});
const failed = (id: string, result: unknown): ToolResult => ({
  type: 'tool_result',
  call_id: id,
  ok: false,
  result,
});

const blank: LiveTurn = {
  runId: 'r',
  threadId: 'thr_1',
  messageId: 'm1',
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

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const step = (c: ToolCall, r: ToolResult | undefined, extra: { clock?: StepClock; live?: boolean } = {}) =>
  render(<ToolStep call={c} result={r} waiting={false} folded {...extra} />);
const card = (c: HTMLElement) => c.querySelector('.tool-step') as HTMLElement;
const time = (c: HTMLElement) => c.querySelector('.tool-step__time')?.textContent ?? null;
const detail = (c: HTMLElement) => c.querySelector('.tool-step__detail')?.textContent ?? null;

beforeEach(() => {
  useRuns.setState({ turns: {} });
  queryClient.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* ---- Families --------------------------------------------------------------- */

describe('each card says what kind of step it is', () => {
  it('a command, an MCP tool, a subagent and any other tool read apart, not by colour alone', () => {
    const cases: [ToolCall, string, string][] = [
      [call('b', 'Bash', { command: 'ls' }), 'command', 'Command'],
      [call('p', 'PowerShell', { command: 'dir' }), 'command', 'Command'],
      [call('m', 'mcp__github__create_issue', { title: 'Bug' }), 'mcp', 'MCP tool'],
      [call('a', 'Task', { description: 'Look around', prompt: 'Go' }), 'agent', 'Subagent'],
      [call('r', 'Read', { file_path: '/a.ts' }), 'tool', 'Tool'],
      [call('x', 'Frobnicate', {}), 'tool', 'Tool'],
    ];
    for (const [c, family, word] of cases) {
      const { container, unmount } = step(c, ok(c.call_id, 'x'));
      expect(card(container)).toHaveAttribute('data-family', family);
      // The icon carries the family's name, so the rule's colour is never the only sign.
      expect(container.querySelector('.tool-step__icon')).toHaveAttribute('aria-label', word);
      unmount();
    }
    expect(familyOf('python')).toBe('command');
    expect(familyOf('monitor')).toBe('command');
    expect(familyOf('grep')).toBe('tool');
  });

  it('an MCP card keeps its server badge and tool name', () => {
    const { container } = step(call('m1', 'mcp__github__create_issue', {}), ok('m1', '{}'));
    expect(container.querySelector('.tool-step__badge')?.textContent).toBe('github');
    expect(container.querySelector('.tool-step__target')?.textContent).toBe('create_issue');
  });
});

/* ---- Time ------------------------------------------------------------------- */

describe('how long a step took', () => {
  it('reads as a person reads it', () => {
    expect(took(40)).toBe('<0.1s');
    expect(took(400)).toBe('0.4s');
    expect(took(3_240)).toBe('3.2s');
    // Rounding up to ten seconds does not read "10.0s" or fall back to "9s".
    expect(took(9_960)).toBe('10s');
    expect(took(12_400)).toBe('12s');
    expect(took(87_400)).toBe('1m 27s');
    expect(took(-5)).toBe('');
    expect(took(Number.NaN)).toBe('');
  });

  it('a finished step shows the duration its result carries', () => {
    const { container } = step(
      call('b1', 'Bash', { command: 'pnpm test' }),
      ok('b1', 'ok', { duration_ms: 3_240 }),
    );
    expect(time(container)).toBe('Took 3.2s');
    expect(container.querySelector('.tool-step__time')).toHaveAttribute('title', 'Took 3.2s');
    expect(card(container)).toHaveAttribute('data-state', 'ok');
  });

  it('a failed one too, beside its warning', () => {
    const { container } = step(call('b2', 'Bash', { command: 'pnpm test' }), {
      ...failed('b2', 'Exit code 1\nboom'),
      duration_ms: 4_000,
    });
    expect(time(container)).toBe('Took 4.0s');
    expect(card(container)).toHaveAttribute('data-state', 'failed');
    expect(container.querySelector('.tool-step__status')?.textContent).toBe('Failed');
  });

  it('a step still on screen from its live run falls back to its clock', () => {
    const { container } = step(call('r1', 'Read', { file_path: '/a.ts' }), ok('r1', '     1→x'), {
      clock: { start: ago(2_500), end: ago(0) },
    });
    expect(time(container)).toBe('Took 2.5s');
  });

  it('an older message with no duration and no clock shows none rather than a guess', () => {
    const { container } = step(call('r2', 'Read', { file_path: '/a.ts' }), ok('r2', '     1→x'));
    expect(container.querySelector('.tool-step__time')).toBeNull();
  });

  it('a running step counts its seconds from its live clock', () => {
    vi.useFakeTimers({ now: NOW });
    const { container } = step(call('b3', 'Bash', { command: 'sleep 9' }), undefined, {
      clock: { start: ago(3_000), end: null },
      live: true,
    });
    expect(card(container)).toHaveAttribute('data-state', 'running');
    expect(time(container)).toBe('Running for 3s');
    act(() => vi.advanceTimersByTime(2_000));
    expect(time(container)).toBe('Running for 5s');
  });

  it('every timer on screen ticks on one shared clock, which stops when none is left', () => {
    vi.useFakeTimers({ now: NOW });
    const every = vi.spyOn(globalThis, 'setInterval');
    const stop = vi.spyOn(globalThis, 'clearInterval');
    const ids = ['s1', 's2', 's3'];
    useRuns.setState({
      turns: {
        m1: {
          ...blank,
          calls: Object.fromEntries(ids.map((id, i) => [id, { start: ago(1_000 * (i + 1)), end: null }])),
        },
      },
    });
    const parts: Part[] = ids.map((id) => call(id, 'Bash', { command: `echo ${id}` }));
    const { container, unmount } = render(<Parts parts={parts} streaming waiting={false} messageId="m1" />);
    expect([...container.querySelectorAll('.tool-step__time')].map((t) => t.textContent)).toEqual([
      'Running for 1s',
      'Running for 2s',
      'Running for 3s',
    ]);
    expect(every).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1_000));
    expect(container.querySelector('.tool-step__time')?.textContent).toBe('Running for 2s');
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

/* ---- What came back ----------------------------------------------------------- */

describe('what came back, in one line', () => {
  const line = (c: ToolCall, r: ToolResult, state: 'ok' | 'failed' = r.ok ? 'ok' : 'failed') =>
    resultLine(c, r, state);

  it('a read says how many lines, unless the line already says which', () => {
    expect(line(call('r', 'Read', { file_path: '/a' }), ok('r', '     1→a\n     2→b\n'))).toBe('2 lines');
    expect(line(call('r', 'Read', { file_path: '/a' }), ok('r', '     1→a'))).toBe('1 line');
    expect(line(call('r', 'Read', { file_path: '/a' }), ok('r', ''))).toBe('Empty file');
    expect(line(call('r', 'Read', { file_path: '/a', offset: 10, limit: 20 }), ok('r', 'x\ny'))).toBeNull();
    // An image or a PDF read is not lines.
    expect(line(call('r', 'Read', { file_path: '/a.png' }), ok('r', [{ type: 'image' }]))).toBeNull();
  });

  it('a command: the first line it printed, without colour codes, or that it printed nothing', () => {
    const esc = String.fromCharCode(27);
    const sh = call('b', 'Bash', { command: 'pnpm test' });
    expect(line(sh, ok('b', `\n${esc}[32m✓ 12 passed${esc}[0m\nmore`))).toBe('✓ 12 passed');
    expect(line(sh, ok('b', ''))).toBe('No output');
    expect(line(sh, failed('b', 'Exit code 2\nFAIL one test\nmore'))).toBe('FAIL one test');
  });

  it('never the result itself: one line, clipped, with control characters gone', () => {
    const long = `${'x'.repeat(500)}\nsecond`;
    const one = oneLine(long) ?? '';
    expect(one.length).toBe(90);
    expect(one.endsWith('…')).toBe(true);
    expect(oneLine(`a${String.fromCharCode(7)}b\tc`)).toBe('a b c');
    expect(oneLine('\n\n   \n')).toBeNull();
    // A huge result costs no more than its head.
    const huge = `${'y'.repeat(2_000_000)}`;
    expect(line(call('b', 'Bash', { command: 'cat big' }), ok('b', huge))?.length).toBe(90);
  });

  it('web results as a count, a page and a report as their first words', () => {
    const hits = 'Links: [{"title":"A","url":"https://a.example"},{"title":"B","url":"https://b.example"}]';
    expect(line(call('s', 'WebSearch', { query: 'q' }), ok('s', hits))).toBe('2 results');
    expect(line(call('f', 'WebFetch', { url: 'https://x' }), ok('f', '## The limit is **10**.\nmore'))).toBe(
      'The limit is 10.',
    );
    expect(line(call('a', 'Task', { prompt: 'p' }), ok('a', '- Found `three` bugs\n- More'))).toBe(
      'Found three bugs',
    );
  });

  it('an MCP tool: its text, a list as a count, an object as its first fields', () => {
    const mcp = call('m', 'mcp__github__create_issue', {});
    expect(line(mcp, ok('m', '{"number":42,"url":"https://github.com/x/y/issues/42","labels":[]}'))).toBe(
      'number: 42 · url: https://github.com/x/y/issues/42',
    );
    expect(line(mcp, ok('m', [{ type: 'text', text: 'Created issue #42\nmore' }]))).toBe('Created issue #42');
    expect(line(mcp, ok('m', { content: [{ type: 'text', text: 'Done' }], isError: false }))).toBe('Done');
    expect(line(mcp, ok('m', '[1,2,3]'))).toBe('3 items');
    expect(line(mcp, ok('m', []))).toBe('Nothing came back');
    expect(valueLine({ nested: { a: 1 }, more: [1] })).toBe('2 fields');
    expect(valueLine({})).toBeNull();
    expect(valueLine(true)).toBe('true');
  });

  it('nothing where the line already says it, or for a declined step', () => {
    expect(line(call('g', 'Grep', { pattern: 'x' }), ok('g', 'Found 2 files\na\nb'))).toBeNull();
    expect(line(call('e', 'Edit', { file_path: '/a' }), ok('e', 'The file has been updated.'))).toBeNull();
    expect(
      resultLine(
        call('w', 'WebFetch', {}),
        { ...failed('w', 'declined'), declined_reason: 'not now' },
        'declined',
      ),
    ).toBeNull();
    expect(resultLine(call('w', 'Bash', {}), undefined, 'running')).toBeNull();
  });

  it('shows on the card of a step that went fine', () => {
    const { container } = step(call('b', 'Bash', { command: 'pnpm -s typecheck' }), ok('b', 'All good\n'));
    expect(detail(container)).toBe('All good');
    expect(container.querySelector('.tool-step__detail')).toHaveAttribute('title', 'All good');
  });
});

/* ---- The live run ---------------------------------------------------------------- */

describe('the live run keeps what the cards and the strip need', () => {
  let seq = 0;
  const ev = (e: Record<string, unknown>, at: string) => ({ seq: ++seq, at, ...e }) as RunEvent;
  const callEv = (id: string, tool: string, args: unknown, at: string, title?: string) =>
    ev(
      { type: 'tool.call', call_id: id, tool, args_preview: args, tier: 'auto', ...(title && { title }) },
      at,
    );

  it("keeps the call's own words and gives the result its duration", () => {
    let t = fold(blank, callEv('c1', 'Bash', { command: 'pnpm test' }, ago(4_000), 'Run the tests'));
    expect(t.calls.c1).toEqual({ start: ago(4_000), end: null, title: 'Run the tests' });
    t = fold(t, ev({ type: 'tool.result', call_id: 'c1', ok: true, preview: 'ok' }, ago(750)));
    expect(t.calls.c1).toEqual({ start: ago(4_000), end: ago(750), title: 'Run the tests' });
    expect(t.parts.at(-1)).toMatchObject({ type: 'tool_result', call_id: 'c1', duration_ms: 3_250 });
  });

  it('a result whose call came before the stream was joined has no duration', () => {
    const t = fold(blank, ev({ type: 'tool.result', call_id: 'zz', ok: true, preview: 'ok' }, ago(0)));
    expect(t.parts.at(-1)).not.toHaveProperty('duration_ms');
    expect(between(undefined, ago(0))).toBeUndefined();
    expect(between(ago(0), ago(1_000))).toBeUndefined();
    expect(between(ago(1_000), ago(0))).toBe(1_000);
  });

  it('lists every step running now, parallel calls too, in the order they were called', () => {
    let t = fold(blank, callEv('a', 'Read', { file_path: '/src/app.ts' }, ago(3_000)));
    t = fold(t, callEv('b', 'mcp__github__list_issues', {}, ago(2_000)));
    t = fold(t, callEv('c', 'Bash', { command: 'pnpm test' }, ago(1_000), 'Run the tests'));
    t = fold(t, ev({ type: 'tool.result', call_id: 'a', ok: true, preview: 'x' }, ago(500)));
    t = {
      ...t,
      approvals: { b: 'apr_1' },
    };
    expect(workingNow(t)).toEqual([
      {
        callId: 'b',
        tool: 'mcp__github__list_issues',
        title: 'Using list_issues from github',
        start: ago(2_000),
        waiting: true,
      },
      { callId: 'c', tool: 'Bash', title: 'Run the tests', start: ago(1_000), waiting: false },
    ]);
    expect(nowWords(workingNow(t))).toBe('Using list_issues from github and 1 more');
    expect(livePhase({ ...t, approvals: {} }, false)).toBe('Running 2 steps at once');
    expect(workingNow({ ...t, done: true })).toEqual([]);
    expect(workingNow(undefined)).toEqual([]);
    expect(nowWords([])).toBeNull();
  });
});

/* ---- Working now -------------------------------------------------------------------- */

describe('the "Working now" strip', () => {
  const running = (n: number): LiveTurn => {
    const parts: Part[] = Array.from({ length: n }, (_, i) =>
      call(`c${i}`, i % 2 ? 'mcp__github__get_issue' : 'Bash', { command: `job ${i}` }),
    );
    return {
      ...blank,
      startedAt: ago(60_000),
      parts,
      calls: Object.fromEntries(
        parts.map((p, i) => [(p as ToolCall).call_id, { start: ago(1_000 * (i + 1)), end: null }]),
      ),
    };
  };

  it('lists the steps running now under "Working now", each with its family and its seconds', () => {
    vi.useFakeTimers({ now: NOW });
    useRuns.setState({ turns: { m1: running(2) } });
    const { container } = render(<LiveFooter messageId="m1" waiting={false} onStop={() => {}} />);
    expect(container.querySelector('.live-foot__phase')?.textContent).toBe('Working now');
    const list = screen.getByRole('list', { name: 'Working now' });
    const rows = [...list.querySelectorAll('.working-now__step')];
    expect(rows.map((r) => r.getAttribute('data-family'))).toEqual(['command', 'mcp']);
    expect(rows.map((r) => r.querySelector('.working-now__title')?.textContent)).toEqual([
      'Running job 0',
      'Using get_issue from github',
    ]);
    expect(rows[1]?.querySelector('.working-now__icon')).toHaveAttribute('aria-label', 'MCP tool');
    expect(rows.map((r) => r.querySelector('.working-now__time')?.textContent)).toEqual([
      'Running for 1s',
      'Running for 2s',
    ]);
    act(() => vi.advanceTimersByTime(3_000));
    expect(rows[0]?.querySelector('.working-now__time')?.textContent).toBe('Running for 4s');
    expect(container.querySelector('.live-foot__time')?.textContent).toBe('1m 3s');
    // A list, never a live region: the seconds are not announced as they tick.
    expect(container.querySelector('[aria-live]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it('a step waiting on you says so instead of counting', () => {
    useRuns.setState({ turns: { m1: { ...running(1), approvals: { c0: 'apr_1' }, approvalId: 'apr_1' } } });
    const { container } = render(<LiveFooter messageId="m1" waiting />);
    expect(container.querySelector('.live-foot__phase')?.textContent).toBe('Waiting for your decision');
    const row = container.querySelector('.working-now__step');
    expect(row).toHaveAttribute('data-state', 'waiting');
    expect(row?.querySelector('.working-now__wait')?.textContent).toBe('Waiting');
    expect(row?.querySelector('.working-now__time')).toBeNull();
  });

  it('many at once: the first four, and how many more', () => {
    useRuns.setState({ turns: { m1: running(6) } });
    const { container } = render(<LiveFooter messageId="m1" waiting={false} />);
    expect(container.querySelectorAll('.working-now__step')).toHaveLength(4);
    expect(container.querySelector('.working-now__more')?.textContent).toBe('and 2 more');
  });

  it('nothing running: no strip, and the line says the phase', () => {
    useRuns.setState({ turns: { m1: { ...blank, parts: [{ type: 'text', text: 'Hello' }] } } });
    const { container } = render(<LiveFooter messageId="m1" waiting={false} />);
    expect(container.querySelector('.working-now')).toBeNull();
    expect(container.querySelector('.live-foot__phase')?.textContent).toBe('Writing');
  });

  it("Claude Code's status line says what its turn is running", () => {
    const live: ClaudeCodeLiveState = {
      state: 'working',
      locked_elsewhere: false,
      model: 'opus',
      effort: 'high',
      permission_mode: 'default',
      cwd: '/home/me/cyberfolio',
      context: null,
    };
    const binding = { session_id: 's1', cwd: '/home/me/cyberfolio', last_uuid: null, synced_at: '' };
    useRuns.setState({ turns: { m1: running(3) } });
    const line = (l: ClaudeCodeLiveState) => (
      <QueryClientProvider client={queryClient}>
        <Tooltip.Provider>
          <CcLiveLine threadId="thr_1" binding={binding} live={l} last={undefined} />
        </Tooltip.Provider>
      </QueryClientProvider>
    );
    const { container, rerender } = render(line(live));
    const now = container.querySelector('.cc-live__now');
    expect(now?.textContent).toBe('Running job 0 and 2 more');
    // Outside the polite region: it changes with every step.
    expect(now?.closest('[aria-live]')).toBeNull();
    expect(screen.getByText('Working…')).toBeInTheDocument();
    rerender(line({ ...live, state: 'ready' }));
    expect(container.querySelector('.cc-live__now')).toBeNull();
  });
});
