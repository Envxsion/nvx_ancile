/**
 * ------------------------------------------------------------------
 *  Title    |  A model with no list entry still has a readable name
 *  Ref      |  lib/format.ts
 *  ID       |  cockpit/test
 * ------------------------------------------------------------------
 *  Purpose  |  Found live: an answer's footer showed the raw id
 *           |  "google/gemini-3.5-flash-lite" where Anthropic models
 *           |  showed a display name.
 * ------------------------------------------------------------------
 */
import { describe, expect, it } from 'vitest';
import { modelName, prettyModelId } from '../src/lib/format';

describe('prettyModelId', () => {
  it('reads an id as words', () => {
    expect(prettyModelId('google/gemini-3.5-flash-lite')).toBe('Gemini 3.5 Flash Lite');
    expect(prettyModelId('openrouter/openai__gpt-oss-20b')).toBe('Gpt Oss 20b');
    expect(prettyModelId('google/gemini-flash:latest')).toBe('Gemini Flash');
  });
  it('modelName never shows the raw id', () => {
    expect(modelName('google/gemini-3.5-flash-lite')).toBe('Gemini 3.5 Flash Lite');
    expect(modelName(null)).toBe('Unknown model');
  });
});
