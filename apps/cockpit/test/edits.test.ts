/**
 * Editing a model or a grant sends only what changed: a config model never
 * sends the fields models.yaml owns, and an unchanged form sends nothing.
 */
import { describe, expect, it } from 'vitest';
import { grantPatch } from '../src/approvals/GrantMenu';
import type { ModelView } from '../src/lib/types';
import { modelPatch } from '../src/models/EditModel';

const pod: ModelView = {
  id: 'endpoint-pod/qwen3',
  name: 'Qwen',
  provider: 'Your server',
  hue: 'cyan',
  via: 'direct',
  contextWindow: 32000,
  status: 'ready',
  custom: true,
  baseUrl: 'https://pod-8000.proxy.runpod.net/v1',
  keyName: 'ENDPOINT_POD_KEY',
};

const same = {
  name: 'Qwen',
  context: '32000',
  enabled: true,
  hue: null,
  baseUrl: 'https://pod-8000.proxy.runpod.net/v1',
  keyName: 'ENDPOINT_POD_KEY',
  newKey: '',
};

describe('modelPatch', () => {
  it('sends nothing when nothing changed', () => {
    expect(modelPatch(pod, same)).toEqual({});
  });

  it('sends what changed on an added model, including the key by name or a new key', () => {
    expect(
      modelPatch(pod, {
        ...same,
        name: ' Qwen on the pod ',
        context: '131072',
        enabled: false,
        hue: 'jade',
        keyName: '',
        newKey: 'sk-new',
      }),
    ).toEqual({
      display_name: 'Qwen on the pod',
      context_window: 131072,
      enabled: false,
      hue: 'jade',
      secret: null,
      api_key: 'sk-new',
    });
  });

  it('sends only the colour and on/off for a config model', () => {
    const config: ModelView = { ...pod, custom: false, baseUrl: null, chosenHue: 'coral' };
    expect(modelPatch(config, { ...same, name: 'Renamed', hue: null, enabled: false })).toEqual({
      hue: null,
      enabled: false,
    });
  });
});

describe('grantPatch', () => {
  const g = { resource_pattern: 'fs:/workspace/docs/**', scope: 'always' as const };
  it('sends nothing when nothing changed', () => {
    expect(grantPatch(g, { pattern: g.resource_pattern, scope: 'always', expiry: 'keep' })).toEqual({});
  });
  it('sends a narrower pattern, a scope and an expiry', () => {
    expect(grantPatch(g, { pattern: 'fs:/workspace/docs/*.md', scope: 'thread', expiry: '3600' })).toEqual({
      resource_pattern: 'fs:/workspace/docs/*.md',
      scope: 'thread',
      ttl_seconds: 3600,
    });
    expect(grantPatch(g, { pattern: g.resource_pattern, scope: 'always', expiry: '0' })).toEqual({
      ttl_seconds: null,
    });
  });
});
