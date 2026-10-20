/**
 * Which line a model id belongs to, and which of two is newer (MD4).
 */
import { describe, expect, it } from 'vitest';
import {
  compareModels,
  compareVersions,
  dateOf,
  lineFor,
  lineOf,
  stripDate,
  vendorOf,
} from '../../../src/models/watch/lines';

describe('lineOf', () => {
  const cases: [string, string, string | null, string?, string?, (string | null)?][] = [
    // provider, id, line_id, tier, name, version
    ['anthropic', 'claude-opus-5-5', 'anthropic/opus', 'best', 'Claude Opus', '5.5'],
    ['anthropic', 'claude-sonnet-5-5', 'anthropic/sonnet', 'balanced', 'Claude Sonnet', '5.5'],
    ['anthropic', 'claude-haiku-4-5', 'anthropic/haiku', 'fast', 'Claude Haiku', '4.5'],
    ['anthropic', 'claude-haiku-4-5-20251001', 'anthropic/haiku', 'fast', 'Claude Haiku', '4.5'],
    ['anthropic', 'claude-fable-5-1', 'anthropic/fable', 'best', 'Claude Fable', '5.1'],
    ['anthropic', 'claude-opus-4-20250514', 'anthropic/opus', 'best', 'Claude Opus', '4.0'],
    ['anthropic', 'claude-3-5-sonnet-20241022', 'anthropic/sonnet', 'balanced', 'Claude Sonnet', '3.5'],
    ['anthropic', 'claude-3-opus-20240229', 'anthropic/opus', 'best', 'Claude Opus', '3.0'],
    ['anthropic', 'claude-sonnet-5-5-latest', null],
    ['anthropic', 'claude-instant-1', null],
    ['openai', 'gpt-5.5', 'openai/gpt', 'best', 'GPT', '5.5'],
    ['openai', 'gpt-5.5-2026-08-01', 'openai/gpt', 'best', 'GPT', '5.5'],
    ['openai', 'gpt-5-mini', 'openai/gpt-mini', 'balanced', 'GPT mini', '5'],
    ['openai', 'gpt-5.5-nano', 'openai/gpt-nano', 'fast', 'GPT nano', '5.5'],
    ['openai', 'gpt-4.1', 'openai/gpt', 'best', 'GPT', '4.1'],
    ['openai', 'gpt-6-astra', 'openai/astra', 'best', 'GPT Astra', '6'],
    ['openai', 'gpt-6.1-sol', 'openai/sol', 'balanced', 'GPT Sol', '6.1'],
    ['openai', 'gpt-6-luna', 'openai/luna', 'fast', 'GPT Luna', '6'],
    ['openai', 'gpt-5.6-luna', 'openai/luna', 'fast', 'GPT Luna', '5.6'],
    ['openai', 'gpt-6-sol-pro', null],
    ['google', 'gemini-4-argon', 'google/gemini-argon', 'best', 'Gemini Argon', '4'],
    ['openai', 'gpt-5.5-codex', null],
    ['openai', 'gpt-realtime-mini', null],
    ['openai', 'gpt-4o-audio-preview', null],
    ['openai', 'gpt-5-chat-latest', null],
    ['openai', 'gpt-image-1', null],
    ['openai', 'gpt-4o-mini-transcribe', null],
    ['openai', 'gpt-5-search-api', null],
    ['openai', 'text-embedding-3-small', null],
    ['openai', 'gpt-3.5-turbo-instruct', null],
    ['openai', 'gpt-4o-mini-tts', null],
    ['google', 'gemini-3-pro', 'google/gemini-pro', 'best', 'Gemini Pro', '3'],
    ['google', 'gemini-2.5-flash', 'google/gemini-flash', 'balanced', 'Gemini Flash', '2.5'],
    ['google', 'gemini-2.5-flash-lite', 'google/gemini-flash-lite', 'fast', 'Gemini Flash-Lite', '2.5'],
    ['google', 'gemini-3-pro-preview', 'google/gemini-pro', 'best', 'Gemini Pro', '3'],
    ['google', 'gemini-2.0-flash-001', 'google/gemini-flash', 'balanced', 'Gemini Flash', '2.0'],
    ['google', 'gemini-2.5-flash-image', null],
    ['google', 'gemini-2.5-flash-preview-tts', null],
    ['deepseek', 'deepseek-v4-pro', 'deepseek/pro', 'best', 'DeepSeek Pro', '4'],
    ['deepseek', 'deepseek-v4-flash', 'deepseek/flash', 'fast', 'DeepSeek Flash', '4'],
    ['deepseek', 'deepseek-flash', 'deepseek/flash', 'fast', 'DeepSeek Flash', null],
    ['deepseek', 'deepseek-chat', null],
    ['moonshot', 'kimi-k2', 'moonshot/kimi', 'best', 'Kimi', '2'],
    ['moonshot', 'kimi-k2.5', 'moonshot/kimi', 'best', 'Kimi', '2.5'],
    ['moonshot', 'kimi-k2-thinking', null],
    ['moonshot', 'kimi-k2-code', null],
    ['moonshot', 'kimi-k2-highspeed', null],
    ['xai', 'grok-4', 'xai/grok', 'best', 'Grok', '4'],
    ['xai', 'grok-3-mini', 'xai/grok-mini', 'fast', 'Grok mini', '3'],
    ['mistral', 'mistral-large-2411', 'mistral/large', 'best', 'Mistral Large', '2.1'],
    ['mistral', 'mistral-large-2512', 'mistral/large', 'best', 'Mistral Large', '3'],
    ['mistral', 'mistral-medium-3-5', 'mistral/medium', 'balanced', 'Mistral Medium', '3.5'],
    ['mistral', 'mistral-small-2603', 'mistral/small', 'fast', 'Mistral Small', '4'],
    ['mistral', 'mistral-small-2506', 'mistral/small', 'fast', 'Mistral Small', '3.2'],
    ['mistral', 'mistral-large-latest', null],
    ['zai', 'glm-5', 'zai/glm', 'best', 'GLM', '5'],
    ['zai', 'glm-5.3', 'zai/glm', 'best', 'GLM', '5.3'],
    ['zai', 'glm-5.3-flash', 'zai/glm-flash', 'fast', 'GLM Flash', '5.3'],
    ['zai', 'glm-5.3-flashx', 'zai/glm-flashx', 'fast', 'GLM FlashX', '5.3'],
    ['zai', 'glm-4v', null],
    ['qwen', 'qwen-max', 'qwen/max', 'best', 'Qwen Max', null],
    ['qwen', 'qwen3.7-plus', 'qwen/plus', 'balanced', 'Qwen Plus', '3.7'],
    ['qwen', 'qwen3.8-flash', 'qwen/flash', 'fast', 'Qwen Flash', '3.8'],
    ['qwen', 'qwen-vl-max-latest', null],
    ['minimax', 'MiniMax-M3', 'minimax/m', 'best', 'MiniMax', '3'],
    ['minimax', 'MiniMax-M2.7-highspeed', 'minimax/m-fast', 'fast', 'MiniMax fast', '2.7'],
    ['minimax', 'minimax-m3.1-flash-preview', 'minimax/m-fast', 'fast', 'MiniMax fast', '3.1'],
    ['moonshot', 'kimi-k3', 'moonshot/kimi', 'best', 'Kimi', '3'],
    ['moonshot', 'kimi-k2.6', 'moonshot/kimi', 'best', 'Kimi', '2.6'],
    ['moonshot', 'kimi-k2.7-code', null],
    ['moonshot', 'kimi-k2.7-code-highspeed', null],
    ['xai', 'grok-4.7', 'xai/grok', 'best', 'Grok', '4.7'],
    ['mistral', 'mistral-large-4', 'mistral/large', 'best', 'Mistral Large', '4'],
  ];
  for (const [provider, id, line, tier, name, version] of cases) {
    it(`${provider} ${id} -> ${line ?? 'no line'}`, () => {
      const l = lineOf(provider, id);
      if (line === null) return expect(l).toBeNull();
      expect(l).toMatchObject({ line_id: line, tier, name, version, preview: /preview/.test(id) });
    });
  }

  it('flags previews', () => {
    expect(lineOf('google', 'gemini-3-pro-preview')?.preview).toBe(true);
    expect(lineOf('google', 'gemini-3-pro-exp-0801')?.preview).toBe(true);
    expect(lineOf('anthropic', 'claude-opus-6-0-beta')?.preview).toBe(true);
    expect(lineOf('anthropic', 'claude-opus-6-preview')?.preview).toBe(true);
    expect(lineOf('openai', 'gpt-5.5-preview')?.preview).toBe(true);
    expect(lineOf('moonshot', 'kimi-k3-preview')?.preview).toBe(true);
  });
});

