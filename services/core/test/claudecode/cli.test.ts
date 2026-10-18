/**
 * Claude Code's CLI, install and install check, with a fake CLI script
 * and mocked spawns. Nothing here runs the real Claude Code.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ClaudeCli,
  locate,
  olderThan,
  parseAuthStatus,
  parseVersion,
  type Spawner,
} from '../../src/claudecode/cli';
import { ClaudeInstaller, failureWords, installerCommand } from '../../src/claudecode/install';
import { cwdKey } from '../../src/claudecode/store';
import { ClaudeVerifier, platformKey } from '../../src/claudecode/verify';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

const fakeCli = (env: Record<string, string> = {}, present = true) =>
  new ClaudeCli({
    locate: () => (present ? { path: FAKE, cmd: process.execPath, prefix: [FAKE] } : null),
    env: () => env,
  });

describe('version and sign-in parsing', () => {
  it('reads the version and compares versions', () => {
    expect(parseVersion('2.1.286 (Claude Code)')).toBe('2.1.286');
    expect(parseVersion('nonsense')).toBeNull();
    expect(olderThan('2.1.199', '2.1.200')).toBe(true);
    expect(olderThan('2.1.200', '2.1.200')).toBe(false);
    expect(olderThan('2.10.0', '2.9.9')).toBe(false);
  });

  it('keeps only the fields Ancile uses: the email as account, never the organisation', () => {
    const a = parseAuthStatus(
      JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        email: 'a@b.c',
        orgId: 'o',
        orgName: 'Org',
        subscriptionType: 'pro',
      }),
    );
    expect(a).toEqual({
      signed_in: true,
      auth_method: 'claude.ai',
      plan: 'pro',
      account: 'a@b.c',
      projects_dir: null,
      config_dir: null,
    });
    expect(JSON.stringify(a)).not.toMatch(/Org/);
  });
});

describe('status through the CLI', () => {
  it('reports an installed, signed-in Claude Code with its account email but not its organisation', async () => {
    const s = await fakeCli().status();
    expect(s).toMatchObject({
      installed: true,
      version: '2.1.286',
      version_ok: true,
      signed_in: true,
      plan: 'max',
      account: 'person@example.com',
    });
    expect(s.projects_dir).toBe('/home/person/.claude/projects');
    expect(JSON.stringify(s)).not.toMatch(/Secret Org|org-secret-id/);
  });

  it('reports a version that is too old', async () => {
    const s = await fakeCli({ FAKE_CLAUDE_VERSION: '2.0.10' }).status();
    expect(s).toMatchObject({ installed: true, version: '2.0.10', version_ok: false });
  });

  it('reports signed out', async () => {
    const s = await fakeCli({ FAKE_CLAUDE_SIGNED_IN: '0' }).status();
    expect(s).toMatchObject({ installed: true, signed_in: false, plan: null });
  });

  it('reports not installed', async () => {
    const s = await fakeCli({}, false).status();
    expect(s).toMatchObject({ installed: false, version: null, path: null, signed_in: false });
  });

  it('caches the status for a few seconds', async () => {
    let runs = 0;
    const spawn: Spawner = async () => {
      runs++;
      return { code: 0, stdout: '2.1.286 (Claude Code)', stderr: '', timedOut: false };
    };
    const cli = new ClaudeCli({ spawn, locate: () => ({ path: 'c', cmd: 'c', prefix: [] }) });
    await cli.status();
    await cli.status();
    expect(runs).toBe(2); // --version and auth status, once
    await cli.status(true);
    expect(runs).toBe(4);
  });
});

describe('finding Claude Code', () => {
  it('follows PATH order and resolves a Windows npm shim to its executable', () => {
    const files = new Set([
      'C:\\Users\\p\\AppData\\Roaming\\npm\\claude.cmd',
      'C:\\Users\\p\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'.replace(
        /\\/g,
        '/',
      ),
      'C:\\Users\\p\\.local\\bin\\claude.exe',
    ]);
    const exists = (p: string) => files.has(p) || files.has(p.replace(/\\/g, '/'));
    const found = locate({
      platform: 'win32',
      env: { PATH: 'C:\\Users\\p\\AppData\\Roaming\\npm;C:\\Users\\p\\.local\\bin' },
      home: 'C:\\Users\\p',
      exists,
    });
    expect(found?.path.replace(/\\/g, '/')).toMatch(
      /npm\/node_modules\/@anthropic-ai\/claude-code\/bin\/claude\.exe$/,
    );
  });

  it('falls back to ~/.local/bin when PATH does not have it', () => {
    const found = locate({
      platform: 'win32',
      env: { PATH: 'C:\\Windows' },
      home: 'C:\\Users\\p',
      exists: (p) => p === 'C:\\Users\\p\\.local\\bin\\claude.exe',
    });
    expect(found?.path).toBe('C:\\Users\\p\\.local\\bin\\claude.exe');
    expect(
      locate({
        platform: 'linux',
        env: { PATH: '/usr/bin' },
        home: '/home/p',
        exists: (p) => p === '/home/p/.local/bin/claude',
      })?.path,
    ).toBe('/home/p/.local/bin/claude');
    expect(locate({ platform: 'linux', env: { PATH: '' }, home: '/h', exists: () => false })).toBeNull();
  });
});

describe('folders', () => {
  it('compares Windows folders without case or slash direction', () => {
    expect(cwdKey('C:\\Users\\P\\Code\\App\\', 'win32')).toBe(cwdKey('c:/users/p/code/app', 'win32'));
    expect(cwdKey('/home/p/App/', 'linux')).toBe('/home/p/App');
    expect(cwdKey('/home/p/App', 'linux')).not.toBe(cwdKey('/home/p/app', 'linux'));
  });
});

describe('installing', () => {
  it('uses the official installer for each platform', () => {
    expect(installerCommand('win32').args.join(' ')).toContain('irm https://claude.ai/install.ps1 | iex');
    expect(installerCommand('darwin').args.join(' ')).toContain(
      'curl -fsSL https://claude.ai/install.sh | bash',
    );
  });

  it('runs one install at a time and reports success', async () => {
    let runs = 0;
    let release: () => void = () => undefined;
    const spawn: Spawner = () => {
      runs++;
      return new Promise((r) => {
        release = () => r({ code: 0, stdout: 'done', stderr: '', timedOut: false });
      });
    };
    const states: string[] = [];
    const inst = new ClaudeInstaller({ spawn, found: () => true, onChange: (s) => states.push(s) });
    const a = inst.install();
    const b = inst.install();
    expect(inst.state().state).toBe('installing');
    await new Promise((r) => setImmediate(r));
    release();
    await Promise.all([a, b]);
    expect(runs).toBe(1);
    expect(states).toEqual(['installing', 'installed']);
  });

  it('says why an install failed, in words', async () => {
    const spawn: Spawner = async () => ({
      code: 1,
      stdout: '',
      stderr: 'Downloading...\nerror: network unreachable\n',
      timedOut: false,
    });
    const inst = new ClaudeInstaller({ spawn, found: () => false });
    await inst.install();
    expect(inst.state()).toEqual({
      state: 'failed',
      error: 'The installer stopped: Downloading... error: network unreachable',
    });
    expect(failureWords('', '', 124, true)).toMatch(/ten minutes/);
    expect(failureWords('', '', 127, false)).toMatch(/could not start/);
  });

  it('fails when the installer finished but Claude Code cannot be found', async () => {
    const spawn: Spawner = async () => ({ code: 0, stdout: '', stderr: '', timedOut: false });
    const inst = new ClaudeInstaller({ spawn, found: () => false });
    await inst.install();
    expect(inst.state().error).toMatch(/not found/);
  });
});

describe('checking the install is Anthropic’s', () => {
  const manifest = { platforms: { [platformKey()]: { checksum: 'ABC123' } } };

  it('passes when the checksum matches and the signature is good', async () => {
    const v = new ClaudeVerifier({
      manifest: async () => manifest,
      hash: async () => 'abc123',
      signature: async () => null,
    });
    expect(await v.verify(FAKE, '2.1.286')).toEqual({ state: 'verified', error: null });
  });

  it('fails a checksum that does not match, and caches the answer', async () => {
    let hashed = 0;
    const v = new ClaudeVerifier({
      manifest: async () => manifest,
      hash: async () => {
        hashed++;
        return 'def456';
      },
      signature: async () => null,
    });
    const r = await v.verify(FAKE, '2.1.286');
    expect(r.state).toBe('failed');
    expect(r.error).toMatch(/^This Claude Code install could not be verified/);
    await v.verify(FAKE, '2.1.286');
    expect(hashed).toBe(1);
  });

  it('fails a bad signature, and when the release list cannot be reached', async () => {
    const bad = new ClaudeVerifier({
      manifest: async () => manifest,
      hash: async () => 'abc123',
      signature: async () => 'it is not signed by Anthropic, PBC.',
    });
    expect((await bad.verify(FAKE, '2.1.286')).error).toMatch(/Anthropic, PBC/);
    const offline = new ClaudeVerifier({
      manifest: async () => {
        throw new Error('offline');
      },
    });
    expect((await offline.verify(FAKE, '2.1.286')).error).toMatch(/could not be reached/);
  });

  it('checks the Windows signer through PowerShell', async () => {
    const spawn: Spawner = async (_c, _a, o) => ({
      code: 0,
      stdout: o.env?.ANCILE_VERIFY_PATH ? 'Valid|CN="Anthropic, PBC", O="Anthropic, PBC"' : '',
      stderr: '',
      timedOut: false,
    });
    const v = new ClaudeVerifier({
      manifest: async () => ({ platforms: { 'win32-x64': { checksum: 'aa' } } }),
      hash: async () => 'aa',
      spawn,
      platform: 'win32',
      arch: 'x64',
    });
    expect((await v.verify(FAKE, '1.0.0')).state).toBe('verified');
    const unsigned: Spawner = async () => ({ code: 0, stdout: 'NotSigned|', stderr: '', timedOut: false });
    const v2 = new ClaudeVerifier({
      manifest: async () => ({ platforms: { 'win32-x64': { checksum: 'aa' } } }),
      hash: async () => 'aa',
      spawn: unsigned,
      platform: 'win32',
      arch: 'x64',
    });
    expect((await v2.verify(FAKE, '1.0.1')).error).toMatch(/Windows signature/);
  });
});
