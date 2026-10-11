/**
 * Settings → API keys: add, replace and remove every credential; a value is
 * checked before it is saved, never returned, and an environment variable
 * wins (read-only row).
 */
import type { CredentialList, CredentialStatus } from '@nvx/contracts';
import { ClassifiedError } from '@nvx/resilience';
import { afterEach, describe, expect, it } from 'vitest';
import { RUNPOD_KEY_SECRET } from '../../src/compute/routes';
import { ENV_FOR_SECRET, HUGGINGFACE_TOKEN_SECRET, MEMORY_REMOTE_SECRET } from '../../src/credentials/routes';
import { GITHUB_TOKEN_SECRET } from '../../src/repos/github';
import { EnvFirstSecretStore, MemorySecretStore, SecretBox } from '../../src/secrets';
import { fakeModel } from '../gateway/fake-provider';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

const claude = {
  ...fakeModel('c', 'echo'),
  id: 'anthropic/claude-test',
  provider: 'anthropic',
  display_name: 'Claude Test',
  enabled: false,
};
const KEY = 'sk-ant-api03-first-key-0001';
const KEY2 = 'sk-ant-api03-second-key-0002';

const row = async (id: string) =>
  (await h.call<CredentialList>('GET', '/credentials')).body.items.find((x) => x.id === id);

