/**
 * ------------------------------------------------------------------
 *  Title    |  DEMO fixture: an imported Claude Code session
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A long, realistic thread mirrored from Claude Code, so
 *           |  the thread view can be judged on what people really
 *           |  read: short and pasted prompts, answers with headings,
 *           |  tables and code, runs of tool steps, thinking, a
 *           |  /compact, a notice from another session, a compaction,
 *           |  "Stopped by you", and one ordinary grounded answer.
 *  How      |  lib/data.ts serves it in demo mode like demo.thread.
 *  Note     |  The project, files and figures are fictional.
 * ------------------------------------------------------------------
 */

import type { Part } from '@nvx/contracts';
import type { MessageView, ThreadSummary, ThreadView } from '../lib/types';

const CWD = '/home/sam/work/tidewater';

export const ccSummary: ThreadSummary = {
  id: 'thr_01J9ZK0000000000000000CCDE',
  title: 'Fix the flaky retry in the tide gauge poller',
  notebookId: null,
  updatedAt: '2026-10-03T16:40:00Z',
  branches: 1,
};

let n = 0;
const call = (tool: string, args: unknown): Part => ({ type: 'tool_call', call_id: `c${++n}`, tool, args });
const ok = (result: unknown): Part => ({ type: 'tool_result', call_id: `c${n}`, ok: true, result });
const fail = (result: unknown): Part => ({ type: 'tool_result', call_id: `c${n}`, ok: false, result });
const text = (t: string): Part => ({ type: 'text', text: t });
const think = (t: string): Part => ({ type: 'reasoning', text: t });

const gutter = (src: string, from = 1) =>
  src
    .split('\n')
    .map((l, i) => `${String(i + from).padStart(6)}→${l}`)
    .join('\n');

const POLLER = `import { retry } from '../resilience';
import type { Reading } from './types';

const BASE_MS = 200;

export async function poll(station: string): Promise<Reading[]> {
  return retry(
    async () => {
      const res = await fetch(\`\${API}/stations/\${station}/readings\`);
      if (!res.ok) throw new Error(\`gauge \${res.status}\`);
      return (await res.json()) as Reading[];
    },
    { attempts: 5, delay: (i) => BASE_MS * 2 ** i },
  );
}`;

const PASTED_LOG = `FAIL  src/poller/poll.test.ts > poll > retries a 503 then succeeds
AssertionError: expected 3 calls, got 2
 ❯ src/poller/poll.test.ts:41:23
     39|     await vi.advanceTimersByTimeAsync(400);
     40|     const readings = await p;
     41|     expect(fetchMock).toHaveBeenCalledTimes(3);
       |                       ^
     42|     expect(readings).toHaveLength(12);
     43|   });

 Test Files  1 failed | 14 passed (15)
      Tests  1 failed | 203 passed (204)
   Start at  09:12:44
   Duration  4.81s (transform 612ms, setup 0ms, collect 2.10s, tests 1.93s)

stderr | retry jitter=0.73 delay=546ms attempt=1
stderr | retry jitter=0.12 delay=224ms attempt=2`;

const at = (min: number) => new Date(Date.UTC(2026, 9, 3, 15, min)).toISOString();

const m = (
  id: string,
  parentId: string | null,
  role: 'user' | 'assistant',
  parts: Part[],
  extra: Partial<MessageView> = {},
): MessageView => ({
  id,
  parentId,
  role,
  blocks: [],
  parts,
  modelId: null,
  createdAt: at(Number(id.replace(/\D/g, '')) * 3),
  status: 'complete',
  ...extra,
});

const claude = { modelName: 'Claude Opus 5.5' };

