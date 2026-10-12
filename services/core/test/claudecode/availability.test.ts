/**
 * A Claude Code thread opened on a machine where Claude Code is not
 * installed or not signed in (a synced notebook, or after uninstalling):
 * the live state says so, a turn to Claude Code is refused with the error
 * that says what to do and writes nothing, the "/" list is NVX Ancile's
 * own instead of an error, and another model still answers the thread.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EffectiveScope, ModelConfig } from '@nvx/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LiveBridge } from '../../src/claudecode/bridge-protocol';
import { ccErrors } from '../../src/claudecode/errors';
import { ClaudeCodeLive, type LiveServiceView } from '../../src/claudecode/live';
import { MemoryClaudeCodeStore } from '../../src/claudecode/store';
import { ClaudeCodeEngine, Engines } from '../../src/engines';
import type { Engine } from '../../src/engines/types';
import { BuiltinPolicy } from '../../src/permissions/cedar';
import { createGate } from '../../src/permissions/gate';
import { MemoryPermissionStore } from '../../src/permissions/store';
import { MemoryRunEventLog } from '../../src/runs/events';
import { MemoryRunStore } from '../../src/runs/store';
import { DEFAULT_SCOPE } from '../../src/scopes';
import { MemoryThreadRepo } from '../../src/threads/repo';

const WS = 'wsp_01TESTWORKSPACE000000000000';
const CWD = join(tmpdir(), 'ancile-cc-availability', 'app');
type Availability = 'ready' | 'not_installed' | 'signed_out' | 'unverified';

let availability: Availability;
let threads: MemoryThreadRepo;
let live: ClaudeCodeLive;

const bridge = {
  onEvent: () => () => undefined,
  setKeepAlive: () => undefined,
  open: async () => {
    throw new Error('nothing may open a session here');
  },
} as unknown as LiveBridge;

const service: LiveServiceView = {
  cliPath: async () => {
    if (availability === 'not_installed') throw ccErrors.notInstalled();
    return { path: 'claude', version: '2.1.300' };
  },
  cliEnv: async () => ({}),
  syncSession: async () => ({ thread_id: 'thr_1', added: 0, notebook_id: null }),
  transcriptModified: async () => null,
  setLiveGuard: () => undefined,
  availability: async () => availability,
};

beforeEach(async () => {
  availability = 'not_installed';
  threads = new MemoryThreadRepo();
  const perms = new MemoryPermissionStore();
  live = new ClaudeCodeLive({
    workspaceId: WS,
    userId: 'usr_1',
    bridge,
    service,
    sessionInfo: async () => null,
    threads,
    store: new MemoryClaudeCodeStore(threads),
    runs: new MemoryRunStore(),
    events: new MemoryRunEventLog(),
    worker: { kick: () => undefined },
    permissions: perms,
    gateFor: (root) => createGate({ policy: new BuiltinPolicy(), store: perms, workspaceRoot: root }),
    notebook: async () => null,
    folderExists: async () => true,
  });
  await threads.createThread({
    id: 'thr_1',
    workspace_id: WS,
    title: 'Synced from the laptop',
    settings: { claude_code: { session_id: 'S', cwd: CWD, last_uuid: 'a1', synced_at: '' } },
  });
  await threads.insertMessages([
    {
      id: 'msg_u1',
      thread_id: 'thr_1',
      parent_id: null,
      role: 'user',
      parts: [{ type: 'text', text: 'Fix it' }],
      status: 'complete',
      trace_id: 't',
      provenance: { claude_code: { session_id: 'S', uuid: 'u1', uuids: ['u1'] } },
    },
  ]);
  await threads.patchThread('thr_1', { active_head_id: 'msg_u1', root_message_id: 'msg_u1' });
});

describe('Claude Code missing on this machine', () => {
  it('says so in the live state, and the "/" list is NVX Ancile’s own instead of an error', async () => {
    expect((await live.state('thr_1')).availability).toBe('not_installed');
    const list = await live.commands('thr_1');
    expect(list.partial).toBe(false);
    expect(list.items.every((c) => c.handled_by === 'ancile' || c.source === 'builtin')).toBe(true);
    availability = 'ready';
    expect((await live.state('thr_1')).availability).toBe('ready');
  });

  it('refuses a turn to Claude Code with what to do, and writes nothing', async () => {
    await expect(
      live.send('thr_1', { text: 'Go on', idempotency_key: 'key-avail-0001' }),
    ).rejects.toMatchObject({
      code: 'claude_code.not_installed',
    });
    availability = 'signed_out';
    expect((await live.state('thr_1')).availability).toBe('signed_out');
    await expect(
      live.send('thr_1', { text: 'Go on', idempotency_key: 'key-avail-0002' }),
    ).rejects.toMatchObject({
      code: 'claude_code.signed_out',
    });
    expect(await threads.messages('thr_1')).toHaveLength(1);
  });

  it('another model still answers the thread', async () => {
    const gatewaySent: string[] = [];
    const gateway = {
      id: 'gateway',
      start: async (t: { thread: { id: string }; text: string }) => {
        gatewaySent.push(t.text);
        return { run_id: 'run_g', user_message_id: 'u', assistant_message_id: 'a', model_id: 'openai/gpt-5' };
      },
    } as unknown as Engine;
    const engines = new Engines({
      registry: {
        get: (id: string) =>
          id === 'openai/gpt-5' ? ({ id, provider: 'openai', via: 'direct' } as ModelConfig) : undefined,
        chain: () => [],
      },
      gateway,
      claudeCode: new ClaudeCodeEngine({
        live: () => live,
        installed: async () => ({ available: false, reason: 'Claude Code is not installed' }),
      }),
      scopeOf: async () => ({ scope: DEFAULT_SCOPE }) as unknown as EffectiveScope,
    });
    const thread = await threads.getThread('thr_1');
    if (!thread) throw new Error('no thread');
    const out = await engines.send(thread, {
      text: 'Carry on',
      parentId: undefined,
      model: 'openai/gpt-5',
      idempotencyKey: 'key-avail-0003',
    });
    expect(out.engine).toBe('gateway');
    expect(gatewaySent).toEqual(['Carry on']);
    await expect(
      engines.send(thread, {
        text: 'To Claude Code',
        parentId: undefined,
        model: null,
        idempotencyKey: 'key-avail-0004',
      }),
    ).rejects.toMatchObject({ code: 'claude_code.not_installed' });
  });
});
