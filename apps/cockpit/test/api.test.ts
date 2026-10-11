/**
 * The API client: Core's own errors, 502s included, are shown as Core said
 * them; only a failure in front of Core (no answer, or the dev proxy's bare
 * 5xx) means Core is offline.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiCallError, api, OfflineError } from '../src/lib/api';

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    }),
  );

afterEach(() => vi.restoreAllMocks());

describe('api client', () => {
  it("shows Core's own 502 (a provider that is not answering) as Core's answer", async () => {
    reply(
      502,
      {
        error: {
          code: 'provider.unavailable',
          title: "Ollama isn't answering",
          hint: 'Start Ollama (ollama serve), then test again.',
          retryable: false,
          trace_id: 'a'.repeat(32),
          attempts: [],
          context: { service: 'core' },
        },
      },
      { 'x-trace-id': 'a'.repeat(32) },
    );
    const err = await api.post('/setup/providers/test', { provider: 'ollama' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiCallError);
    expect((err as ApiCallError).body.error.title).toBe("Ollama isn't answering");
  });

  it('treats a bare 502 or 504 from the dev proxy as Core offline', async () => {
    for (const status of [500, 502, 504]) {
      reply(status, null);
      await expect(api.get('/system/health')).rejects.toBeInstanceOf(OfflineError);
      vi.restoreAllMocks();
    }
  });

  it('treats no answer at all as Core offline', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(api.get('/system/health')).rejects.toBeInstanceOf(OfflineError);
  });
});
