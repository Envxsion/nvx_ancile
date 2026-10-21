/**
 * Recording real web replies (dev only): off until armed, expires, one
 * capture per route, and the saved file holds no key and no headers.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARM_MS, redact, WebRecorder } from '../../src/diagnostics/web-record';

const KEY = 'sk-or-secretvalue1234567890';
const body = {
  id: 'gen-abcdefgh12345',
  choices: [{ message: { content: `Everest is 8,849 m. ${KEY}` } }],
  content: [
    { type: 'web_search_tool_result', encrypted_content: 'AAAA', tool_use_id: 'srvtoolu_abcdefgh1234' },
  ],
};
const real: typeof fetch = async () =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'x-secret-header': 'nope' } });

let dirs: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'webrec-'));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

describe('WebRecorder', () => {
  it('records nothing when not armed', async () => {
    const rec = new WebRecorder(await tmp());
    expect(rec.wrap('openrouter', 'm', 'q', KEY, real)).toBe(real);
    expect(rec.state().armed).toBe(false);
    expect(await rec.files()).toEqual([]);
  });

  it('records one reply per route, redacted, with no headers', async () => {
    const dir = await tmp();
    const rec = new WebRecorder(dir);
    rec.arm();
    expect(rec.state().waiting).toHaveLength(3);
    const f = rec.wrap('openrouter', 'model-x', 'Mount Everest height', KEY, real);
    expect(f).not.toBe(real);
    expect((await f('https://x.test')).ok).toBe(true);
    await rec.settled();
    // A second lookup of the same route is not recorded.
    expect(rec.wrap('openrouter', 'm', 'q', KEY, real)).toBe(real);
    const text = await readFile(join(dir, 'diagnostics', 'web', 'openrouter.json'), 'utf8');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('x-secret-header');
    expect(text).not.toContain('gen-abcdefgh12345');
    expect(text).not.toContain('srvtoolu_abcdefgh1234');
    expect(text).not.toContain('AAAA');
    const saved = JSON.parse(text);
    expect(saved).toMatchObject({ route: 'openrouter', query: 'Mount Everest height', model: 'model-x' });
    expect(saved.response.choices[0].message.content).toContain('Everest is 8,849 m.');
    expect(rec.state().waiting).toEqual(['google', 'anthropic']);
    expect(await rec.files()).toEqual(['openrouter.json']);
  });

  it('expires after ten minutes', async () => {
    let t = 1_000_000;
    const rec = new WebRecorder(await tmp(), () => t);
    rec.arm();
    t += ARM_MS + 1;
    expect(rec.state().armed).toBe(false);
    expect(rec.wrap('anthropic', 'm', 'q', KEY, real)).toBe(real);
  });

  it('redact masks the key anywhere in the tree', () => {
    expect(JSON.stringify(redact({ a: [`x ${KEY} y`], signature: 's' }, [KEY]))).not.toContain(KEY);
  });
});