describe('endpoint providers', () => {
  it('reads the vendor from the host and keeps the registry provider in the line id', () => {
    expect(vendorOf('endpoint-api-deepseek-com', 'https://api.deepseek.com/v1')).toBe('deepseek');
    expect(vendorOf('endpoint-api-moonshot-ai', 'https://api.moonshot.ai/v1')).toBe('moonshot');
    expect(vendorOf('endpoint-localhost-8000', 'http://localhost:8000/v1')).toBeNull();
    expect(vendorOf('anthropic')).toBe('anthropic');
    expect(
      lineFor('endpoint-api-deepseek-com', 'https://api.deepseek.com/v1', 'deepseek-v4-pro')?.line_id,
    ).toBe('endpoint-api-deepseek-com/pro');
    expect(lineFor('endpoint-localhost-8000', 'http://localhost:8000/v1', 'gpt-5.5')).toBeNull();
  });
});

describe('versions', () => {
  it('compares numeric segments, not text', () => {
    expect(compareVersions('5.10', '5.9')).toBe(1);
    expect(compareVersions('5.5', '5.5')).toBe(0);
    expect(compareVersions('4', '4.0')).toBe(0);
    expect(compareVersions('4.5', '5')).toBe(-1);
    expect(compareVersions(null, '1')).toBe(-1);
    expect(compareVersions(null, null)).toBe(0);
  });

  it('ranks a dated snapshot as the same version, never newer than the undated id', () => {
    const undated = { version: '5.5', date: null };
    const dated = { version: '5.5', date: '20260801' };
    expect(compareModels(undated, dated)).toBeGreaterThan(0);
    expect(compareModels(dated, undated)).toBeLessThan(0);
    expect(compareModels({ version: '5.5', date: '20260901' }, dated)).toBeGreaterThan(0);
    expect(compareModels({ version: '5.6', date: '20260101' }, undated)).toBeGreaterThan(0);
  });

  it('breaks a tie by created_at', () => {
    const a = { version: '2', date: null, created: '2026-01-01' };
    const b = { version: '2', date: null, created: '2026-02-01' };
    expect(compareModels(b, a)).toBeGreaterThan(0);
  });

  it('reads and strips snapshot dates', () => {
    expect(dateOf('gpt-5.5-2026-08-01')).toBe('20260801');
    expect(dateOf('claude-haiku-4-5-20251001')).toBe('20251001');
    expect(dateOf('gpt-5.5')).toBeNull();
    expect(stripDate('gpt-5.5-2026-08-01')).toBe('gpt-5.5');
  });
});
