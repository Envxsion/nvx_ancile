/**
 * Antivirus removed the downloaded Agent SDK, the bridge, or Claude Code
 * itself after it was checked (ROADMAP.md track G): the error names the
 * folder to allow instead of a generic failure.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { processLauncher } from '../../src/claudecode/bridge';
import { blockedPath, ccErrors, folderToAllow } from '../../src/claudecode/errors';
import { ClaudeInstaller, installFolder } from '../../src/claudecode/install';
import { ClaudeVerifier } from '../../src/claudecode/verify';

const SDK = 'C:\\Users\\ana\\AppData\\Roaming\\NVX Ancile\\claude-bridge\\claude-sdk';

describe('a downloaded file that vanished', () => {
  it("names the Agent SDK's folder when the SDK cannot be loaded any more", () => {
    const why = `Cannot find module '${SDK}\\node_modules\\@anthropic-ai\\claude-agent-sdk\\sdk.mjs' imported from bridge`;
    expect(blockedPath(why)).toBe(`${SDK}\\node_modules\\@anthropic-ai\\claude-agent-sdk\\sdk.mjs`);
    const e = ccErrors.sdkUnavailable(why);
    expect(e.code).toBe('claude_code.file_blocked');
    expect(e.title).toBe("Anthropic's Agent SDK was removed or blocked after it was checked");
    expect(e.hint).toBe(
      `Security software may have quarantined it. Allow the folder ${SDK} in your antivirus, then press Check again.`,
    );
    expect(e.context).toEqual({ folder: SDK });
  });

  it('reads POSIX paths and locked files too', () => {
    const why =
      "EPERM: operation not permitted, open '/home/ana/.local/share/NVX Ancile/claude-bridge/claude-sdk/node_modules/x/cli.js'";
    expect(folderToAllow(blockedPath(why) as string)).toBe(
      '/home/ana/.local/share/NVX Ancile/claude-bridge/claude-sdk',
    );
  });

  it('keeps the network error for a first download that never arrived', () => {
    const e = ccErrors.sdkUnavailable('fetch failed: getaddrinfo ENOTFOUND registry.npmjs.org');
    expect(e.code).toBe('claude_code.sdk_unavailable');
  });
});

describe('the bridge program', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('names its folder when the program cannot be opened', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ancile-'));
    dirs.push(dir);
    const entry = join(dir, 'claude-bridge', 'dist', 'main.js');
    const launch = processLauncher({ dataDir: dir, entry, readyTimeoutMs: 200 });
    const err = (await launch().catch((e: unknown) => e)) as Error;
    const mapped = ccErrors.sdkUnavailable(err.message);
    expect(mapped.code).toBe('claude_code.file_blocked');
    expect(mapped.title).toBe('The Claude bridge was removed or blocked after it was checked');
    expect(mapped.context.folder).toBe(join(dir, 'claude-bridge'));
  });
});

describe('Claude Code itself', () => {
  const manifest = async () => ({ platforms: { 'win32-x64': { checksum: 'abc' } } });

  it('says which folder to allow when the program vanished after it passed the check', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ancile-cc-'));
    const exe = join(dir, 'claude.exe');
    writeFileSync(exe, 'x');
    let gone = false;
    const v = new ClaudeVerifier({
      manifest,
      platform: 'win32',
      arch: 'x64',
      signature: async () => null,
      hash: async () => {
        if (gone) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return 'abc';
      },
    });
    try {
      expect((await v.verify(exe, '2.1.300')).state).toBe('verified');
      rmSync(exe);
      gone = true;
      const r = await v.verify(exe, '2.1.300');
      expect(r.state).toBe('failed');
      expect(r.error).toContain('was removed or blocked after it was checked');
      expect(r.error).toContain(`allow the folder ${dir} in your antivirus`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the install folder when a successful install is gone at once', async () => {
    const states: (string | null)[] = [];
    const installer = new ClaudeInstaller({
      found: () => false,
      spawn: async () => ({ code: 0, stdout: 'Installed', stderr: '', timedOut: false }),
      onChange: (_s, err) => states.push(err),
    });
    await installer.install();
    expect(installer.state().state).toBe('failed');
    expect(installer.state().error).toContain(installFolder());
    expect(installer.state().error).toContain('allow that folder in your antivirus');
  });
});
