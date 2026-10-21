/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code as a model keeps the work of the thread (HO1)
 *  Ref      |  ROADMAP.md HO1 · engines/mode-a.ts · docs/engines.md
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  Mode A used to see a 32k window and a text-only prompt:
 *           |  tool steps and citations vanished, older turns were cut
 *           |  with one vague line, and images were always dropped
 *           |  though Claude reads them. Now its window is the model's
 *           |  real one less Claude Code's own setup, tool steps are
 *           |  one-line digests, and images go in as image input.
 * ------------------------------------------------------------------
 */

import type { ModelConfig, Part } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import {
  aliasWindow,
  CLAUDE_CODE_OVERHEAD,
  CLAUDE_CODE_WINDOW,
  claudeCodeModels,
  MODE_A_IMAGES,
  MODE_A_PROMPT_TOKENS,
  MODE_A_WINDOW,
  promptBudget,
  promptOf,
  promptWithImages,
} from '../../src/engines/mode-a';

const listed = (provider_model: string, context_window: number) =>
  ({ provider: 'anthropic', provider_model, context_window }) as ModelConfig;

describe('the window of a Claude Code model', () => {
  it('is the lineup entry, at most the 200k the aliases run, less its own setup', () => {
    const lineup = [
      listed('claude-opus-5-5', 1_000_000),
      listed('claude-sonnet-5-5', 1_000_000),
      listed('claude-haiku-4-5-20251001', 200_000),
    ];
    expect(aliasWindow('opus', lineup)).toBe(CLAUDE_CODE_WINDOW - CLAUDE_CODE_OVERHEAD);
    expect(aliasWindow('haiku', lineup)).toBe(CLAUDE_CODE_WINDOW - CLAUDE_CODE_OVERHEAD);
    // The default alias is Sonnet's; a line the account does not list falls back to the 200k.
    expect(aliasWindow('default', [listed('claude-sonnet-5-5', 150_000)])).toBe(
      150_000 - CLAUDE_CODE_OVERHEAD,
    );
    expect(aliasWindow('sonnet', [])).toBe(MODE_A_WINDOW);
  });

  it('is set on every model, the monthly-credit twins too, and they see images', () => {
    const models = claudeCodeModels([
      listed('claude-haiku-4-5', 100_000),
      listed('claude-sonnet-5-5', 1_000_000),
    ]);
    const by = Object.fromEntries(models.map((m) => [m.id, m.context_window]));
    expect(by['claude-code/haiku']).toBe(100_000 - CLAUDE_CODE_OVERHEAD);
    expect(by['claude-code/haiku@credit']).toBe(100_000 - CLAUDE_CODE_OVERHEAD);
    expect(by['claude-code/sonnet']).toBe(CLAUDE_CODE_WINDOW - CLAUDE_CODE_OVERHEAD);
    expect(models.every((m) => m.capabilities.includes('vision') && m.capabilities.includes('tools'))).toBe(
      true,
    );
  });

  it('lets a prompt carry what the window holds, not 20k', () => {
    const [m] = claudeCodeModels();
    const budget = promptBudget(m as ModelConfig, { messages: [], system: 'x'.repeat(4_000) });
    expect(budget).toBeGreaterThan(100_000);
    expect(budget).toBeLessThan((m as ModelConfig).context_window);
  });
});

