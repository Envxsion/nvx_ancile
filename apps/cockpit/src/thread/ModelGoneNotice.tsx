/**
 * ------------------------------------------------------------------
 *  Title    |  Model gone notice
 *  Ref      |  docs/errors.md (model.gone) · thread/model-gone-store.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Above the composer when a send, edit or regenerate named
 *           |  a model that is no longer there: says which, and offers a
 *           |  model picker right there to send it again.
 *  How      |  The picker lists the chat models that can answer now,
 *           |  preset to Core's suggestion (the thread's model, else the
 *           |  default route's first). "Send with this model" calls the
 *           |  stored resend; the notice clears when it is accepted.
 * ------------------------------------------------------------------
 */

import { useState } from 'react';
import { useModels } from '../lib/data';
import { Icon } from '../ui/Icon';
import { clearModelGone, useModelGoneStore } from './model-gone-store';
import '../styles/cclive.css';

export function ModelGoneNotice({ threadId }: { threadId: string }) {
  const gone = useModelGoneStore((s) => s.byThread[threadId]);
  const models = useModels();
  const [picked, setPicked] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  if (!gone) return null;

  const ready = (models.data ?? []).filter((m) => m.chat !== false && (m.status ?? 'ready') === 'ready');
  const preset = gone.suggested && ready.some((m) => m.id === gone.suggested) ? gone.suggested : ready[0]?.id;
  const pick = picked && ready.some((m) => m.id === picked) ? picked : (preset ?? '');

  return (
    <div className="cc-notice" data-kind="model_gone" role="alert">
      <Icon name="warn" size={14} className="cc-notice__icon" />
      <div className="cc-notice__text">
        <p>
          <strong>{gone.words?.heading ?? `${gone.modelId} is no longer available.`}</strong>{' '}
          {gone.words?.body ?? 'It was removed or renamed. Pick another model to send it again.'}
        </p>
      </div>
      <div className="cc-notice__acts">
        <label className="sr-only" htmlFor={`model-gone-${threadId}`}>
          Model
        </label>
        <select
          id={`model-gone-${threadId}`}
          className="input input--sm"
          value={pick}
          onChange={(e) => setPicked(e.target.value)}
        >
          {ready.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={!pick || sending}
          onClick={() => {
            setSending(true);
            void gone
              .again(pick)
              .then((ok) => {
                if (ok) clearModelGone(threadId);
              })
              .finally(() => setSending(false));
          }}
        >
          Send with this model
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--xs"
          aria-label="Dismiss"
          onClick={() => clearModelGone(threadId)}
        >
          <Icon name="close" size={11} />
        </button>
      </div>
    </div>
  );
}
