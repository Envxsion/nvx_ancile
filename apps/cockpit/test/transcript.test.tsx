/**
 * Claude Code threads read better than the terminal: the context line is
 * slim and honest (and absent for Claude Code threads), Claude Code's own
 * events are quiet rows rather than bubbles, each tool reads as one line
 * that opens onto the right view, long runs fold into a group, thinking is
 * folded, raw HTML is text, and a long paste starts short.
 */
import type { Explain, Message, Part, PathBudget } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { CcEventRow } from '../src/claudecode/ThreadMarker';
import { api } from '../src/lib/api';
import { highlight } from '../src/lib/highlight';
import { toMessageViews } from '../src/lib/mappers';
import { queryClient } from '../src/lib/query';
import type { CcEvent, MessageView } from '../src/lib/types';
import { Retrieval } from '../src/receipt/Sections';
import { budgetWords, ComposerHints } from '../src/thread/ComposerHints';
import { Message as MessageRow } from '../src/thread/Message';
import { Parts } from '../src/thread/Parts';
import { stripGutter } from '../src/thread/ToolStepCards';
import { loadToolStepCards } from '../src/thread/ToolStepLazy';
import { displayPath, ToolCwd } from '../src/thread/ToolSteps';

// The step cards load on demand in the app; here they are in before the first render.
await loadToolStepCards();

const mocked = api as unknown as Record<'get' | 'post' | 'put' | 'patch' | 'del', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  queryClient.clear();
  for (const f of Object.values(mocked)) f.mockReset();
});

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

const cc = (extra: Record<string, unknown>) => ({ claude_code: { session_id: 's', uuid: 'u', ...extra } });

function budget(p: Partial<PathBudget>): PathBudget {
  return {
    head_id: 'm9',
    model_id: 'm',
    window: 200_000,
    used: { system: 1, memory: 0, retrieval: 0, history: 1, reserve_output: 1 },
    total: 204_000,
    ratio: 1.02,
    level: 'critical',
    compaction: null,
    compactable: 12,
    ...p,
  } as PathBudget;
}

/* ---- The context line ----------------------------------------------------- */

