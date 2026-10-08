import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { annotationsFor, defineTool, toMcpRegistration, validateManifest } from '../src';

describe('defineTool', () => {
  it('refuses destructive AUTO tools', () => {
    expect(() =>
      defineTool({
        name: 'rm',
        description: '',
        input: z.object({}),
        action: 'fs.delete',
        tier: 'auto',
        destructive: true,
        resource: () => 'fs:/x',
        handler: async () => null,
      }),
    ).toThrow(/never be AUTO/);
  });

  it('maps tiers to MCP hints and passes the idempotency key through', async () => {
    const seen: (string | undefined)[] = [];
    const tool = defineTool({
      name: 'word_count',
      description: 'Count words',
      input: z.object({ text: z.string() }),
      action: 'text.read',
      tier: 'auto',
      resource: () => 'text:inline',
      handler: async ({ text }, ctx) => {
        seen.push(ctx.idempotencyKey);
        return text.split(/\s+/).length;
      },
    });
    expect(annotationsFor(tool)).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const reg = toMcpRegistration(tool);
    const out = await reg.handler(
      { text: 'one two three' },
      { _meta: { 'sh.nvx.ancile/idempotency_key': 'k1' } },
    );
    expect(out.content[0]?.text).toBe('3');
    expect(seen).toEqual(['k1']);
  });
});

describe('validateManifest', () => {
  it('explains problems by path', () => {
    const r = validateManifest({
      id: 'Bad Id',
      name: 'x',
      version: '1',
      kind: 'tools',
      entry: 'a',
      description: '',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.some((p) => p.startsWith('id:'))).toBe(true);
  });

  it('accepts a good manifest', () => {
    const r = validateManifest({
      id: 'word-tools',
      name: 'Word tools',
      version: '0.1.0',
      kind: 'tools',
      entry: 'dist/server.js',
      description: 'Counting things',
      tools: [{ name: 'word_count', action: 'text.read', tier: 'auto' }],
    });
    expect(r.ok).toBe(true);
  });
});
