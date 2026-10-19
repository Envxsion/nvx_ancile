/**
 * LB2 /init: a starter AGENTS.md drafted only from what the repository says,
 * writing nothing, with a diff when one already exists. Saving is the editor's
 * file write (gate, confinement, never over an existing file; see files.test.ts).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { draftAgentsMd, initDraft } from '../../src/lab/init';
import { labRoutes } from '../../src/lab/routes';

let base: string;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'init-'));
  const r = join(base, 'web');
  mkdirSync(join(r, 'src'), { recursive: true });
  mkdirSync(join(r, 'node_modules', 'x'), { recursive: true });
  writeFileSync(
    join(r, 'package.json'),
    JSON.stringify({
      name: 'web',
      packageManager: 'pnpm@9',
      scripts: { build: 'tsc', test: 'vitest run', lint: 'biome check', dev: 'vite' },
    }),
  );
  writeFileSync(join(r, 'biome.json'), '{}');
  writeFileSync(join(r, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
  writeFileSync(join(r, '.editorconfig'), 'indent_style = space\nindent_size = 2\n');
  mkdirSync(join(base, 'bare'));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('draftAgentsMd', () => {
  it('lists the commands, layout and conventions the files state, and nothing else', async () => {
    const text = await draftAgentsMd(join(base, 'web'), 'web');
    expect(text).toContain('# web');
    expect(text).toContain('- `pnpm build`: `tsc`');
    expect(text).toContain('- `pnpm test`: `vitest run`');
    expect(text).toContain('- `src/`');
    expect(text).not.toContain('node_modules');
    expect(text).toContain('Biome');
    expect(text).toContain('strict mode');
    expect(text).toContain('Indent with 2 spaces');
    expect(text).not.toContain('cargo');
  });

  it('says so when there is nothing to describe', async () => {
    expect(await draftAgentsMd(join(base, 'bare'), 'bare')).toContain(
      'No build commands or configuration were found',
    );
  });
});

describe('initDraft', () => {
  it('writes nothing, and offers a diff instead of overwriting an existing file', async () => {
    const r = join(base, 'web');
    const fresh = await initDraft(r, 'web', sha);
    expect(fresh).toMatchObject({
      exists: false,
      existing_sha256: null,
      diff: null,
      path: join(r, 'AGENTS.md'),
    });
    writeFileSync(join(r, 'AGENTS.md'), 'my own rules\n');
    const again = await initDraft(r, 'web', sha);
    expect(again.exists).toBe(true);
    expect(again.existing_sha256).toBe(sha('my own rules\n'));
    expect(again.diff).toContain('-my own rules');
    expect(readFileSync(join(r, 'AGENTS.md'), 'utf8')).toBe('my own rules\n');
  });
});

describe('POST /lab/init', () => {
  it('drafts for a registered repository and refuses an unknown body', async () => {
    const app = labRoutes({
      engine: null,
      repo: {} as never,
      runs: {} as never,
      worker: { kick: () => undefined },
      workspaceId: 'w',
      workspaceDir: base,
      workspaceRoot: '/workspace',
      snapshotsDir: base,
      repos: { get: async () => ({ root: join(base, 'bare'), name: 'bare' }) },
    });
    const post = (b: unknown) =>
      app.request('/lab/init', {
        method: 'POST',
        body: JSON.stringify(b),
        headers: { 'content-type': 'application/json' },
      });
    const ok = await post({ repo_id: 'rep_1' });
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { exists: boolean }).toMatchObject({ exists: false });
    expect((await post({ repo_id: 'rep_1', write: true })).status).toBeGreaterThanOrEqual(400);
  });
});
