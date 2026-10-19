/**
 * ------------------------------------------------------------------
 *  Title    |  Add more models
 *  Ref      |  ROADMAP MD2 · docs/models.md (Which models are listed)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A provider starts with three current models of
 *           |  different tiers (fast, balanced, best). This dialog
 *           |  lists the rest of what you have a key for, so you can
 *           |  show the ones you want in the model switcher.
 *  How      |  Reads the models Core marks unlisted with the reason
 *           |  "more"; Show posts /models/shown and the list refetches.
 *  Note     |  Hiding a model works the same way from Admin → Models.
 * ------------------------------------------------------------------
 */

import * as Dialog from '@radix-ui/react-dialog';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/data';
import { queryClient } from '../lib/query';
import type { ModelView } from '../lib/types';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';

/** The models a provider you have a key for keeps back from the first list. */
export const moreModels = (models: ModelView[]): ModelView[] =>
  models.filter((m) => m.unlisted && m.unlistedReason === 'more');

export function MoreModelsDialog({
  models,
  open,
  onOpenChange,
}: {
  models: ModelView[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const more = moreModels(models);
  const show = useMutation({
    mutationFn: (id: string) => api.post('/models/shown', { id, shown: true }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.models });
    },
    onError: () =>
      notify({
        level: 'error',
        title: 'That model was not added',
        body: 'Check NVX Ancile is running, then try again.',
      }),
  });
  const byProvider = new Map<string, ModelView[]>();
  for (const m of more) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog" aria-describedby="more-models-lede">
          <Dialog.Title className="dialog__title">
            <Icon name="plus" size={18} /> Add more models
          </Dialog.Title>
          <p id="more-models-lede" className="mute">
            Each provider starts with three current models: a fast one, a balanced one and the best one. These
            are the others it offers.
          </p>
          {byProvider.size === 0 ? (
            <p className="mute">Every model from your providers is already listed.</p>
          ) : (
            [...byProvider].map(([provider, list]) => (
              <section key={provider} aria-label={provider}>
                <h3 className="dialog__sub">{provider}</h3>
                <ul className="more-models">
                  {list.map((m) => (
                    <li key={m.id} className="more-models__row">
                      <span>{m.name}</span>
                      <button
                        type="button"
                        className="btn btn--sm"
                        disabled={show.isPending}
                        aria-label={`Show ${m.name}`}
                        onClick={() => show.mutate(m.id)}
                      >
                        Show
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
          <div className="dialog__actions">
            <Dialog.Close className="btn btn--primary" type="button">
              Done
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
