/**
 * The bridge with a fake Agent SDK: no download, no Claude Code. The
 * tarball tests build a small package in memory.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ClaudeSdkLoader, matchesIntegrity } from '../src/sdk';
import type { ClaudeAgentSdk } from '../src/sdk-types';
import { handle, type RunningBridge, type SdkSource, startServer } from '../src/server';
import { readTgz, safeJoin } from '../src/tar';

function header(name: string, size: number, flag: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(flag, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

function tgz(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    parts.push(header(name, body.length, '0'), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

const integrityOf = (b: Buffer) => `sha512-${createHash('sha512').update(b).digest('base64')}`;

const fakeSdk: ClaudeAgentSdk = {
  listSessions: async () => [{ sessionId: 's1', summary: 'Hello', lastModified: 1 }],
  getSessionInfo: async (id) =>
    id === 's1' ? { sessionId: 's1', summary: 'Hello', lastModified: 1 } : undefined,
  getSessionMessages: async (id, o) =>
    [
      {
        type: 'user' as const,
        uuid: 'u1',
        session_id: id,
        message: { role: 'user', content: 'hi' },
        parent_tool_use_id: null,
      },
      {
        type: 'assistant' as const,
        uuid: 'a1',
        session_id: id,
        message: { role: 'assistant', content: [] },
        parent_tool_use_id: null,
      },
    ].slice(o?.offset ?? 0, (o?.offset ?? 0) + (o?.limit ?? 100)),
  listSubagents: async () => ['ag1'],
  getSubagentMessages: async () => [],
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ancile-bridge-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('tarballs', () => {
  it('reads files and refuses paths outside the folder', () => {
    const entries = readTgz(tgz({ 'package/sdk.mjs': 'export {}', 'package/package.json': '{}' }));
    expect(entries.map((e) => e.path)).toEqual(['package/sdk.mjs', 'package/package.json']);
    expect(safeJoin(dir, 'package/../../evil', 1)).toBeNull();
    expect(safeJoin(dir, 'package/a/b.js', 1)).toBe(join(dir, 'a', 'b.js'));
  });
});

describe('the SDK loader', () => {
  const pkg = tgz({
    'package/package.json': JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '9.9.9' }),
    'package/sdk.mjs': 'export const x = 1;',
  });

  it('checks the checksum before unpacking and imports the package', async () => {
    let imported = '';
    const loader = new ClaudeSdkLoader({
      dataDir: dir,
      version: '9.9.9',
      integrity: integrityOf(pkg),
      download: async () => pkg,
      importer: async (u) => {
        imported = u;
        return fakeSdk;
      },
    });
    const sdk = await loader.load();
    expect(sdk).toBe(fakeSdk);
    expect(imported).toMatch(/claude-agent-sdk\/sdk\.mjs$/);
    expect(await readFile(join(loader.packageDir, 'sdk.mjs'), 'utf8')).toContain('x = 1');
    expect(loader.status()).toEqual({ ready: true, version: '9.9.9', error: null });
  });

  it('refuses a download whose checksum does not match, and unpacks nothing', async () => {
    const loader = new ClaudeSdkLoader({
      dataDir: dir,
      version: '9.9.9',
      integrity: integrityOf(Buffer.from('something else')),
      download: async () => pkg,
      importer: async () => fakeSdk,
    });
    await expect(loader.load()).rejects.toThrow(/checksum/);
    expect(existsSync(loader.packageDir)).toBe(false);
    expect(loader.status().ready).toBe(false);
    expect(loader.status().error).toMatch(/checksum/);
  });

  it('matches npm integrity strings', () => {
    expect(matchesIntegrity(pkg, integrityOf(pkg))).toBe(true);
    expect(matchesIntegrity(pkg, 'sha1-abc')).toBe(false);
  });
});

describe('the WebSocket server', () => {
  const TOKEN = 't'.repeat(32);
  let server: RunningBridge;
  const source: SdkSource = {
    load: async () => fakeSdk,
    status: () => ({ ready: true, version: '0.3.296', error: null }),
  };

  beforeEach(async () => {
    server = await startServer({ token: TOKEN, sdk: source });
  });
  afterEach(async () => {
    await server.close();
  });

  const connect = (headers: Record<string, string>) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, { headers });
      ws.once('open', () => resolve(ws));
      ws.once('unexpected-response', (_req, res) => reject(new Error(String(res.statusCode))));
      ws.once('error', reject);
    });
  const ask = (ws: WebSocket, msg: object) =>
    new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (d) => resolve(JSON.parse(String(d))));
      ws.send(JSON.stringify(msg));
    });

  it('refuses a missing token and a browser origin', async () => {
    await expect(connect({})).rejects.toThrow('401');
    await expect(
      connect({ authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' }),
    ).rejects.toThrow('403');
  });

  it('needs hello first, checks the protocol, then answers', async () => {
    const ws = await connect({ authorization: `Bearer ${TOKEN}` });
    expect(await ask(ws, { id: 1, op: 'sessions.list' })).toMatchObject({
      ok: false,
      error: { code: 'hello_first' },
    });
    expect(await ask(ws, { id: 2, op: 'hello', params: { protocol: 1 } })).toMatchObject({
      ok: true,
      result: { protocol: 1 },
    });
    const list = await ask(ws, { id: 3, op: 'sessions.list' });
    expect(list).toMatchObject({ id: 3, ok: true, result: [{ sessionId: 's1' }] });
    const page = await ask(ws, {
      id: 4,
      op: 'sessions.messages',
      params: { session_id: 's1', offset: 1, limit: 5 },
    });
    expect((page.result as unknown[]).length).toBe(1);
    expect(await ask(ws, { id: 5, op: 'nope' })).toMatchObject({ ok: false, error: { code: 'unknown_op' } });
    ws.close();
  });

  it('refuses another protocol version', async () => {
    const ws = await connect({ authorization: `Bearer ${TOKEN}` });
    expect(await ask(ws, { id: 1, op: 'hello', params: { protocol: 99 } })).toMatchObject({
      ok: false,
      error: { code: 'protocol_mismatch' },
    });
  });
});

describe('ops', () => {
  it('says the SDK is unavailable, with the reason', async () => {
    const broken: SdkSource = {
      load: async () => {
        throw new Error('offline');
      },
      status: () => ({ ready: false, version: null, error: 'offline' }),
    };
    await expect(handle(broken, 'sessions.list', {})).rejects.toMatchObject({ code: 'sdk_unavailable' });
    expect(await handle(broken, 'status.sdk', {})).toMatchObject({ ready: false, error: 'offline' });
  });
});
