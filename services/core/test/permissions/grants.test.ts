/**
 * Editing and revoking remembered grants (Admin → Permissions): a pattern
 * can only narrow, a scope change takes its reference from the approval it
 * came from, Careful never widens, and a revocation can be undone for a
 * short while and not after.
 */
import type { Grant, RunEvent } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { GRANT_RESTORE_WINDOW_MS, patternNarrows } from '../../src/permissions/routes';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

async function grantFor(path: string, pattern: string, scope = 'always'): Promise<Grant> {
  const t = await h.newThread();
  const sent = await h.send(t, `/tool fs_write {"path":"${path}","content":"x"}`);
  expect((await h.settle(sent.run_id)).status).toBe('waiting_approval');
  const ask = (await h.eventsOf(sent.run_id)).find(
    (e): e is Extract<RunEvent, { type: 'approval.required' }> => e.type === 'approval.required',
  );
  const r = await h.call('POST', `/approvals/${ask?.approval_id}`, { decision: 'approve', scope, pattern });
  expect(r.status).toBe(200);
  await h.settle(sent.run_id);
  const items = (await h.call<{ items: Grant[] }>('GET', '/grants')).body.items;
  return items[0] as Grant;
}

describe('patternNarrows', () => {
  it('accepts only patterns inside the granted one', () => {
    expect(patternNarrows('fs:/workspace/**', 'fs:/workspace/docs/**')).toBe(true);
    expect(patternNarrows('fs:/workspace/**', 'fs:/workspace/docs/*.md')).toBe(true);
    expect(patternNarrows('fs:/workspace/docs/*', 'fs:/workspace/docs/a.md')).toBe(true);
    expect(patternNarrows('fs:/workspace/docs/**', 'fs:/workspace/**')).toBe(false);
    expect(patternNarrows('fs:/workspace/docs/**', 'fs:/workspace/notes/**')).toBe(false);
    // `*` matches the text "**", but ** reaches any depth.
    expect(patternNarrows('fs:/workspace/docs/*', 'fs:/workspace/docs/**')).toBe(false);
    expect(patternNarrows('fs:/workspace/docs/*.md', '**')).toBe(false);
  });
});

describe('editing grants', () => {
  it('narrows a pattern and refuses to widen one', async () => {
    h = await harness();
    const g = await grantFor('docs/a.md', 'fs:/workspace/docs/**');
    const narrowed = await h.call<Grant>('PATCH', `/grants/${g.id}`, {
      resource_pattern: 'fs:/workspace/docs/*.md',
    });
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.resource_pattern).toBe('fs:/workspace/docs/*.md');
    const wide = await h.call<{ error: { code: string } }>('PATCH', `/grants/${g.id}`, {
      resource_pattern: 'fs:/workspace/docs/**',
    });
    expect(wide.status).toBe(422);
    expect(wide.body.error.code).toBe('permission.pattern_too_broad');
  });

  it('changes scope with the reference from its approval, and the expiry', async () => {
    h = await harness();
    const g = await grantFor('docs/b.md', 'fs:/workspace/docs/b.md');
    expect(g.scope).toBe('always');
    const thread = await h.call<Grant>('PATCH', `/grants/${g.id}`, { scope: 'thread', ttl_seconds: 3600 });
    expect(thread.status).toBe(200);
    expect(thread.body.scope).toBe('thread');
    expect(thread.body.scope_ref).toMatch(/^thr_/);
    expect(Date.parse(thread.body.expires_at ?? '')).toBeGreaterThan(Date.now());
    const forever = await h.call<Grant>('PATCH', `/grants/${g.id}`, { ttl_seconds: null });
    expect(forever.body.expires_at).toBeNull();
    const back = await h.call<Grant>('PATCH', `/grants/${g.id}`, { scope: 'always' });
    expect(back.body).toMatchObject({ scope: 'always', scope_ref: null });
  });

  it('never widens a scope past the thread under Careful, but narrows', async () => {
    h = await harness();
    const g = await grantFor('docs/c.md', 'fs:/workspace/docs/c.md', 'workspace');
    await h.call('PUT', '/permissions/preset', { preset: 'careful' });
    const wide = await h.call<{ error: { code: string } }>('PATCH', `/grants/${g.id}`, { scope: 'always' });
    expect(wide.body.error.code).toBe('permission.scope_too_wide');
    const narrow = await h.call<Grant>('PATCH', `/grants/${g.id}`, { scope: 'thread' });
    expect(narrow.status).toBe(200);
  });

  it('answers 404 for a grant that is gone', async () => {
    h = await harness();
    expect((await h.call('PATCH', '/grants/gnt_missing', { ttl_seconds: 60 })).status).toBe(404);
  });
});

describe('revoking grants', () => {
  it('revokes, and puts it back within the undo window', async () => {
    h = await harness();
    const g = await grantFor('docs/d.md', 'fs:/workspace/docs/d.md');
    expect((await h.call('DELETE', `/grants/${g.id}`)).status).toBe(204);
    expect((await h.call<{ items: Grant[] }>('GET', '/grants')).body.items).toHaveLength(0);
    const back = await h.call<Grant>('POST', `/grants/${g.id}/restore`);
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ id: g.id, revoked_at: null, resource_pattern: g.resource_pattern });
    expect((await h.call<{ items: Grant[] }>('GET', '/grants')).body.items).toHaveLength(1);
  });

  it('refuses to undo a revocation after the window', async () => {
    h = await harness();
    const g = await grantFor('docs/e.md', 'fs:/workspace/docs/e.md');
    await h.call('DELETE', `/grants/${g.id}`);
    const start = Date.now();
    h.perms.now = () => start + GRANT_RESTORE_WINDOW_MS + 1000;
    const late = await h.call<{ error: { code: string } }>('POST', `/grants/${g.id}/restore`);
    expect(late.status).toBe(410);
    expect(late.body.error.code).toBe('permission.restore_expired');
  });
});