describe('the context line above the composer', () => {
  it('is not shown, and not even asked for, in a Claude Code thread', async () => {
    mocked.get.mockResolvedValue(budget({}));
    const { container } = wrap(<ComposerHints threadId="t1" headId="m9" fromClaudeCode={true} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(mocked.get).not.toHaveBeenCalled();
    expect(container.querySelector('.hint-line')).toBeNull();
  });

  it('is one slim line: a capped meter, "over" in words, Compact now and a labelled dismiss', async () => {
    mocked.get.mockResolvedValue(budget({ ratio: 1.02, level: 'critical' }));
    const { container } = wrap(<ComposerHints threadId="t1" headId="m9" fromClaudeCode={false} />);
    await screen.findByText('Over the context limit: compacts before the next answer');
    const meter = screen.getByRole('meter', { name: 'Context used' });
    expect(meter).toHaveAttribute('aria-valuenow', '100');
    expect(meter).toHaveAttribute('aria-valuetext', 'Over the limit');
    expect(container.querySelector('.hint-line')).toHaveAttribute('data-tone', 'over');
    expect(container.textContent).not.toMatch(/\d{3}%/);
    expect(screen.getByRole('button', { name: 'Compact now' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide the context warning' }));
    await waitFor(() => expect(container.querySelector('.hint-line')).toBeNull());
  });

  it('says "near" below the limit and never claims more than it knows', () => {
    expect(budgetWords({ ratio: 0.86, level: 'warn' })).toMatchObject({
      text: 'Near the context limit',
      tone: 'high',
    });
    expect(budgetWords({ ratio: 0.96, level: 'critical' }).text).toBe(
      'At the context limit: compacts before the next answer',
    );
    expect(budgetWords({ ratio: 1.7, level: 'critical' }).fill).toBe(1);
  });
});

/* ---- Claude Code's own events -------------------------------------------- */

describe("Claude Code's events are quiet rows, not bubbles", () => {
  const views = toMessageViews([
    message({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Fix it' }] }),
    message({
      id: 's1',
      role: 'system',
      parts: [],
      provenance: cc({ kind: 'compact_boundary' }),
    }),
    message({
      id: 's2',
      role: 'system',
      parts: [{ type: 'text', text: '## Summary\n\nWe fixed the **login** page.' }],
      provenance: cc({ kind: 'compact_summary' }),
    }),
    message({
      id: 'u2',
      role: 'user',
      parts: [{ type: 'text', text: '<command-name>/compact</command-name>' }],
      provenance: cc({
        kind: 'command',
        command: { name: '/compact', args: 'keep the tests', output: 'Compacted. ctrl+o to see' },
      }),
    }),
    message({
      id: 's3',
      role: 'system',
      parts: [{ type: 'text', text: 'The build **passed**.' }],
      provenance: cc({
        kind: 'notification',
        notification: {
          source: 'task',
          title: 'Background task finished',
          from: 'pnpm build',
          status: 'completed',
        },
      }),
    }),
    message({ id: 's4', role: 'system', parts: [], provenance: cc({ kind: 'interrupted' }) }),
    message({ id: 's5', role: 'system', parts: [{ type: 'text', text: 'hidden' }] }),
  ]);
  const ev = (id: string) => views.find((v) => v.id === id)?.cc as CcEvent;

  it('maps each kind, keeps prompts as prompts, and drops unmarked system turns', () => {
    expect(views.map((v) => v.id)).toEqual(['u1', 's1', 's2', 'u2', 's3', 's4']);
    expect(views[0]?.cc).toBeUndefined();
    expect(views.find((v) => v.id === 's1')?.compactBoundary).toBe(true);
    expect(ev('s2')).toMatchObject({ kind: 'compact_summary' });
    expect(ev('u2')).toMatchObject({ kind: 'command', name: '/compact', args: 'keep the tests' });
    expect(ev('s3')).toMatchObject({ kind: 'notification', source: 'task', from: 'pnpm build' });
    expect(ev('s4')).toEqual({ kind: 'interrupted' });
  });

  it('a compaction summary is a folded "What came before" under the divider', () => {
    const { container } = render(
      <>
        <CcEventRow e={ev('s1')} />
        <CcEventRow e={ev('s2')} />
      </>,
    );
    expect(screen.getByRole('separator', { name: 'Conversation compacted here' })).toBeInTheDocument();
    const before = screen.getByText('What came before').closest('details');
    expect(before).not.toHaveAttribute('open');
    expect(container.querySelector('.cc-before__body h2')?.textContent).toBe('Summary');
    expect(container.querySelector('.msg')).toBeNull();
  });

  it('a command is a chip row with its output folded, terminal style', () => {
    const { container } = render(<CcEventRow e={ev('u2')} />);
    expect(container.querySelector('.cc-cmd__name')?.textContent).toBe('/compact');
    expect(container.querySelector('.cc-cmd__args')?.textContent).toBe('keep the tests');
    const out = container.querySelector('details.cc-cmd');
    expect(out).not.toHaveAttribute('open');
    expect(container.querySelector('pre.cc-cmd__out')?.textContent).toBe('Compacted. ctrl+o to see');
  });

  it('a notice is one line by source, with its body as markdown when opened', () => {
    const { container } = render(<CcEventRow e={ev('s3')} />);
    expect(screen.getByText('Background task finished')).toBeInTheDocument();
    expect([...container.querySelectorAll('.cc-note__meta')].map((n) => n.textContent)).toEqual([
      'pnpm build',
      'completed',
    ]);
    expect(container.querySelector('details.cc-note')).not.toHaveAttribute('open');
    expect(container.querySelector('.cc-note__body')?.textContent).toContain('The build passed.');
  });

  it('an interruption is a tiny marker', () => {
    render(<CcEventRow e={ev('s4')} />);
    expect(screen.getByText('Stopped by you')).toBeInTheDocument();
  });

  it('The receipt says an answer brought in from the terminal has no citation record', () => {
    const base = {
      retrieval: null,
      retrieval_error: null,
    } as unknown as Explain;
    const { container, rerender } = wrap(<Retrieval x={{ ...base, origin: 'claude_code_import' }} />);
    expect(container.textContent).toContain('Written before import, no citation record');
    rerender(<Retrieval x={{ ...base, origin: 'claude_code_live' }} />);
    expect(container.textContent).not.toContain('Written before import');
  });

  it('entries this version cannot show are a quiet marker, and an answer holding one says so under it', () => {
    const [marker, answer] = toMessageViews([
      message({
        id: 'k1',
        role: 'system',
        parts: [{ type: 'text', text: "2 entries this version of NVX Ancile can't show yet" }],
        provenance: cc({ kind: 'unknown', unknown: { count: 2, types: ['tool-progress'] } }),
      }),
      message({
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Done.' }],
        provenance: cc({ unknown: { count: 1, types: ['hologram'] } }),
      }),
    ]);
    expect(marker?.cc).toEqual({ kind: 'unknown', count: 2 });
    const { container } = render(<CcEventRow e={marker?.cc as CcEvent} />);
    expect(container.querySelector('.cc-unknown')?.textContent).toBe(
      "2 entries this version of NVX Ancile can't show yet",
    );
    expect(answer?.cc).toBeUndefined();
    wrap(<MessageRow m={answer as MessageView} threadId="t1" selected={false} onSelect={() => {}} />);
    expect(screen.getByText("1 entry this version of NVX Ancile can't show yet")).toBeInTheDocument();
  });

  it('older imports without kinds still read: commands and interruptions from their text', () => {
    const old = toMessageViews([
      message({
        id: 'a',
        role: 'user',
        parts: [
          {
            type: 'text',
            text: '<command-message>model</command-message>\n<command-name>/model</command-name>\n<command-args>opus</command-args>',
          },
        ],
        provenance: cc({}),
      }),
      message({
        id: 'b',
        role: 'user',
        parts: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
        provenance: cc({}),
      }),
      message({
        id: 'c',
        role: 'user',
        parts: [{ type: 'text', text: 'A plain prompt' }],
        provenance: cc({}),
      }),
    ]);
    expect(old[0]?.cc).toEqual({ kind: 'command', name: '/model', args: 'opus', output: null });
    expect(old[1]?.cc).toEqual({ kind: 'interrupted' });
    expect(old[2]?.cc).toBeUndefined();
  });
});

/* ---- Tool steps ------------------------------------------------------------ */

const call = (id: string, tool: string, args: unknown): Part => ({
  type: 'tool_call',
  call_id: id,
  tool,
  args,
});
const ok = (id: string, result: unknown): Part => ({ type: 'tool_result', call_id: id, ok: true, result });
const failed = (id: string, result: unknown): Part => ({
  type: 'tool_result',
  call_id: id,
  ok: false,
  result,
});

/**
 * Folded steps draw their body only once opened (useOpened); open each one
 * once, as a reader would, then put it back as it was so the folded state
 * can still be checked.
 */
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

function parts(ps: Part[], cwd: string | null = '/home/me/proj') {
  const r = render(
    <ToolCwd.Provider value={cwd}>
      <Parts parts={ps} streaming={false} waiting={false} />
    </ToolCwd.Provider>,
  );
  unfold(r.container);
  return r;
}

const label = (c: HTMLElement) =>
  [...c.querySelectorAll('.tool-step > summary')].map((s) =>
    (s.querySelector('.tool-step__label')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );

describe('Claude Code tool steps', () => {
  it('Read: one line with the path from the session folder; code with a real gutter', () => {
    const { container } = parts([
      call('r1', 'Read', { file_path: '/home/me/proj/src/app.ts' }),
      ok(
        'r1',
        '     1→import { x } from "y";\n     2→const n = 1;\n\n<system-reminder>be good</system-reminder>',
      ),
    ]);
    expect(label(container)).toEqual(['Read src/app.ts']);
    expect(container.querySelector('.tool-step')).not.toHaveAttribute('open');
    const code = container.querySelector('.code__pre')?.textContent ?? '';
    expect(code).not.toContain('→');
    expect(code).not.toContain('system-reminder');
    expect([...container.querySelectorAll('.code__no')].map((n) => n.textContent)).toEqual(['1', '2']);
    expect(container.querySelector('.code__lang')?.textContent).toBe('TypeScript');
    expect(container.querySelector('.tok-kw')?.textContent).toBe('import');
  });

  it('a background shell is running until Activity says it ended, never done at launch', async () => {
    let shellState = 'running';
    mocked.get.mockImplementation(async (path: string) =>
      path === '/activity'
        ? {
            running: 1,
            import: null,
            items: [{ id: 'shell:s1:b1', kind: 'shell', state: shellState }],
          }
        : [],
    );
    const { container } = wrap(
      <ToolCwd.Provider value="/home/me/proj">
        <Parts
          parts={[
            call('b1', 'Bash', { command: 'pnpm dev', run_in_background: true }),
            ok('b1', 'Command running in background with ID: abc123'),
          ]}
          streaming={false}
          waiting={false}
        />
      </ToolCwd.Provider>,
    );
    const step = () => container.querySelector('.tool-step');
    await waitFor(() => expect(mocked.get).toHaveBeenCalledWith('/activity'));
    expect(step()).toHaveAttribute('data-state', 'running');
    expect(container.textContent).toContain('Running in the background');
    shellState = 'finished';
    await queryClient.invalidateQueries({ queryKey: ['activity'] });
    await waitFor(() => expect(step()).toHaveAttribute('data-state', 'ok'));
  });

  it('strips both gutter styles, and leaves text without one alone', () => {
    expect(stripGutter('    10\tfoo\n    11\tbar')).toEqual({ code: 'foo\nbar', numbers: [10, 11] });
    expect(stripGutter('just text\nmore').numbers).toBeNull();
    expect(displayPath('C:\\work\\proj\\a\\b.ts', 'C:\\work\\proj')).toBe('a/b.ts');
    expect(displayPath('/very/deep/path/to/some/file.ts', null)).toBe('…/to/some/file.ts');
  });

  it('Edit and MultiEdit: a diff from the arguments, with the count on the line', () => {
    const { container } = parts([
      call('e1', 'Edit', {
        file_path: '/home/me/proj/services/core/src/settings.ts',
        old_string: 'const a = 1;\nconst b = 2;',
        new_string: 'const a = 1;\nconst b = 3;\nconst c = 4;',
      }),
      ok('e1', 'The file has been updated.'),
      call('e2', 'MultiEdit', {
        file_path: '/home/me/proj/x.ts',
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'c', new_string: 'd' },
        ],
      }),
      ok('e2', 'ok'),
    ]);
    expect(label(container)).toEqual(['Edited services/core/src/settings.ts', 'Edited x.ts']);
    expect([...container.querySelectorAll('.tool-step__meta')].map((m) => m.textContent)).toEqual([
      '+2 −1',
      '+2 −2',
    ]);
    const diff = container.querySelector('.mem-diff');
    expect(diff).toHaveAttribute('data-numbered', 'false');
    expect(diff?.querySelector('[data-kind="del"]')?.textContent).toContain('const b = 2;');
    expect(diff?.querySelector('[data-kind="add"]')?.textContent).toContain('const b = 3;');
  });

  it('Bash: the command and its output in a terminal block, with the exit code when it failed', () => {
    const { container } = parts([
      call('b1', 'Bash', { command: 'pnpm -s typecheck', description: 'Check types' }),
      ok('b1', 'All good'),
      call('b2', 'Bash', { command: 'pnpm test' }),
      failed('b2', 'Exit code 2\nFAIL one test'),
    ]);
    // A command that describes itself leads with its description; the command sits under it.
    expect(label(container)).toEqual(['Check types', "Couldn't run pnpm test"]);
    expect(container.querySelector('.tool-step__cmd')?.textContent).toBe('pnpm -s typecheck');
    const [first, second] = [...container.querySelectorAll('.term')];
    expect(first?.querySelector('.term__cmd')?.textContent).toContain('pnpm -s typecheck');
    expect(first?.querySelector('.term__desc')?.textContent).toBe('Check types');
    expect(first?.querySelector('.tstep__out')?.textContent).toBe('All good');
    expect(second?.querySelector('.term__exit')?.textContent).toBe('Exit code 2');
    expect(second?.querySelector('.tstep__out')?.textContent).toBe('FAIL one test');
    expect(container.querySelectorAll('.tool-step')[1]).toHaveAttribute('data-state', 'failed');
  });

  it('Grep: the search on one line and the matches as a compact list', () => {
    const { container } = parts([
      call('g1', 'Grep', { pattern: 'mcpToolName', path: '/home/me/proj/services' }),
      ok('g1', 'Found 2 files\n/home/me/proj/services/a.ts\n/home/me/proj/services/b.ts'),
    ]);
    expect(label(container)).toEqual(["Searched for 'mcpToolName' in services"]);
    expect(container.querySelector('.tool-step__meta')?.textContent).toBe('2 files');
    expect([...container.querySelectorAll('.matches__file')].map((f) => f.textContent)).toEqual([
      'services/a.ts',
      'services/b.ts',
    ]);
  });

  it('TodoWrite: the plan as a checklist', () => {
    const { container } = parts([
      call('t1', 'TodoWrite', {
        todos: [
          { content: 'Read the code', status: 'completed', activeForm: 'Reading' },
          { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing' },
          { content: 'Run tests', status: 'pending', activeForm: 'Running' },
        ],
      }),
      ok('t1', 'Todos have been modified'),
    ]);
    // The item in progress is the title, as in Claude Code's own terminal.
    expect(label(container)).toEqual(['Fixing']);
    expect(container.querySelector('.tool-step__cmd')?.textContent).toBe('Updated the plan');
    expect(container.querySelector('.tool-step__meta')?.textContent).toBe('1 of 3 done');
    const items = [...container.querySelectorAll('.todo > li')];
    expect(items.map((li) => li.getAttribute('data-status'))).toEqual([
      'completed',
      'in_progress',
      'pending',
    ]);
    expect(items[0]?.textContent).toContain('Done: Read the code');
  });

  it('mcp__server__tool: a server badge, the tool, and JSON input and result', () => {
    const { container } = parts([
      call('m1', 'mcp__github__create_issue', { title: 'Bug', labels: ['ui'] }),
      ok('m1', '{"number":42,"url":"https://github.com/x/y/issues/42"}'),
    ]);
    expect(container.querySelector('.tool-step__badge')?.textContent).toBe('github');
    expect(container.querySelector('.tool-step__target')?.textContent).toBe('create_issue');
    const blocks = [...container.querySelectorAll('.code')];
    expect(blocks.map((b) => b.querySelector('.code__lang')?.textContent)).toEqual(['Input', 'Result']);
    expect(blocks[1]?.textContent).toContain('"number": 42');
  });

  it('WebFetch: a link chip to the page, the answer folded', () => {
    const { container } = parts([
      call('w1', 'WebFetch', { url: 'https://docs.example.com/guide', prompt: 'Find the limits' }),
      ok('w1', 'The limit is **10**.'),
    ]);
    expect(label(container)).toEqual(['Fetched docs.example.com']);
    const link = container.querySelector('a.link-chip');
    expect(link).toHaveAttribute('href', 'https://docs.example.com/guide');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('What came back').closest('details')).not.toHaveAttribute('open');
  });

  it('an unknown tool keeps the plain input and result view', () => {
    const { container } = parts([call('x1', 'Frobnicate', { level: 3 }), ok('x1', 'done')]);
    expect(label(container)).toEqual(['Frobnicate']);
    expect(screen.getByText('Input')).toBeInTheDocument();
  });

  it('more than four steps in a row fold into one group showing the last step', () => {
    const many = Array.from({ length: 5 }, (_, i) => [
      call(`c${i}`, 'Read', { file_path: `/home/me/proj/f${i}.ts` }),
      ok(`c${i}`, `     1→x${i}`),
    ]).flat();
    const { container } = parts([
      { type: 'text', text: 'Looking.' },
      ...many,
      { type: 'text', text: 'Done.' },
    ]);
    const group = container.querySelector('details.tool-group');
    expect(group).not.toBeNull();
    expect(group).not.toHaveAttribute('open');
    expect(group?.querySelector('.tool-group__title')?.textContent).toBe('Worked through 5 steps');
    expect(group?.querySelector('.tool-group__last')?.textContent).toBe('Read f4.ts');
    expect(group?.querySelectorAll('.tool-step')).toHaveLength(5);
  });

  it('four steps stay as they are', () => {
    const four = Array.from({ length: 4 }, (_, i) => [
      call(`c${i}`, 'Agent', { description: `Look at part ${i}`, prompt: 'Go' }),
      ok(`c${i}`, 'Found it'),
    ]).flat();
    const { container } = parts(four);
    expect(container.querySelector('.tool-group')).toBeNull();
    expect(label(container)[0]).toBe('Look at part 0');
  });
});

/* ---- Thinking and markdown ------------------------------------------------ */

describe('thinking and prose', () => {
  it('thinking is folded to one quiet line', () => {
    const { container } = parts([
      { type: 'reasoning', text: 'A long wall of reasoning '.repeat(50) },
      { type: 'text', text: 'Answer.' },
    ]);
    const t = container.querySelector('details.thinking');
    expect(t).not.toHaveAttribute('open');
    expect(t?.querySelector('summary')?.textContent).toBe('Thought for a while');
  });

  it('shows raw HTML as text, and code fences with their language and Copy', () => {
    const { container } = parts([
      {
        type: 'text',
        text: 'Before <system-reminder>keep going</system-reminder> after.\n\n```python\ndef f():\n    return 1\n```',
      },
    ]);
    expect(container.querySelector('system-reminder')).toBeNull();
    expect(container.textContent).toContain('<system-reminder>keep going</system-reminder>');
    expect(container.querySelector('.code__lang')?.textContent).toBe('Python');
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
    expect(container.querySelector('.tok-kw')?.textContent).toBe('def');
  });

  it('the highlighter carries a block comment across lines', () => {
    const lines = highlight('/* one\ntwo */ const x = "s";', 'ts');
    expect(lines[0]).toEqual([{ k: 'com', v: '/* one' }]);
    expect(lines[1]?.[0]).toEqual({ k: 'com', v: 'two */' });
    expect(lines[1]?.some((t) => t.k === 'str' && t.v === '"s"')).toBe(true);
  });
});

/* ---- A long paste ------------------------------------------------------------ */

describe('a long message of yours', () => {
  function you(text: string): MessageView {
    return {
      id: 'u1',
      parentId: null,
      role: 'user',
      blocks: [],
      parts: [{ type: 'text', text }],
      modelId: null,
      createdAt: new Date().toISOString(),
      status: 'complete',
    };
  }

  it('starts at a dozen lines, with Show all', () => {
    const text = Array.from({ length: 30 }, (_, i) => `log line ${i + 1}`).join('\n');
    const { container } = wrap(
      <MessageRow m={you(text)} threadId="t1" selected={false} onSelect={() => {}} />,
    );
    expect(container.querySelector('.msg__body')).toHaveAttribute('data-clamped');
    fireEvent.click(screen.getByRole('button', { name: 'Show all 30 lines' }));
    expect(container.querySelector('.msg__body')).not.toHaveAttribute('data-clamped');
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });

  it('a short message is left alone', () => {
    const { container } = wrap(
      <MessageRow m={you('Just a question')} threadId="t1" selected={false} onSelect={() => {}} />,
    );
    expect(container.querySelector('.msg__body')).not.toHaveAttribute('data-clamped');
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
  });
});
