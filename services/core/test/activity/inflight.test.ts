/**
 * Subagents and background shells read from transcript lines (fixtures in
 * the shape Claude Code 2.1.x writes), read incrementally from a file in a
 * temp folder. Never ~/.claude.
 */
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMAND_MAX,
  commandSummary,
  emptyFold,
  foldLine,
  InflightScanner,
  inflightOf,
} from '../../src/claudecode/inflight';

const at = (s: number) => new Date(Date.UTC(2026, 9, 12, 9, 0, s)).toISOString();

const toolUse = (uuid: string, s: number, id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    parentUuid: null,
    timestamp: at(s),
    sessionId: 'sess',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });

const result = (
  uuid: string,
  s: number,
  id: string,
  content: string,
  extra: Record<string, unknown> = {},
  isError = false,
) =>
  JSON.stringify({
    type: 'user',
    uuid,
    parentUuid: null,
    timestamp: at(s),
    sessionId: 'sess',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError && { is_error: true }) }],
    },
    toolUseResult: extra,
  });

const notice = (uuid: string, s: number, body: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    parentUuid: null,
    timestamp: at(s),
    sessionId: 'sess',
    origin: { kind: 'task-notification' },
    message: { role: 'user', content: body },
  });

function fold(lines: string[]) {
  const st = emptyFold();
  for (const l of lines) foldLine(st, l);
  return inflightOf(st);
}

describe('command summaries', () => {
  it('keeps the first line, cut short, with key shapes redacted', () => {
    expect(commandSummary('pnpm test\npnpm lint')).toBe('pnpm test …');
    const long = commandSummary(`node ${'x'.repeat(200)}`);
    expect(long.length).toBeLessThanOrEqual(COMMAND_MAX);
    expect(long.endsWith('…')).toBe(true);
    const cases = [
      'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx node run.js',
      'curl -H "Authorization: Bearer abcdefghijklmnop123456" https://x.test',
      'psql postgres://ancile:hunter2pass@127.0.0.1:5433/ancile',
      'deploy --token ghp_abcdefghijklmnopqrstuvwxyz0123 --env prod',
      'export DB_PASSWORD="correct horse battery"',
      'mytool --api-key=4f9a0c1d2e3b4a5f',
      'GITHUB_TOKEN=abc123 gh pr list',
    ];
    const secrets = [
      'sk-proj-abcdefghijklmnopqrstuvwx',
      'abcdefghijklmnop123456',
      'hunter2pass',
      'ghp_abcdefghijklmnopqrstuvwxyz0123',
      'correct horse battery',
      '4f9a0c1d2e3b4a5f',
      'abc123',
    ];
    const shown = cases.map((c) => commandSummary(c, 200));
    for (const [i, s] of shown.entries()) expect(s).not.toContain(secrets[i]);
    expect(shown[6]).toContain('gh pr list');
  });
});