const messages: MessageView[] = [
  m('cc1', null, 'user', [text('The retry test in the poller is flaky again. Can you find out why?')]),
  m(
    'cc2',
    'cc1',
    'assistant',
    [
      think(
        'The test advances fake timers by a fixed 400 ms, but the backoff probably has jitter now. I should read the poller and the retry helper before guessing.',
      ),
      call('Read', { file_path: `${CWD}/src/poller/poll.ts` }),
      ok(gutter(POLLER)),
      call('Grep', { pattern: 'jitter', path: `${CWD}/src` }),
      ok('src/resilience/retry.ts\nsrc/resilience/retry.test.ts'),
      call('Read', { file_path: `${CWD}/src/resilience/retry.ts`, offset: 18, limit: 12 }),
      ok(
        gutter(
          `export async function retry<T>(fn: () => Promise<T>, o: RetryOptions): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i + 1 >= o.attempts) throw e;
      const jitter = 0.5 + Math.random();
      await sleep(o.delay(i) * jitter);
    }
  }
}`,
          18,
        ),
      ),
      text(
        'Found it. `retry()` multiplies every delay by a random jitter between 0.5 and 1.5, but the test advances the clock by exactly 400 ms. When the jitter comes out high, the second attempt has not fired yet when the assertion runs.',
      ),
    ],
    { ...claude, usage: { tokens: 18_204, costUsd: 0.212, ms: 21_400 } },
  ),
  m('cc3', 'cc2', 'user', [
    text(
      `Here's the full output from CI, it failed twice this morning:\n\n${PASTED_LOG}\n\nFix it properly, I don't want to just bump the timer.`,
    ),
  ]),
  m(
    'cc4',
    'cc3',
    'assistant',
    [
      call('TodoWrite', {
        todos: [
          {
            content: 'Make the jitter injectable in retry()',
            status: 'completed',
            activeForm: 'Making jitter injectable',
          },
          {
            content: 'Pin the jitter to 1 in the poller test',
            status: 'in_progress',
            activeForm: 'Pinning jitter',
          },
          {
            content: 'Run the poller and resilience suites',
            status: 'pending',
            activeForm: 'Running suites',
          },
          {
            content: 'Check other callers still get real jitter',
            status: 'pending',
            activeForm: 'Checking callers',
          },
        ],
      }),
      ok('Todos have been modified successfully.'),
      call('Edit', {
        file_path: `${CWD}/src/resilience/retry.ts`,
        old_string: '      const jitter = 0.5 + Math.random();',
        new_string: '      const jitter = o.jitter ? o.jitter() : 0.5 + Math.random();',
      }),
      ok('The file has been updated.'),
      call('Edit', {
        file_path: `${CWD}/src/poller/poll.test.ts`,
        old_string: '    const p = poll("PLY-01");',
        new_string: '    const p = poll("PLY-01", { jitter: () => 1 });',
      }),
      ok('The file has been updated.'),
      call('Bash', {
        command: 'pnpm vitest run src/poller src/resilience',
        description: 'Run the poller and resilience tests',
      }),
      fail(
        'Exit code 1\n FAIL  src/poller/poll.test.ts\nTypeError: poll() takes 1 argument, but options were passed\n\n Test Files  1 failed | 3 passed (4)\n      Tests  1 failed | 41 passed (42)',
      ),
      think('poll() does not take options yet. Thread them through to retry.'),
      call('Edit', {
        file_path: `${CWD}/src/poller/poll.ts`,
        old_string: 'export async function poll(station: string): Promise<Reading[]> {',
        new_string:
          "export async function poll(\n  station: string,\n  o: Pick<RetryOptions, 'jitter'> = {},\n): Promise<Reading[]> {",
      }),
      ok('The file has been updated.'),
      call('Bash', {
        command: 'pnpm vitest run src/poller src/resilience',
        description: 'Run the poller and resilience tests',
      }),
      ok(
        ' ✓ src/resilience/retry.test.ts (18 tests) 41ms\n ✓ src/poller/poll.test.ts (9 tests) 22ms\n ✓ src/poller/parse.test.ts (11 tests) 8ms\n ✓ src/resilience/breaker.test.ts (4 tests) 5ms\n\n Test Files  4 passed (4)\n      Tests  42 passed (42)\n   Duration  1.12s',
      ),
      call('Agent', {
        description: 'Find other retry callers',
        subagent_type: 'Explore',
        prompt: 'List every caller of retry() in src/ and say whether any passes its own jitter.',
      }),
      ok(
        'Four callers, none passes `jitter`:\n\n- `src/poller/poll.ts` (now passes it through)\n- `src/upload/s3.ts`\n- `src/alerts/sms.ts`\n- `src/backfill/run.ts`\n\nAll of them keep the default random jitter.',
      ),
      call('mcp__github__get_issue', { owner: 'tidewater', repo: 'gauges', issue_number: 212 }),
      ok({ number: 212, title: 'Poller retry test flakes on CI', state: 'open', labels: ['flaky', 'ci'] }),
      text(`## What was wrong

The poller test assumed a fixed backoff, but \`retry()\` multiplies each delay by a random jitter between **0.5 and 1.5**. With a high draw the second attempt lands after the 400 ms the test waits, so it saw two calls instead of three.

## What I changed

1. \`retry()\` takes an optional \`jitter\` function. Without one it behaves exactly as before.
2. \`poll()\` passes \`jitter\` through to \`retry()\`.
3. The test pins jitter to \`1\`, so the delays are 200 ms and 400 ms every time.

| File | Change | Lines |
| --- | --- | --- |
| \`src/resilience/retry.ts\` | optional \`jitter\` option | +3 −1 |
| \`src/poller/poll.ts\` | passes options through | +4 −1 |
| \`src/poller/poll.test.ts\` | pins jitter to 1 | +1 −1 |

The two suites pass (42 tests). The other three callers keep real jitter, which is what you want in production.

\`\`\`ts
const p = poll('PLY-01', { jitter: () => 1 });
await vi.advanceTimersByTimeAsync(600);
expect(fetchMock).toHaveBeenCalledTimes(3);
\`\`\`

Issue #212 is still open; close it once CI has been green for a day.`),
    ],
    { ...claude, usage: { tokens: 46_918, costUsd: 0.584, ms: 94_300 } },
  ),
  m('cc5', 'cc4', 'user', [], {
    cc: {
      kind: 'command',
      name: '/compact',
      args: 'keep the retry change details',
      output: 'Compacted. 112,400 tokens → 9,800 tokens.',
    },
  }),
  m('cc6', 'cc5', 'user', [], {
    cc: {
      kind: 'compact_boundary',
      summary:
        '## Summary\n\n- The poller test was flaky because `retry()` applies random jitter of 0.5–1.5×.\n- `retry()` now takes an optional `jitter`; `poll()` passes it through; the test pins it to 1.\n- 42 tests pass. Issue #212 stays open for a day of green CI.',
    },
  }),
  m('cc7', 'cc6', 'user', [], {
    cc: {
      kind: 'notification',
      source: 'session',
      title: 'Background task finished',
      from: 'docs-site session',
      status: 'completed',
      body: 'Rebuilt the docs site. 3 pages changed: `retry.md`, `poller.md`, `changelog.md`.',
    },
  }),
  m('cc8', 'cc7', 'user', [text('Also add a changelog entry.')]),
  m(
    'cc9',
    'cc8',
    'assistant',
    [
      call('Read', { file_path: `${CWD}/CHANGELOG.md`, limit: 8 }),
      ok(
        gutter(
          '# Changelog\n\n## Unreleased\n\n### Fixed\n\n- Upload retries no longer double the first delay.',
        ),
      ),
      call('Edit', {
        file_path: `${CWD}/CHANGELOG.md`,
        old_string: '### Fixed\n',
        new_string:
          '### Fixed\n\n- The tide gauge poller test no longer flakes: retry jitter can be pinned in tests.',
      }),
      ok('The file has been updated.'),
      text('Added under **Unreleased → Fixed**.'),
    ],
    { ...claude, usage: { tokens: 3_104, costUsd: 0.031, ms: 6_200 } },
  ),
  m('cc10', 'cc9', 'user', [text('Now write a migration guide for the new option and')]),
  m(
    'cc11',
    'cc10',
    'assistant',
    [
      think('A migration guide for an optional parameter is short. Start with the public API docs.'),
      call('Glob', { pattern: 'docs/**/*.md' }),
      ok('docs/retry.md\ndocs/poller.md\ndocs/index.md'),
      text('I will start from `docs/retry.md` and'),
    ],
    { ...claude, status: 'stopped' },
  ),
  m('cc12', 'cc11', 'user', [], { cc: { kind: 'interrupted' } }),
  m('cc13', 'cc12', 'user', [text('How do other gauge networks handle backoff? Use the notebook sources.')]),
  m(
    'cc14',
    'cc13',
    'assistant',
    [
      text(
        'Most networks back off exponentially with full jitter and a ceiling. The national network caps retries at 30 s and spreads them across the whole window [1]. A coastal operator found that a fixed 5 s retry overloaded its relay after outages, and moved to capped exponential backoff [2].\n\nFor your poller, a 30 s ceiling would keep a station from hammering the relay without delaying recovery much.',
      ),
      {
        type: 'citation_ref',
        marker: 1,
        chunk_id: 'chk_1',
        source_id: 'src_ngn',
        char_start: 0,
        char_end: 80,
        quote: 'Clients must retry with exponential backoff, full jitter, capped at 30 seconds.',
      },
      {
        type: 'citation_ref',
        marker: 2,
        chunk_id: 'chk_2',
        source_id: 'src_coast',
        char_start: 0,
        char_end: 80,
        quote: 'Fixed-interval retries after the March outage saturated the relay within four minutes.',
      },
    ],
    { modelId: 'anthropic/claude-sonnet-5-5', usage: { tokens: 1_014, costUsd: 0.0004, ms: 3_100 } },
  ),
];

export const ccThread: ThreadView = {
  id: ccSummary.id,
  title: ccSummary.title,
  notebookId: null,
  messages,
  claudeCode: {
    session_id: '4f1c2a9e-7b3d-4c11-9a0e-5d2f8b6c3e10',
    cwd: CWD,
    last_uuid: null,
    synced_at: '2026-10-03T16:40:00Z',
  },
};
