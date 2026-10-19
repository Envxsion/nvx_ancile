/**
 * ------------------------------------------------------------------
 *  Title    |  Loaded now
 *  Ref      |  ROADMAP LM1 · docs/models.md (Loaded now)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A strip at the top of Admin → Models that says which
 *           |  Ollama models are in memory, how much they use and
 *           |  when Ollama will let them go, with Unload and Keep
 *           |  loaded. It is why the first message after a pause
 *           |  can be slow, said in words.
 *  How      |  GET /local-models/loaded, refreshed every ten seconds
 *           |  while the page is visible and never while it is
 *           |  hidden. Unload and Keep loaded answer with the new
 *           |  list. Nothing shows when Ollama is not answering or
 *           |  has nothing loaded; an Ollama too old to say gets one
 *           |  line.
 *  Note     |  Models something else loaded are listed without
 *           |  buttons: only models NVX Ancile lists can be changed.
 * ------------------------------------------------------------------
 */

import type { LoadedModel, LoadedModelsView } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiCallError, api } from '../lib/api';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import '../styles/loaded.css';
import { Icon } from '../ui/Icon';

export const LOADED_KEY = ['local-models', 'loaded'] as const;
export const REFRESH_MS = 10_000;

export function useLoadedModels(enabled = true) {
  return useQuery({
    queryKey: LOADED_KEY,
    enabled,
    staleTime: 5_000,
    queryFn: () => api.get<LoadedModelsView>('/local-models/loaded'),
    // A hidden page does not poll: nothing here is worth waking Ollama's port for.
    refetchInterval: () => (typeof document !== 'undefined' && document.hidden ? false : REFRESH_MS),
  });
}

const GB = 1024 ** 3;
/** "5.2 GB", "820 MB". */
export function sizeWords(bytes: number): string {
  if (bytes >= GB) return `${(Math.round((bytes / GB) * 10) / 10).toString()} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** "Unloads at 14:32", "Unloads in under a minute", or "Stays loaded until you unload it". */
export function unloadWords(m: Pick<LoadedModel, 'expires_at' | 'keep_loaded'>, now = Date.now()): string {
  if (m.keep_loaded || !m.expires_at) return 'Stays loaded until you unload it';
  const at = Date.parse(m.expires_at);
  if (!Number.isFinite(at)) return 'Stays loaded until you unload it';
  if (at - now < 60_000) return 'Unloads in under a minute';
  return `Unloads at ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function failed(e: unknown) {
  return e instanceof ApiCallError
    ? { title: e.body.error.title, body: e.body.error.hint }
    : { title: 'That did not work', body: 'Check that NVX Ancile and Ollama are running, then try again.' };
}

function useChange<V>(call: (v: V) => Promise<LoadedModelsView>) {
  return useMutation({
    mutationFn: call,
    onSuccess: (view) => queryClient.setQueryData(LOADED_KEY, view),
    onError: (e) => notify({ level: 'error', ...failed(e) }),
  });
}

export function LoadedNow() {
  const q = useLoadedModels();
  const unload = useChange((name: string) =>
    api.post<LoadedModelsView>('/local-models/loaded/unload', { name }),
  );
  const keep = useChange((v: { name: string; keep: boolean }) =>
    api.post<LoadedModelsView>('/local-models/loaded/keep', v),
  );
  const view = q.data;
  if (!view || !Array.isArray(view.items) || view.state === 'unreachable') return null;
  if (view.state === 'too_old')
    return (
      <p className="mute loaded__old">
        This version of Ollama cannot say which models are loaded. Update Ollama to see them here.
      </p>
    );
  if (view.items.length === 0) return null;
  const busy = unload.isPending || keep.isPending;
  const used = view.items.reduce((n, i) => n + i.size_bytes, 0);
  return (
    <section className="loaded m-raised" aria-labelledby="loaded-h">
      <header className="loaded__head">
        <h2 id="loaded-h" className="loaded__title">
          Loaded now
        </h2>
        <span className="mute">
          {sizeWords(used)} in memory
          {view.memory_bytes ? ` of ${sizeWords(view.memory_bytes)}` : ''}
        </span>
      </header>
      {view.crowded ? (
        <p className="loaded__warn" role="status">
          <Icon name="warn" size={13} /> These models use most of the memory. Loading another will make Ollama
          unload one.
        </p>
      ) : null}
      <ul className="loaded__list">
        {view.items.map((m) => (
          <li key={m.name} className="loaded__row">
            <div className="loaded__what">
              <b>{m.display_name}</b>
              <span className="mute">
                {sizeWords(m.size_bytes)}
                {m.vram_bytes >= m.size_bytes && m.size_bytes > 0 ? ' on the graphics card' : ''}
                {' · '}
                {unloadWords(m)}
              </span>
            </div>
            {m.managed ? (
              <div className="loaded__acts">
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  aria-pressed={m.keep_loaded}
                  disabled={busy}
                  onClick={() => keep.mutate({ name: m.name, keep: !m.keep_loaded })}
                >
                  {m.keep_loaded ? 'Let it unload' : 'Keep loaded'}
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy}
                  aria-label={`Unload ${m.display_name}`}
                  onClick={() => unload.mutate(m.name)}
                >
                  Unload
                </button>
              </div>
            ) : (
              <span className="mute loaded__other">Loaded by something else</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