describe('folding transcript lines', () => {
  it('keeps a subagent in flight until its result arrives', () => {
    const start = toolUse('e1', 1, 'toolu_a', 'Task', {
      description: 'Explore the parser',
      prompt: 'Find where…',
      subagent_type: 'Explore',
    });
    let f = fold([start]);
    expect(f.agents).toEqual([
      expect.objectContaining({
        callId: 'toolu_a',
        entryUuid: 'e1',
        description: 'Explore the parser',
        agentType: 'Explore',
        startedAt: at(1),
      }),
    ]);
    f = fold([start, result('e2', 9, 'toolu_a', 'Done: the parser is in src/parse.ts')]);
    expect(f.agents).toEqual([]);
    expect(f.lastAt).toBe(at(9));
  });

  it('keeps a background agent until its task notification, not its launch', () => {
    const lines = [
      toolUse('e1', 1, 'toolu_bg', 'Agent', { description: 'Review the diff', run_in_background: true }),
      result('e2', 2, 'toolu_bg', 'Async agent launched successfully. agentId: a7f3', { agentId: 'a7f3' }),
    ];
    expect(fold(lines).agents).toHaveLength(1);
    const done = notice(
      'e3',
      30,
      '<task-notification><task-id>a7f3</task-id><status>completed</status><summary>Agent "Review the diff" completed</summary></task-notification>',
    );
    expect(fold([...lines, done]).agents).toHaveLength(0);
  });

  it('follows a background shell from start to its notification', () => {
    const lines = [
      toolUse('e1', 1, 'toolu_sh', 'Bash', {
        command: 'pnpm test --watch',
        description: 'Run tests in watch mode',
        run_in_background: true,
      }),
      result(
        'e2',
        2,
        'toolu_sh',
        'Command running in background with ID: b4f2k1. Output is being written to: C:\\Temp\\b4f2k1.output',
      ),
    ];
    let f = fold(lines);
    expect(f.shells).toEqual([
      expect.objectContaining({
        command: 'pnpm test --watch',
        description: 'Run tests in watch mode',
        taskId: 'b4f2k1',
        state: 'running',
        startedAt: at(1),
        finishedAt: null,
      }),
    ]);
    f = fold([
      ...lines,
      notice(
        'e3',
        40,
        '<task-notification>\n<task-id>b4f2k1</task-id>\n<tool-use-id>toolu_sh</tool-use-id>\n<status>failed</status>\n<summary>Background command "Run tests" failed with exit code 1</summary>\n</task-notification>',
      ),
    ]);
    expect(f.shells[0]).toMatchObject({ state: 'failed', finishedAt: at(40) });
  });

  it('settles a shell from a BashOutput status, a KillShell call, or a queued notification line', () => {
    const start = (id: string, cmd: string) =>
      toolUse(`u-${id}`, 1, id, 'Bash', { command: cmd, run_in_background: true });
    const lines = [
      start('t1', 'npm run dev'),
      result('r1', 2, 't1', 'Command running in background with ID: aaa111.'),
      start('t2', 'python server.py'),
      result('r2', 2, 't2', 'Command running in background with ID: bbb222.'),
      start('t3', 'cargo build'),
      result('r3', 2, 't3', 'started', { backgroundTaskId: 'ccc333' }),
      toolUse('p1', 5, 'peek', 'BashOutput', { bash_id: 'aaa111' }),
      result('p2', 6, 'peek', '<status>completed</status>\n<exit_code>0</exit_code>'),
      toolUse('k1', 7, 'kill', 'KillShell', { shell_id: 'bbb222' }),
      result('k2', 8, 'kill', 'Successfully killed shell: bbb222'),
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: at(9),
        content: '<task-notification><task-id>ccc333</task-id><status>completed</status></task-notification>',
      }),
    ];
    const f = fold(lines);
    expect(Object.fromEntries(f.shells.map((s) => [s.taskId, s.state]))).toEqual({
      aaa111: 'finished',
      bbb222: 'stopped',
      ccc333: 'finished',
    });
  });

  it('ignores foreground shells, sidechain entries, lines that are not JSON, and a failed start', () => {
    const f = fold([
      toolUse('e1', 1, 'fg', 'Bash', { command: 'ls' }),
      JSON.stringify({
        type: 'assistant',
        uuid: 's1',
        isSidechain: true,
        timestamp: at(2),
        message: { content: [{ type: 'tool_use', id: 'side', name: 'Task', input: {} }] },
      }),
      'not json at all',
      toolUse('e2', 3, 'bad', 'Bash', { command: 'nope', run_in_background: true }),
      result('e3', 4, 'bad', 'Error: not allowed', {}, true),
    ]);
    expect(f.agents).toEqual([]);
    expect(f.shells).toEqual([expect.objectContaining({ callId: 'bad', state: 'failed' })]);
  });
});

describe('the scanner', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ancile-inflight-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads only what is new, waits for a half-written line, and starts again when a file shrinks', async () => {
    const path = join(dir, 'sess.jsonl');
    const scan = new InflightScanner();
    await writeFile(path, `${toolUse('e1', 1, 'toolu_a', 'Task', { description: 'Look around' })}\n`);
    expect((await scan.scan(path))?.agents).toHaveLength(1);
    const end = result('e2', 5, 'toolu_a', 'done');
    // Half a line: not read yet.
    await appendFile(path, end.slice(0, 20));
    expect((await scan.scan(path))?.agents).toHaveLength(1);
    await appendFile(path, `${end.slice(20)}\n`);
    expect((await scan.scan(path))?.agents).toHaveLength(0);
    // Rewritten shorter: read from the start again.
    await writeFile(path, `${toolUse('e9', 1, 'toolu_z', 'Task', { description: 'Again' })}\n`);
    expect((await scan.scan(path))?.agents.map((a) => a.description)).toEqual(['Again']);
    expect(await scan.scan(join(dir, 'missing.jsonl'))).toBeNull();
  });

  it('reads only the end of a very large file on first sight', async () => {
    const path = join(dir, 'big.jsonl');
    const filler = `${JSON.stringify({ type: 'progress', pad: 'x'.repeat(200) })}\n`;
    await writeFile(
      path,
      `${toolUse('e0', 1, 'early', 'Task', { description: 'Early' })}\n${filler.repeat(50)}${toolUse('e1', 2, 'late', 'Task', { description: 'Late' })}\n`,
    );
    const scan = new InflightScanner({ tailBytes: 2_000 });
    expect((await scan.scan(path))?.agents.map((a) => a.description)).toEqual(['Late']);
  });
});
