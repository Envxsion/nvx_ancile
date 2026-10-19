/**
 * Claude Code switched off for the whole Core (ANCILE_CLAUDE_CODE=off, the test profile): no bridge, no
 * detection, no import, no models, and a status that says why. Nothing here touches a real Claude Code.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClaudeCode } from '../../src/claudecode';
import { locate } from '../../src/claudecode/cli';
import { claudeConfigDir, claudeProjectsDir } from '../../src/claudecode/paths';
import { MemoryClaudeCodeStore } from '../../src/claudecode/store';
import { syncClaudeCodeModels } from '../../src/engines/mode-a';
import type { EventBus, GlobalEventInput } from '../../src/events/bus';
import { MemoryNotebookRepo } from '../../src/notebooks/repo';
import { MemorySettings } from '../../src/settings';
import { MemoryThreadRepo } from '../../src/threads/repo';

const WS = 'wsp_01TESTWORKSPACE000000000000';
const REASON = 'Off in the test profile';

class Bus implements EventBus {
  events: GlobalEventInput[] = [];
  async publish(e: GlobalEventInput) {
    this.events.push(e);
  }
  subscribe() {
    return () => undefined;
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ancile-cc-off-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function assemble(off: string | null) {
  const threads = new MemoryThreadRepo();
  const bus = new Bus();
  const a = createClaudeCode({
    workspaceId: WS,
    dataDir: dir,
    logLevel: 'error',
    settings: new MemorySettings(),
    bus,
    threads,
    notebooks: new MemoryNotebookRepo(),
    store: new MemoryClaudeCodeStore(threads),
    off,
  });
  return { a, threads, bus };
}

describe('Claude Code off', () => {
  it('reads as off, with the reason, and nothing detected', async () => {
    const { a } = assemble(REASON);
    const st = await a.service.status(true);
    expect(st.off_reason).toBe(REASON);
    expect(st.installed).toBe(false);
    expect(st.signed_in).toBe(false);
    expect(st.version).toBeNull();
    expect(st.path).toBeNull();
    expect(st.sdk.ready).toBe(false);
    expect(st.install.state).toBe('idle');
    expect(await a.service.availability()).toBe('not_installed');
    a.stop();
  });

  it('offers no Claude Code models', async () => {
    const { a } = assemble(REASON);
    const st = await a.service.status();
    const calls: [string, unknown[]][] = [];
    const ok = syncClaudeCodeModels(
      { setProviderModels: (p, m) => void calls.push([p, m]), setClaudeAuth: () => undefined },
      st,
    );
    expect(ok).toBe(false);
    expect(calls).toEqual([['claude_code', []]]);
    a.stop();
  });

  it('never finds the CLI and never starts the bridge', async () => {
    const { a } = assemble(REASON);
    expect(a.cli.where()).toBeNull();
    await expect(a.bridge.listSessions()).rejects.toThrow(/Claude Code is off/);
    expect(a.bridge.running).toBe(false);
    await expect(a.service.cliPath()).rejects.toMatchObject({ code: 'claude_code.off' });
    await expect(a.service.install()).rejects.toMatchObject({ code: 'claude_code.off' });
    a.stop();
  });

  it('lists and imports no sessions, and auto-import does nothing', async () => {
    const { a, bus } = assemble(REASON);
    expect((await a.service.listSessions()).items).toEqual([]);
    expect(await a.service.recentSessions()).toEqual([]);
    await expect(a.service.importSessions({ session_ids: ['s1'] })).rejects.toMatchObject({
      code: 'claude_code.off',
    });
    a.service.startAuto();
    a.service.kick();
    await a.service.idle();
    expect(a.service.importProgress()).toBeNull();
    expect(bus.events.filter((e) => e.type === 'claude_code.changed')).toEqual([]);
    expect(a.bridge.running).toBe(false);
    a.stop();
  });
});

describe('CLAUDE_CONFIG_DIR', () => {
  it('moves the folders Core reads, and defaults to ~/.claude', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/empty' }, '/home/u')).toBe('/empty');
    expect(claudeProjectsDir({ CLAUDE_CONFIG_DIR: '/empty' }, '/home/u')).toBe(join('/empty', 'projects'));
    expect(claudeConfigDir({}, '/home/u')).toBe(join('/home/u', '.claude'));
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '  ' }, '/home/u')).toBe(join('/home/u', '.claude'));
  });

  it('is where the CLI looks for a local install', () => {
    const seen: string[] = [];
    locate({
      platform: 'linux',
      home: '/home/u',
      env: { PATH: '', CLAUDE_CONFIG_DIR: '/empty' },
      exists: (p) => {
        seen.push(p);
        return false;
      },
    });
    expect(seen).toContain('/empty/local/claude');
    expect(seen.some((p) => p.includes('.claude/local'))).toBe(false);
  });
});