describe('API keys', () => {
  it('lists every credential, none set, nothing secret', async () => {
    h = await harness();
    const r = await h.call<CredentialList>('GET', '/credentials');
    expect(r.status).toBe(200);
    expect(r.body.items.map((x) => x.id)).toEqual([
      'anthropic',
      'openai',
      'google',
      'openrouter',
      'runpod',
      'huggingface',
      'github',
      'memory_remote',
    ]);
    expect(r.body.items.every((x) => !x.set && x.last4 === null && x.source === null)).toBe(true);
    // No Controller in the harness: RunPod says why it cannot be added.
    expect(r.body.items.find((x) => x.id === 'runpod')).toMatchObject({ available: false });
  });

  it('adds, replaces and removes a provider key, returning only the last four', async () => {
    h = await harness({ models: [claude] });
    const add = await h.call<CredentialStatus>('PUT', '/credentials/anthropic', { value: ` ${KEY} ` });
    expect(add.status).toBe(200);
    expect(add.body).toMatchObject({ id: 'anthropic', set: true, last4: '0001', source: 'saved' });
    expect(JSON.stringify(add.body)).not.toContain(KEY);
    expect(await h.secrets.get('ANTHROPIC_API_KEY')).toBe(KEY);
    // A first key switches the provider's models on.
    expect(h.registry.info().find((m) => m.id === 'anthropic/claude-test')?.status).toBe('ready');

    await h.registry.setEnabled({ 'anthropic/claude-test': false });
    const replace = await h.call<CredentialStatus>('PUT', '/credentials/anthropic', { value: KEY2 });
    expect(replace.body.last4).toBe('0002');
    expect(await h.secrets.get('ANTHROPIC_API_KEY')).toBe(KEY2);
    // A replacement leaves your choices alone.
    expect(h.registry.info().find((m) => m.id === 'anthropic/claude-test')?.status).not.toBe('ready');

    const list = await h.call<CredentialList>('GET', '/credentials');
    expect(JSON.stringify(list.body)).not.toContain(KEY2);

    const del = await h.call<CredentialStatus>('DELETE', '/credentials/anthropic');
    expect(del.body).toMatchObject({ set: false, last4: null, source: null });
    expect(await h.secrets.get('ANTHROPIC_API_KEY')).toBeUndefined();
  });

  it('keeps a key the provider rejects out of the store and out of the error', async () => {
    h = await harness({
      models: [claude],
      tester: async ({ key }) => {
        throw Object.assign(new Error(`401 invalid x-api-key ${key}`), { status: 401 });
      },
    });
    const r = await h.call<{ error: { code: string; detail?: string } }>('PUT', '/credentials/anthropic', {
      value: KEY,
    });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('provider.auth_failed');
    expect(JSON.stringify(r.body)).not.toContain(KEY);
    expect(await h.secrets.get('ANTHROPIC_API_KEY')).toBeUndefined();
  });

  it('checks Hugging Face and GitHub tokens with the service', async () => {
    const seen: string[] = [];
    h = await harness({
      credentials: {
        serviceCheck: async (id, token) => {
          seen.push(id);
          if (token.includes('bad')) throw new ClassifiedError('permanent', 'nope', { status: 401 });
        },
      },
    });
    const ok = await h.call<CredentialStatus>('PUT', '/credentials/huggingface', {
      value: 'hf_goodtoken0000abcd',
    });
    expect(ok.body).toMatchObject({ set: true, last4: 'abcd' });
    expect(await h.secrets.get(HUGGINGFACE_TOKEN_SECRET)).toBe('hf_goodtoken0000abcd');

    const bad = await h.call<{ error: { code: string; title: string } }>('PUT', '/credentials/github', {
      value: 'ghp_badtoken00000000',
    });
    expect(bad.status).toBe(502);
    expect(bad.body.error).toMatchObject({
      code: 'credentials.rejected',
      title: 'GitHub rejected the token',
    });
    expect(await h.secrets.get(GITHUB_TOKEN_SECRET)).toBeUndefined();
    expect(seen).toEqual(['huggingface', 'github']);
  });

  it('takes a memory remote git can push to, and refuses anything else', async () => {
    h = await harness();
    const bad = await h.call<{ error: { code: string } }>('PUT', '/credentials/memory_remote', {
      value: 'not a remote',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('credentials.invalid');
    const ok = await h.call<CredentialStatus>('PUT', '/credentials/memory_remote', {
      value: 'git@github.com:me/memory.git',
    });
    expect(ok.body).toMatchObject({ set: true, last4: '.git' });
    expect(await h.secrets.get(MEMORY_REMOTE_SECRET)).toBe('git@github.com:me/memory.git');
  });

  it('connects RunPod through the Controller, which checks the key first', async () => {
    const calls: string[] = [];
    let secrets: Harness['secrets'] | undefined;
    h = await harness({
      credentials: {
        runpod: {
          connect: async (key) => {
            calls.push('connect');
            if (key !== 'rpa_good_key_0000') throw new Error(`RunPod said no to ${key}`);
            await secrets?.set(RUNPOD_KEY_SECRET, key);
          },
          disconnect: async () => {
            calls.push('disconnect');
            await secrets?.delete(RUNPOD_KEY_SECRET);
          },
        },
      },
    });
    secrets = h.secrets;
    const bad = await h.call<{ error: { code: string } }>('PUT', '/credentials/runpod', {
      value: 'rpa_wrong_key_000',
    });
    expect(bad.status).toBe(502);
    expect(JSON.stringify(bad.body)).not.toContain('rpa_wrong_key_000');
    const ok = await h.call<CredentialStatus>('PUT', '/credentials/runpod', { value: 'rpa_good_key_0000' });
    expect(ok.body).toMatchObject({ set: true, last4: '0000', available: true });
    await h.call('DELETE', '/credentials/runpod');
    expect(await row('runpod')).toMatchObject({ set: false });
    expect(calls).toEqual(['connect', 'connect', 'disconnect']);
  });

  it('shows an environment value as read-only and refuses to change it', async () => {
    h = await harness({ credentials: { env: { OPENAI_API_KEY: 'sk-proj-from-the-env-9876' } } });
    expect(await row('openai')).toMatchObject({ set: true, source: 'environment', last4: '9876' });
    const put = await h.call<{ error: { code: string } }>('PUT', '/credentials/openai', { value: KEY });
    expect(put.status).toBe(409);
    expect(put.body.error.code).toBe('credentials.from_environment');
    const del = await h.call<{ error: { code: string } }>('DELETE', '/credentials/openai');
    expect(del.status).toBe(409);
  });

  it('says plainly when a credential does not exist', async () => {
    h = await harness();
    const r = await h.call<{ error: { code: string } }>('PUT', '/credentials/nope', { value: KEY });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('credentials.unknown');
  });
});

describe('environment first', () => {
  it('reads the environment before the saved value, and lists it', async () => {
    const inner = new MemorySecretStore(new SecretBox(Buffer.alloc(32, 7).toString('base64')));
    await inner.set('ANTHROPIC_API_KEY', 'saved');
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'from-env', HF_TOKEN: 'hf-env' };
    const s = new EnvFirstSecretStore(inner, env, ENV_FOR_SECRET);
    expect(await s.get('ANTHROPIC_API_KEY')).toBe('from-env');
    expect(await s.names()).toContain(HUGGINGFACE_TOKEN_SECRET);
    env.ANTHROPIC_API_KEY = undefined;
    expect(await s.get('ANTHROPIC_API_KEY')).toBe('saved');
  });
});
