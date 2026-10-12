/**
 * Who holds a Claude Code session: an injected process list stands in for
 * the system's, so nothing here reads (let alone signals) a real process.
 */
import { describe, expect, it } from 'vitest';
import {
  etimeSeconds,
  isClaudeCli,
  namedSessions,
  type ProcInfo,
  parsePs,
  parseWindows,
  parseWmic,
  SessionHolders,
  systemLister,
} from '../../src/claudecode/holders';

const SELF = 100;
const S = '7b0c4b2e-1111-4a6e-9f00-000000000001';
const T0 = Date.UTC(2026, 9, 12, 9, 0, 0);

const proc = (pid: number, ppid: number, cmdline: string, extra: Partial<ProcInfo> = {}): ProcInfo => ({
  pid,
  ppid,
  name: cmdline
    .split(/[\\/\s]/)
    .filter(Boolean)[0]
    ?.includes('claude')
    ? 'claude.exe'
    : 'node.exe',
  cmdline,
  ...extra,
});

function holders(list: ProcInfo[] | (() => Promise<ProcInfo[]>), now = () => T0) {
  let calls = 0;
  const h = new SessionHolders({
    lister: {
      list: async () => {
        calls++;
        return typeof list === 'function' ? list() : list;
      },
    },
    selfPid: SELF,
    platform: 'win32',
    now,
  });
  return { h, calls: () => calls };
}