describe('what Claude Code is told of the conversation', () => {
  const call = (id: string, tool: string, args: unknown): Part => ({
    type: 'tool_call',
    call_id: id,
    tool,
    args,
  });
  const result = (id: string, text: string): Part => ({
    type: 'tool_result',
    call_id: id,
    ok: true,
    result: text,
  });

  it('gives an earlier answer its tool steps as one line each, never the whole output', () => {
    const big = 'line of the file\n'.repeat(500);
    const prompt = promptOf({
      messages: [
        { role: 'user', content: 'read it', parts: [{ type: 'text', text: 'read it' }] },
        {
          role: 'assistant',
          content: 'Done.',
          parts: [
            { type: 'text', text: 'Reading.' },
            call('c1', 'Read', { file_path: 'src/app.ts' }),
            result('c1', big),
            call('c2', 'Bash', { command: 'pnpm test' }),
            result('c2', 'exit code: 0'),
            { type: 'text', text: 'Done.' },
          ],
        },
        { role: 'user', content: 'now what?', parts: [{ type: 'text', text: 'now what?' }] },
      ],
    });
    expect(prompt).toMatch(/\[tool\] read src\/app\.ts \(50\d lines\)/);
    expect(prompt).toContain('[tool] ran `pnpm test` → exit 0');
    expect(prompt).not.toContain('line of the file');
    expect(prompt).toContain('Assistant: Reading.');
  });

  const pixel = (n: number) => new Uint8Array(n).fill(7);
  const image = (url: string, caption?: string): Part =>
    ({ type: 'image', url, mime: 'image/png', ...(caption && { caption }) }) as Part;

  it('passes the conversation images as image input and numbers them in the text', () => {
    const { prompt, images } = promptWithImages(
      {
        messages: [
          {
            role: 'user',
            content: '',
            parts: [{ type: 'text', text: 'First picture: ' }, image('u1', 'a pump')],
          },
          { role: 'assistant', content: 'A pump.', parts: [{ type: 'text', text: 'A pump.' }] },
          { role: 'user', content: '', parts: [{ type: 'text', text: 'And this one? ' }, image('u2')] },
        ],
      },
      MODE_A_PROMPT_TOKENS,
      new Map([
        ['u1', { data: pixel(10), mime: 'image/png' }],
        ['u2', { data: pixel(20), mime: 'image/jpeg' }],
      ]),
    );
    expect(images.map((i) => i.mime)).toEqual(['image/png', 'image/jpeg']);
    expect(Buffer.from(images[1]?.data ?? '', 'base64').byteLength).toBe(20);
    expect(prompt).toContain('First picture: \n[Image 1 attached]');
    expect(prompt).toContain('And this one? \n[Image 2 attached]');
  });

  it('describes an image it cannot pass, and keeps only the newest ones past the limit', () => {
    const urls = Array.from({ length: MODE_A_IMAGES + 2 }, (_, i) => `u${i}`);
    const messages = urls.map((u) => ({
      role: 'user' as const,
      content: '',
      parts: [image(u, `picture ${u}`)],
    }));
    const pixels = new Map(urls.map((u) => [u, { data: pixel(5), mime: 'image/png' }] as const));
    pixels.delete('u7');
    const { prompt, images } = promptWithImages({ messages }, MODE_A_PROMPT_TOKENS, pixels);
    // Eight images, one with no bytes: the newest known ones, six of them, are passed.
    expect(images).toHaveLength(MODE_A_IMAGES);
    expect(prompt).toContain('[Image, described: picture u0]');
    expect(prompt).toContain('[Image, described: picture u7]');
    expect(prompt).toContain('[Image 1 attached]');
    expect(prompt).toContain(`[Image ${MODE_A_IMAGES} attached]`);
    // An image too large for Claude (5 MB) is described, not sent.
    const huge = promptWithImages(
      { messages: [{ role: 'user', content: '', parts: [image('h', 'a poster')] }] },
      MODE_A_PROMPT_TOKENS,
      new Map([['h', { data: pixel(6 * 1024 * 1024), mime: 'image/png' }]]),
    );
    expect(huge.images).toHaveLength(0);
    expect(huge.prompt).toContain('[Image, described: a poster]');
  });

  it('does not attach an image the cut left out', () => {
    const old = {
      role: 'user' as const,
      content: '',
      parts: [image('old'), { type: 'text', text: 'x'.repeat(8_000) } as Part],
    };
    const { images, prompt } = promptWithImages(
      { messages: [old, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'latest' }] },
      500,
      new Map([['old', { data: pixel(5), mime: 'image/png' }]]),
    );
    expect(images).toHaveLength(0);
    expect(prompt).toContain('left out');
  });
});
