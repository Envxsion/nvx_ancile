/**
 * ------------------------------------------------------------------
 *  Title    |  Which provider served
 *  Ref      |  docs/openrouter.md (Which provider served)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  In Why: the OpenRouter provider (and, under Auto, the
 *           |  model) that really answered, and whether the answer
 *           |  stopped at that endpoint's output limit.
 *  How      |  Reads usage.served. "Retry on an endpoint with more
 *           |  room" saves a thread routing that avoids that provider
 *           |  and allows twice the answer length, then regenerates.
 * ------------------------------------------------------------------
 */

import type { RoutingSettings, Usage } from '@nvx/contracts';
import { useState } from 'react';
import { api } from '../lib/api';
import { keys } from '../lib/data';
import { queryClient } from '../lib/query';
import { regenerate } from '../lib/turns';
import type { ThreadView } from '../lib/types';
import { notify } from '../state/notify';
import '../styles/openrouter.css';
import { DEFAULT_ROUTING, saveRouting } from './api';

/** The routing for a retry: the same choice, minus the provider that cut it off, with room to finish. */
export function roomierRouting(
  current: RoutingSettings | null,
  provider: string | null,
  outputTokens: number,
): RoutingSettings {
  const base = current ?? DEFAULT_ROUTING;
  return {
    ...base,
    avoid: provider && !base.avoid.includes(provider) ? [...base.avoid, provider] : base.avoid,
    max_tokens: Math.max(base.max_tokens ?? 0, outputTokens * 2, 8_192),
  };
}

export function ServedBy({
  usage,
  threadId,
  messageId,
}: {
  usage: Usage | null;
  threadId: string;
  messageId: string;
}) {
  const [busy, setBusy] = useState(false);
  const served = usage?.served;
  if (!served) return null;
  const retry = async () => {
    setBusy(true);
    try {
      const cur = await api
        .get<{ settings: RoutingSettings | null }>(
          `/openrouter/routing?scope=thread&id=${encodeURIComponent(threadId)}`,
        )
        .catch(() => ({ settings: null }));
      await saveRouting(
        'thread',
        threadId,
        roomierRouting(cur.settings, served.provider, usage?.output_tokens ?? 0),
      );
      const m = queryClient
        .getQueryData<ThreadView>(keys.thread(threadId))
        ?.messages.find((x) => x.id === messageId);
      if (m) await regenerate(threadId, m);
    } catch {
      notify({
        level: 'error',
        title: 'Could not retry',
        body: 'Try again, or choose providers in the model’s Routing.',
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="or-served">
      <p>
        Served by <strong>{served.provider ?? 'an unnamed provider'}</strong> on OpenRouter
        {served.model ? (
          <>
            , model <code>{served.model}</code>
          </>
        ) : null}
        .
      </p>
      {served.cut_off ? (
        <>
          <p className="or-served__cut">Cut off by this endpoint's output limit.</p>
          <div>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              disabled={busy}
              onClick={() => void retry()}
            >
              Retry on an endpoint with more room
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