describe('telling Claude Code apart', () => {
  it('knows the CLI from the desktop app and from NVX Ancile’s bridge', () => {
    expect(
      isClaudeCli({ name: 'claude.exe', cmdline: 'C:\\Users\\a\\.local\\bin\\claude.exe --resume x' }),
    ).toBe(true);
    expect(
      isClaudeCli({ name: 'node', cmdline: 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js' }),
    ).toBe(true);
    expect(isClaudeCli({ name: 'claude', cmdline: 'claude' })).toBe(true);
    expect(
      isClaudeCli({
        name: 'claude.exe',
        cmdline: '"C:\\Users\\a\\AppData\\Local\\AnthropicClaude\\app-1.0\\claude.exe"',
      }),
    ).toBe(false);
    expect(isClaudeCli({ name: 'node.exe', cmdline: 'node services/claude-bridge/dist/main.js' })).toBe(
      false,
    );
    expect(isClaudeCli({ name: 'node.exe', cmdline: 'node C:\\code\\.claude\\worktrees\\x\\main.js' })).toBe(
      false,
    );
  });

  it('reads the session a command line names, however it is written', () => {
    expect(namedSessions(`claude --resume ${S}`)).toEqual([S]);
    expect(namedSessions(`claude -r ${S} --model opus`)).toEqual([S]);
    expect(namedSessions(`claude --resume=${S}`)).toEqual([S]);
    expect(namedSessions(`"C:\\a b\\claude.exe" --session-id "${S}"`)).toEqual([S]);
    expect(namedSessions('claude --resume --verbose')).toEqual([]);
    expect(namedSessions('claude -c')).toEqual([]);
  });
});

describe('who holds a session', () => {
  it('finds a terminal resuming the session, and never counts NVX Ancile’s own processes', async () => {
    const { h } = holders([
      proc(SELF, 1, 'node core/dist/main.js'),
      proc(200, SELF, 'node claude-bridge/dist/main.js'),
      // NVX Ancile's own live session, below its bridge.
      proc(300, 200, `C:\\bin\\claude.exe --output-format stream-json --resume ${S}`),
      proc(400, 9, `C:\\bin\\claude.exe --resume ${S}`),
    ]);
    expect(await h.holder({ sessionId: S, cwd: 'C:\\code\\app' })).toEqual({ pid: 400, how: 'session' });
    const { h: onlyOurs } = holders([
      proc(SELF, 1, 'node core/dist/main.js'),
      proc(200, SELF, 'node claude-bridge/dist/main.js'),
      proc(300, 200, `C:\\bin\\claude.exe --resume ${S}`),
    ]);
    expect(await onlyOurs.holder({ sessionId: S, cwd: 'C:\\code\\app' })).toBeNull();
  });

  it('counts a claude running in the session’s folder, unless it names another session or started later', async () => {
    const cwd = 'C:\\Code\\App';
    const { h } = holders([
      proc(500, 9, 'claude', { cwd: 'c:/code/app/', startedAt: T0 - 60_000 }),
      proc(501, 9, 'claude --resume 11111111-2222-3333-4444-555555555555', { cwd, startedAt: T0 - 60_000 }),
    ]);
    expect(await h.holder({ sessionId: S, cwd, modifiedMs: T0 - 10_000 })).toEqual({
      pid: 500,
      how: 'folder',
    });
    // Started after the session was last written: it cannot have it open.
    expect(await h.holder({ sessionId: S, cwd, modifiedMs: T0 - 120_000 })).toBeNull();
    // Another folder: no.
    expect(await h.holder({ sessionId: S, cwd: 'C:\\Code\\Other', modifiedMs: T0 })).toBeNull();
  });

  it('reads the list once for a few seconds, and treats a list it cannot read as none', async () => {
    let now = T0;
    const { h, calls } = holders([proc(400, 9, `claude -r ${S}`)], () => now);
    await h.holder({ sessionId: S, cwd: null });
    await h.holder({ sessionId: 'other-session', cwd: null });
    expect(calls()).toBe(1);
    now += 6_000;
    await h.holder({ sessionId: S, cwd: null });
    expect(calls()).toBe(2);
    const { h: broken } = holders(async () => {
      throw new Error('powershell not found');
    });
    expect(await broken.holder({ sessionId: S, cwd: 'C:\\code' })).toBeNull();
  });
});

describe("the system's process list", () => {
  it('parses PowerShell’s JSON, one process or many', () => {
    expect(parseWindows('{"p":4,"pp":0,"n":"System","c":null,"s":null}')).toEqual([
      { pid: 4, ppid: 0, name: 'System', cmdline: null, startedAt: null },
    ]);
    const many = parseWindows(
      JSON.stringify([
        { p: 10, pp: 4, n: 'claude.exe', c: `claude.exe --resume ${S}`, s: T0 },
        { p: 11, pp: 10, n: 'node.exe', c: null, s: T0 },
      ]),
    );
    expect(many.map((p) => p.pid)).toEqual([10, 11]);
    expect(many[0]?.startedAt).toBe(T0);
    expect(parseWindows('')).toEqual([]);
  });

  it('falls back to wmic when PowerShell cannot answer', async () => {
    const asked: string[] = [];
    const lister = systemLister({
      platform: 'win32',
      run: async (cmd) => {
        asked.push(cmd);
        if (cmd === 'powershell.exe') throw new Error('blocked by policy');
        return `Node,CommandLine,Name,ParentProcessId,ProcessId\r\nPC,C:\\bin\\claude.exe --resume ${S},claude.exe,9,400\r\nPC,,svchost.exe,4,8\r\n`;
      },
    });
    const list = await lister.list();
    expect(asked).toEqual(['powershell.exe', 'wmic']);
    expect(list).toEqual([
      { pid: 400, ppid: 9, name: 'claude.exe', cmdline: `C:\\bin\\claude.exe --resume ${S}` },
      { pid: 8, ppid: 4, name: 'svchost.exe', cmdline: null },
    ]);
    expect(parseWmic('')).toEqual([]);
  });

  it('reads ps on macOS with each claude’s folder from lsof, and nothing else', async () => {
    const asked: string[][] = [];
    const lister = systemLister({
      platform: 'darwin',
      now: () => T0,
      run: async (cmd, args) => {
        asked.push([cmd, ...args]);
        if (cmd === 'ps')
          return `  1     0  10-00:00:00 /sbin/launchd\n 42     1     01:30 claude --model opus\n`;
        return 'p42\nfcwd\nn/Users/a/code/app\n';
      },
    });
    const list = await lister.list();
    expect(list.find((p) => p.pid === 42)).toMatchObject({
      cwd: '/Users/a/code/app',
      startedAt: T0 - 90_000,
    });
    expect(list.find((p) => p.pid === 1)?.cwd).toBeUndefined();
    expect(asked.map((a) => a[0])).toEqual(['ps', 'lsof']);
    expect(parsePs(' 7 1 120 claude', T0, 'etimes')[0]).toMatchObject({ pid: 7, startedAt: T0 - 120_000 });
    expect(etimeSeconds('1-02:03:04')).toBe(93_784);
  });
});
